import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type * as NextHeaders from "next/headers";
import { prisma } from "@/lib/prisma";
import { expenseService } from "@/services/expense.service";
import { settlementService } from "@/services/settlement.service";
import { categoryService } from "@/services/category.service";
import { groupService } from "@/services/group.service";
import { authService } from "@/services/auth.service";
import { balanceService } from "@/services/balance.service";
import { shoppingItemService } from "@/services/shopping-item.service";
import { revisionService } from "@/services/revision.service";
import { recurringExpenseService } from "@/services/recurring-expense.service";
import { notificationService } from "@/services/notification.service";
import { pushService } from "@/services/push.service";
import { flushPush } from "@/lib/push/schedule";
import { addMonths } from "@/lib/recurrence";
import { allActiveGroupMembers, allGroupMembers } from "@/lib/api-helpers";
import { runWithAuditContext } from "@/lib/audit-context";
import { flushAudit, WRITE_OPS } from "@/lib/prisma-audit";
import { toCents } from "@/lib/currency";
import { signSession, SESSION_COOKIE } from "@/lib/auth";

// Spec 010: web-push never reaches the network here. Every send resolves unless a test says otherwise.
const { mockSendNotification } = vi.hoisted(() => ({ mockSendNotification: vi.fn() }));
vi.mock("web-push", () => ({ default: { sendNotification: mockSendNotification } }));

// Spec 008 (system actor): lets a test put a session cookie in "the request" the audit extension reads
// (actorFromRequest). Left unset, cookies() is the real one, which throws outside a request — as before.
const requestCookies = vi.hoisted(() => ({ session: undefined as string | undefined }));
vi.mock("next/headers", async (importOriginal) => {
  const actual = await importOriginal<typeof NextHeaders>();
  return {
    ...actual,
    cookies: async () => {
      if (requestCookies.session === undefined) return actual.cookies();
      return { get: (name: string) => (name === SESSION_COOKIE ? { value: requestCookies.session } : undefined) };
    },
  };
});

// Integration tests against a real (pglite) Postgres booted by test/global-setup.ts.
// They exercise the actual Prisma queries to prove the groupId scoping really isolates houses —
// the security boundary a unit test with mocks can't verify.

async function reset() {
  // Drain any deferred (fire-and-forget) audit writes before wiping, so a late revision from a
  // previous test can't land after the TRUNCATE and leak into the next one. Same for a push dispatch (spec 010).
  await flushPush();
  await flushAudit();
  await prisma.$executeRawUnsafe(
    `TRUNCATE "User","Group","GroupMember","Platform","Category","PaymentMethod","Expense","ExpenseParticipant","Settlement","AuditLog","EntityRevision" RESTART IDENTITY CASCADE`
  );
}

async function seedTwoHouses() {
  const mkUser = (name: string, username: string) =>
    prisma.user.create({ data: { publicId: randomUUID(), name, username } });
  const ana = await mkUser("Ana", "ana");
  const bob = await mkUser("Bob", "bob");
  const carol = await mkUser("Carol", "carol");

  const houseA = await prisma.group.create({ data: { publicId: randomUUID(), name: "House A" } });
  const houseB = await prisma.group.create({ data: { publicId: randomUUID(), name: "House B" } });

  await prisma.groupMember.createMany({
    data: [
      { userId: ana.id, groupId: houseA.id, role: "ADMIN", colorIndex: 0 },
      { userId: bob.id, groupId: houseA.id, role: "MEMBER", colorIndex: 1 },
      { userId: carol.id, groupId: houseB.id, role: "ADMIN", colorIndex: 0 },
    ],
  });

  // Expense in House A (paid by Ana, split equally with Bob).
  const expA = await expenseService.create(houseA.id, [ana.id, bob.id], {
    payerId: ana.id,
    description: "Groceries A",
    amount: 100,
    splitEqually: true,
  });

  return { ana, bob, carol, houseA, houseB, expA };
}

const listParams = { page: 1, pageSize: 100, sortField: "date", sortDirection: "desc" as const };

describe("tenant isolation (integration, real pglite DB)", () => {
  beforeEach(reset);

  it("findByPublicId is group-scoped — another house cannot resolve the expense", async () => {
    const { houseA, houseB, expA } = await seedTwoHouses();
    expect(await expenseService.findByPublicId(houseA.id, expA.publicId)).not.toBeNull();
    expect(await expenseService.findByPublicId(houseB.id, expA.publicId)).toBeNull();
  });

  it("shoppingItemService.findByPublicId is group-scoped — another house cannot resolve the item", async () => {
    const { ana, houseA, houseB } = await seedTwoHouses();
    const item = await shoppingItemService.create(houseA.id, "Weekly groceries", ana.id);
    expect(await shoppingItemService.findByPublicId(houseA.id, item.publicId)).not.toBeNull();
    expect(await shoppingItemService.findByPublicId(houseB.id, item.publicId)).toBeNull();
  });

  it("update from another house throws 404 (cannot mutate another house's expense)", async () => {
    const { ana, bob, carol, houseB, expA } = await seedTwoHouses();
    await expect(
      expenseService.update(houseB.id, expA.id, carol.id, true, [ana.id, bob.id], { description: "hacked", amount: 50 })
    ).rejects.toMatchObject({ status: 404 });
  });

  it("list only returns the active house's expenses", async () => {
    const { houseA, houseB } = await seedTwoHouses();
    const listA = await expenseService.list(houseA.id, listParams);
    const listB = await expenseService.list(houseB.id, listParams);
    expect(listA.expenses.length).toBe(1);
    expect(listB.expenses.length).toBe(0);
  });

  it("settlement delete is group-scoped (404 cross-house, deletable in-house)", async () => {
    const { ana, bob, houseA, houseB } = await seedTwoHouses();
    const s = await settlementService.create(houseA.id, { fromUserId: bob.id, toUserId: ana.id, amount: 50 });
    await expect(settlementService.delete(houseB.id, s.publicId)).rejects.toMatchObject({ status: 404 });
    await expect(settlementService.delete(houseA.id, s.publicId)).resolves.toBeTruthy();
  });

  it("equal split persisted to the DB sums exactly to the total", async () => {
    const { houseA } = await seedTwoHouses();
    const e = await prisma.expense.findFirst({
      where: { groupId: houseA.id },
      include: { participants: true },
    });
    const sumCents = e!.participants.reduce((a, p) => a + Math.round(Number(p.amount) * 100), 0);
    expect(sumCents).toBe(Math.round(Number(e!.amount) * 100));
    expect(sumCents).toBe(10000);
  });
});

describe("shopping item expense links (integration, real pglite DB)", () => {
  beforeEach(reset);

  it("replaces multiple links and can unlink all", async () => {
    const { ana, bob, houseA, expA } = await seedTwoHouses();
    const exp2 = await expenseService.create(houseA.id, [ana.id, bob.id], {
      payerId: bob.id,
      description: "Second receipt",
      amount: 25,
      splitEqually: true,
    });
    const item = await shoppingItemService.create(houseA.id, "Weekly groceries", ana.id);
    await shoppingItemService.togglePurchased(houseA.id, item.publicId);

    const { item: linked, changed } = await shoppingItemService.replaceExpenseLinks(
      houseA.id,
      item.publicId,
      [expA.publicId, exp2.publicId]
    );
    expect(changed).toBe(true);
    expect(linked.linkedExpenses.map((expense) => expense.publicId).sort()).toEqual(
      [expA.publicId, exp2.publicId].sort()
    );

    const { item: unlinked, changed: unlinkChanged } = await shoppingItemService.replaceExpenseLinks(houseA.id, item.publicId, []);
    expect(unlinkChanged).toBe(true);
    expect(unlinked.linkedExpenses).toEqual([]);
    expect(await prisma.shoppingItemExpense.count()).toBe(0);
  });

  it("rejects a foreign-house expense and preserves the existing link atomically", async () => {
    const { ana, carol, houseA, houseB, expA } = await seedTwoHouses();
    const foreignExpense = await expenseService.create(houseB.id, [carol.id], {
      payerId: carol.id,
      description: "Foreign receipt",
      amount: 90,
      splitEqually: true,
    });
    const item = await shoppingItemService.create(houseA.id, "Safe item", ana.id);
    await shoppingItemService.togglePurchased(houseA.id, item.publicId);
    await shoppingItemService.replaceExpenseLinks(houseA.id, item.publicId, [expA.publicId]);

    await expect(
      shoppingItemService.replaceExpenseLinks(houseA.id, item.publicId, [foreignExpense.publicId])
    ).rejects.toMatchObject({ status: 404, code: "EXPENSE_NOT_FOUND" });

    const after = (await shoppingItemService.list(houseA.id)).find((candidate) => candidate.publicId === item.publicId)!;
    expect(after.linkedExpenses.map((expense) => expense.publicId)).toEqual([expA.publicId]);
  });

  it("requires a purchased item before linking", async () => {
    const { ana, houseA, expA } = await seedTwoHouses();
    const item = await shoppingItemService.create(houseA.id, "Not bought yet", ana.id);
    await expect(
      shoppingItemService.replaceExpenseLinks(houseA.id, item.publicId, [expA.publicId])
    ).rejects.toMatchObject({ status: 409, code: "ITEM_NOT_PURCHASED" });
  });

  it("keeps the links of an item unchecked again editable, so they can be removed (B9)", async () => {
    const { ana, houseA, expA } = await seedTwoHouses();
    const item = await shoppingItemService.create(houseA.id, "Bought then unchecked", ana.id);
    await shoppingItemService.togglePurchased(houseA.id, item.publicId);
    await shoppingItemService.replaceExpenseLinks(houseA.id, item.publicId, [expA.publicId]);
    await shoppingItemService.togglePurchased(houseA.id, item.publicId); // back to "to buy", link kept

    const { item: unlinked } = await shoppingItemService.replaceExpenseLinks(houseA.id, item.publicId, []);
    expect(unlinked.isPurchased).toBe(false);
    expect(unlinked.linkedExpenses).toEqual([]);
  });

  it("saving the same set of links again changes nothing: changed false, no delete/create, no revision, in any order (I2)", async () => {
    const { ana, bob, houseA, expA } = await seedTwoHouses();
    const exp2 = await expenseService.create(houseA.id, [ana.id, bob.id], {
      payerId: bob.id,
      description: "Second receipt",
      amount: 25,
      splitEqually: true,
    });
    const item = await shoppingItemService.create(houseA.id, "Weekly groceries", ana.id);
    await shoppingItemService.togglePurchased(houseA.id, item.publicId, ana.id);

    const first = await shoppingItemService.replaceExpenseLinks(
      houseA.id, item.publicId, [expA.publicId, exp2.publicId], ana.id
    );
    const linkRows = () => prisma.shoppingItemExpense.findMany({ orderBy: { expenseId: "asc" } });
    const linksBefore = await linkRows();
    const again = await shoppingItemService.replaceExpenseLinks(
      houseA.id, item.publicId, [exp2.publicId, expA.publicId], ana.id
    );

    expect(first.changed).toBe(true);
    expect(again.changed).toBe(false);
    expect(again.item.linkedExpenses.map((e) => e.publicId).sort()).toEqual([expA.publicId, exp2.publicId].sort());
    // The very same join rows (same linkedAt: not deleted and re-created) and exactly one link revision.
    expect(linksBefore).toHaveLength(2);
    expect(await linkRows()).toEqual(linksBefore);
    await flushAudit();
    const revs = await prisma.entityRevision.findMany({
      where: { entityType: "ShoppingItem", entityId: String(item.id), action: "UPDATE" },
    });
    expect(revs.filter((r) => (r.after as Record<string, unknown>).linkedExpenses !== undefined)).toHaveLength(1);
  });

  it("saving no links on a never-linked purchased item changes nothing: changed false and no revision (I2)", async () => {
    const { ana, houseA } = await seedTwoHouses();
    const item = await shoppingItemService.create(houseA.id, "Milk", ana.id);
    await shoppingItemService.togglePurchased(houseA.id, item.publicId, ana.id);

    const result = await shoppingItemService.replaceExpenseLinks(houseA.id, item.publicId, [], ana.id);

    expect(result.changed).toBe(false);
    expect(result.item.linkedExpenses).toEqual([]);
    expect(result.item.publicId).toBe(item.publicId);
    await flushAudit();
    const revs = await prisma.entityRevision.findMany({
      where: { entityType: "ShoppingItem", entityId: String(item.id), action: "UPDATE" },
    });
    // Only the purchase toggle's revision exists — no 0 → 0 link revision.
    expect(revs.filter((r) => (r.after as Record<string, unknown>).linkedExpenses !== undefined)).toHaveLength(0);
  });

  it("cascades only join rows when either parent is deleted", async () => {
    const { ana, bob, houseA, expA } = await seedTwoHouses();
    const item = await shoppingItemService.create(houseA.id, "Cascade item", ana.id);
    await shoppingItemService.togglePurchased(houseA.id, item.publicId);
    await shoppingItemService.replaceExpenseLinks(houseA.id, item.publicId, [expA.publicId]);

    await expenseService.delete(houseA.id, expA.id, ana.id, true);
    expect(await prisma.shoppingItemExpense.count()).toBe(0);
    expect(await prisma.shoppingItem.count({ where: { id: item.id } })).toBe(1);

    const exp2 = await expenseService.create(houseA.id, [ana.id, bob.id], {
      payerId: ana.id,
      description: "Kept expense",
      amount: 12,
      splitEqually: true,
    });
    await shoppingItemService.replaceExpenseLinks(houseA.id, item.publicId, [exp2.publicId]);
    await shoppingItemService.delete(houseA.id, item.publicId);
    expect(await prisma.shoppingItemExpense.count()).toBe(0);
    expect(await prisma.expense.count({ where: { id: exp2.id } })).toBe(1);
  });

  it("togglePurchased writes an UPDATE revision with before/after despite the atomic raw update (Deferred 1)", async () => {
    const { ana, houseA } = await seedTwoHouses();
    const item = await shoppingItemService.create(houseA.id, "Milk", ana.id);
    await shoppingItemService.togglePurchased(houseA.id, item.publicId, ana.id);
    await flushAudit();

    const revs = await prisma.entityRevision.findMany({
      where: { entityType: "ShoppingItem", entityId: String(item.id), action: "UPDATE" },
    });
    expect(revs).toHaveLength(1);
    expect(revs[0].groupId).toBe(houseA.id);
    expect(revs[0].actorId).toBe(ana.id);
    expect((revs[0].before as Record<string, unknown>).isPurchased).toBe(false);
    expect((revs[0].after as Record<string, unknown>).isPurchased).toBe(true);

    const feed = await revisionService.listForGroup(houseA.id, { entityType: "ShoppingItem" });
    expect(feed.some((r) => r.action === "UPDATE" && r.after?.isPurchased === true)).toBe(true);
  });

  it("togglePurchased: an item deleted between the lookup and the raw UPDATE is a 404, not a TypeError", async () => {
    const { ana, houseA } = await seedTwoHouses();
    const item = await shoppingItemService.create(houseA.id, "Vanishing item", ana.id);
    const owned = await prisma.shoppingItem.findFirstOrThrow({ where: { id: item.id } });
    await prisma.shoppingItem.delete({ where: { id: item.id } }); // gone before the UPDATE runs
    const lookup = vi
      .spyOn(shoppingItemService as unknown as { findOwned: () => Promise<typeof owned> }, "findOwned")
      .mockResolvedValueOnce(owned); // the lookup still "saw" the item
    try {
      await expect(shoppingItemService.togglePurchased(houseA.id, item.publicId, ana.id)).rejects.toMatchObject({
        status: 404,
      });
    } finally {
      lookup.mockRestore();
    }
  });

  it("togglePurchased: a failing revision insert is best-effort — the toggle still returns the flipped item", async () => {
    const { ana, houseA } = await seedTwoHouses();
    const item = await shoppingItemService.create(houseA.id, "Eggs", ana.id);
    // Swap the delegate method by hand: vi's mockRestore() leaves Prisma's model proxy without `create`.
    const revisions = prisma.entityRevision as unknown as { create: unknown };
    const originalCreate = revisions.create;
    const revisionInsert = vi.fn().mockRejectedValueOnce(new Error("audit down"));
    revisions.create = revisionInsert;
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const toggled = await shoppingItemService.togglePurchased(houseA.id, item.publicId, ana.id);
      expect(revisionInsert).toHaveBeenCalledTimes(1);
      expect(toggled.isPurchased).toBe(true);
      // The logger (spec 007) writes one JSON line: msg + entityType + the serialized error.
      expect(logged).toHaveBeenCalledTimes(1);
      expect(JSON.parse(logged.mock.calls[0][0] as string)).toMatchObject({
        level: "error",
        msg: "audit revision failed",
        entityType: "ShoppingItem",
        error: { message: "audit down" },
      });
      const stored = await prisma.shoppingItem.findFirstOrThrow({ where: { id: item.id } });
      expect(stored.isPurchased).toBe(true); // the write itself committed
    } finally {
      revisions.create = originalCreate;
      logged.mockRestore();
    }
  });

  it("replaceExpenseLinks records the linked-expense count before/after on the item (R2-03)", async () => {
    const { ana, houseA, expA } = await seedTwoHouses();
    const item = await shoppingItemService.create(houseA.id, "Detergent", ana.id);
    await shoppingItemService.togglePurchased(houseA.id, item.publicId, ana.id);
    await shoppingItemService.replaceExpenseLinks(houseA.id, item.publicId, [expA.publicId], ana.id);
    await shoppingItemService.replaceExpenseLinks(houseA.id, item.publicId, [], ana.id);
    await flushAudit();

    const revs = await prisma.entityRevision.findMany({
      where: { entityType: "ShoppingItem", entityId: String(item.id), action: "UPDATE" },
      orderBy: { id: "asc" },
    });
    const links = revs.filter((r) => (r.after as Record<string, unknown>).linkedExpenses !== undefined);
    expect(
      links.map((r) => [
        (r.before as Record<string, unknown>).linkedExpenses,
        (r.after as Record<string, unknown>).linkedExpenses,
      ])
    ).toEqual([[0, 1], [1, 0]]);
    expect(links.every((r) => r.actorId === ana.id && r.groupId === houseA.id)).toBe(true);
    expect((links[0].after as Record<string, unknown>).name).toBe("Detergent");

    const feed = await revisionService.listForGroup(houseA.id, { entityType: "ShoppingItem" });
    const linkFeed = feed.filter((r) => r.after?.linkedExpenses !== undefined);
    expect(linkFeed).toHaveLength(2);
    // The feed's derived-before fill never replaces an explicit before: the first link revision
    // keeps its own `linkedExpenses: 0` instead of borrowing the purchase toggle's snapshot (M6).
    const [firstLink, secondLink] = [...linkFeed].sort((a, b) => a.id - b.id);
    expect(firstLink.before?.linkedExpenses).toBe(0);
    expect(secondLink.before?.linkedExpenses).toBe(1);
  });
});

describe("balance aggregation (integration, real pglite DB)", () => {
  beforeEach(reset);

  const byName = (balances: Awaited<ReturnType<typeof balanceService.aggregate>>) =>
    Object.fromEntries(balances.map((balance) => [balance.userName, balance.balance]));

  async function createExpense(
    groupId: number,
    payerId: number,
    amount: string,
    shares: Array<{ userId: number; amount: string }>
  ) {
    return prisma.expense.create({
      data: {
        publicId: randomUUID(),
        groupId,
        payerId,
        description: "Balance integration fixture",
        amount,
        participants: { create: shares },
      },
    });
  }

  it("uses PostgreSQL grouped sums and preserves uneven cents exactly", async () => {
    const [ana, bob, carol] = await Promise.all([
      prisma.user.create({ data: { publicId: randomUUID(), name: "Ana", username: "balance-ana" } }),
      prisma.user.create({ data: { publicId: randomUUID(), name: "Bob", username: "balance-bob" } }),
      prisma.user.create({ data: { publicId: randomUUID(), name: "Carol", username: "balance-carol" } }),
    ]);
    const house = await prisma.group.create({ data: { publicId: randomUUID(), name: "Balance House" } });
    await createExpense(house.id, carol.id, "100.00", [
      { userId: ana.id, amount: "33.34" },
      { userId: bob.id, amount: "33.33" },
      { userId: carol.id, amount: "33.33" },
    ]);

    const balances = await balanceService.aggregate(house.id);

    expect(byName(balances)).toEqual({ Carol: 66.67, Bob: -33.33, Ana: -33.34 });
    expect(balances.reduce((sum, balance) => sum + toCents(balance.balance), 0)).toBe(0);
  });

  it("sums repeated float-hostile decimal amounts without drift", async () => {
    const [ana, bob] = await Promise.all([
      prisma.user.create({ data: { publicId: randomUUID(), name: "Ana", username: "repeat-ana" } }),
      prisma.user.create({ data: { publicId: randomUUID(), name: "Bob", username: "repeat-bob" } }),
    ]);
    const house = await prisma.group.create({ data: { publicId: randomUUID(), name: "Repeat House" } });
    for (let index = 0; index < 30; index += 1) {
      await createExpense(house.id, ana.id, "0.10", [
        { userId: ana.id, amount: "0.05" },
        { userId: bob.id, amount: "0.05" },
      ]);
    }

    expect(byName(await balanceService.aggregate(house.id))).toEqual({ Ana: 1.5, Bob: -1.5 });
  });

  it("isolates every credit and debit to the requested group", async () => {
    const { carol, houseA, houseB } = await seedTwoHouses();
    await createExpense(houseB.id, carol.id, "900.00", [
      { userId: carol.id, amount: "900.00" },
    ]);

    expect(byName(await balanceService.aggregate(houseA.id))).toEqual({ Ana: 50, Bob: -50 });
    expect(byName(await balanceService.aggregate(houseB.id))).toEqual({ Carol: 0 });
  });

  it("returns no balances for a group without expenses", async () => {
    const house = await prisma.group.create({ data: { publicId: randomUUID(), name: "Empty Balance House" } });
    expect(await balanceService.aggregate(house.id)).toEqual([]);
  });
});

// In the SAME file as tenant-isolation (not a separate one) on purpose: the integration tests
// share a single-connection pglite socket, so they must run in one worker (serialized) — two
// integration files would race on that connection.
describe("CSV import (integration, real pglite DB)", () => {
  beforeEach(reset);

  async function seedHouse() {
    const ana = await prisma.user.create({ data: { publicId: randomUUID(), name: "Ana", username: "ana-imp" } });
    const bob = await prisma.user.create({ data: { publicId: randomUUID(), name: "Bob", username: "bob-imp" } });
    const house = await prisma.group.create({ data: { publicId: randomUUID(), name: "House" } });
    await prisma.groupMember.createMany({
      data: [
        { userId: ana.id, groupId: house.id, role: "ADMIN", colorIndex: 0 },
        { userId: bob.id, groupId: house.id, role: "MEMBER", colorIndex: 1 },
      ],
    });
    return { ana, bob, house };
  }

  it("bulk-imports every row with participants that sum exactly to each total", async () => {
    const { ana, bob, house } = await seedHouse();
    const csv = [
      "data,descricao,valor,observacao",
      "2026-01-05,Mercado,100.00,semana",
      "2026-01-06,Luz,90.00,",
      "2026-01-07,Pizza,33.33,sexta", // odd cents — proves largest-remainder split persists
    ].join("\n");

    const result = await expenseService.importFromCSV(house.id, [ana.id, bob.id], csv, ana.id, null, true);
    expect(result.created.length).toBe(3);

    const expenses = await prisma.expense.findMany({
      where: { groupId: house.id },
      include: { participants: true },
    });
    expect(expenses.length).toBe(3);
    for (const e of expenses) {
      expect(e.participants.length).toBe(2); // split equally between the 2 members
      const sum = e.participants.reduce((a, p) => a + Math.round(Number(p.amount) * 100), 0);
      expect(sum).toBe(Math.round(Number(e.amount) * 100)); // no cent lost in the batch write
    }
    const pizza = expenses.find((e) => e.description === "Pizza")!;
    const cents = pizza.participants.map((p) => Math.round(Number(p.amount) * 100)).sort((a, b) => b - a);
    expect(cents).toEqual([1667, 1666]); // 33.33 / 2 → 16.67 + 16.66
  });

  it("rolls back the whole import when no row is valid (nothing persisted)", async () => {
    const { ana, bob, house } = await seedHouse();
    const csv = "data,descricao,valor\n2026-01-05,,100.00"; // empty description → invalid
    await expect(
      expenseService.importFromCSV(house.id, [ana.id, bob.id], csv, ana.id, null, true)
    ).rejects.toMatchObject({ status: 400, code: "CSV_NO_VALID_ROWS" });
    expect(await prisma.expense.count({ where: { groupId: house.id } })).toBe(0);
  });

  it("stores a dateless row on the importer's local day (defaultDate) at local noon, and dated rows untouched", async () => {
    const { ana, bob, house } = await seedHouse();
    const csv = ["data,descricao,valor", ",Padaria,12.50", "2026-01-05,Mercado,100.00"].join("\n");

    await expenseService.importFromCSV(house.id, [ana.id, bob.id], csv, ana.id, null, true, "2031-03-09");

    const expenses = await prisma.expense.findMany({ where: { groupId: house.id } });
    const dateOf = (description: string) => expenses.find((e) => e.description === description)!.date;
    // A date far from the real clock, so the assertion cannot pass by accident via the UTC default.
    expect(dateOf("Padaria")).toEqual(new Date("2031-03-09T12:00:00")); // same T12:00:00 convention as validateExpenseInput
    expect(dateOf("Mercado")).toEqual(new Date("2026-01-05T12:00:00"));
  });
});

// Envers-style audit trail. Exercises the Prisma audit extension via DIRECT single-row ops (no
// interactive $transaction) so the before-read + revision-write each take the single pglite
// connection sequentially — the tx-wrapped service paths work in prod (pool>1) but would deadlock
// on the single-connection test socket, so they are intentionally not exercised here.
describe("audit trail / EntityRevision (integration, real pglite DB)", () => {
  beforeEach(reset);

  async function seedUserGroup() {
    const u = await prisma.user.create({ data: { publicId: randomUUID(), name: "Zoe", username: "zoe-aud" } });
    const g = await prisma.group.create({ data: { publicId: randomUUID(), name: "Aud House" } });
    return { u, g };
  }

  function newExpense(groupId: number, payerId: number, description: string, amount: number) {
    return prisma.expense.create({
      data: {
        publicId: randomUUID(), groupId, payerId, description, amount,
        participants: { create: [{ userId: payerId, amount }] },
      },
      include: { participants: true },
    });
  }

  it("CREATE: records actor + groupId + full after-snapshot (incl. nested participants)", async () => {
    const { u, g } = await seedUserGroup();
    const exp = await runWithAuditContext({ actorId: u.id, groupId: g.id }, async () =>
      await newExpense(g.id, u.id, "Coffee", 10)
    );
    await flushAudit();
    const revs = await prisma.entityRevision.findMany({
      where: { entityType: "Expense", entityId: String(exp.id) },
    });
    expect(revs.length).toBe(1);
    const r = revs[0];
    expect(r.action).toBe("CREATE");
    expect(r.actorId).toBe(u.id);
    expect(r.groupId).toBe(g.id);
    const after = r.after as Record<string, unknown>;
    expect(after.description).toBe("Coffee");
    // nested participants are captured inside the parent snapshot
    expect(Array.isArray(after.participants)).toBe(true);
    expect((after.participants as unknown[]).length).toBe(1);
  });

  it("UPDATE: records the new after-snapshot; the prior CREATE holds the old value (history chain)", async () => {
    const { u, g } = await seedUserGroup();
    const exp = await newExpense(g.id, u.id, "Coffee", 10);
    await runWithAuditContext({ actorId: u.id, groupId: g.id }, async () =>
      await prisma.expense.update({ where: { id: exp.id }, data: { description: "Tea" } })
    );
    await flushAudit();
    const upd = await prisma.entityRevision.findFirst({
      where: { entityType: "Expense", entityId: String(exp.id), action: "UPDATE" },
    });
    expect(upd).not.toBeNull();
    expect((upd!.after as Record<string, unknown>).description).toBe("Tea");
    expect(upd!.actorId).toBe(u.id);
    // the "before" of the update = the previous revision's "after"
    const create = await prisma.entityRevision.findFirst({
      where: { entityType: "Expense", entityId: String(exp.id), action: "CREATE" },
    });
    expect((create!.after as Record<string, unknown>).description).toBe("Coffee");
  });

  it("DELETE: records the removed row's final state", async () => {
    const { u, g } = await seedUserGroup();
    const exp = await newExpense(g.id, u.id, "Coffee", 10);
    await runWithAuditContext({ actorId: u.id, groupId: g.id }, async () =>
      await prisma.expense.delete({ where: { id: exp.id } })
    );
    await flushAudit();
    const r = await prisma.entityRevision.findFirst({
      where: { entityType: "Expense", entityId: String(exp.id), action: "DELETE" },
    });
    expect(r).not.toBeNull();
    expect((r!.before as Record<string, unknown>).description).toBe("Coffee");
    expect(r!.after).toBeNull();
  });

  it("never copies a sensitive field (User.password) into the snapshot", async () => {
    const u = await prisma.user.create({
      data: { publicId: randomUUID(), name: "Secret", username: "secret-aud", password: "hashed-secret" },
    });
    await flushAudit();
    const r = await prisma.entityRevision.findFirst({
      where: { entityType: "User", entityId: String(u.id), action: "CREATE" },
    });
    expect(r).not.toBeNull();
    expect((r!.after as Record<string, unknown>).password).toBeUndefined();
    expect((r!.after as Record<string, unknown>).username).toBe("secret-aud");
  });

  it("actor is null when there is no audit context, but groupId is still derived from the row", async () => {
    const { u, g } = await seedUserGroup();
    const exp = await newExpense(g.id, u.id, "No context", 5); // no runWithAuditContext
    await flushAudit();
    const r = await prisma.entityRevision.findFirst({
      where: { entityType: "Expense", entityId: String(exp.id) },
    });
    expect(r).not.toBeNull();
    expect(r!.actorId).toBeNull();
    expect(r!.groupId).toBe(g.id);
  });

  it("a Group revision is scoped to the house itself and never stores the join code (Deferred 2)", async () => {
    const g = await prisma.group.create({ data: { publicId: randomUUID(), name: "Scoped", joinCode: "ABC123" } });
    await prisma.group.update({ where: { id: g.id }, data: { currency: "USD" } }); // no audit context
    await flushAudit();

    const revs = await prisma.entityRevision.findMany({ where: { entityType: "Group", entityId: String(g.id) } });
    expect(revs.map((r) => r.action).sort()).toEqual(["CREATE", "UPDATE"]);
    for (const r of revs) {
      expect(r.groupId).toBe(g.id);
      expect((r.after as Record<string, unknown>).joinCode).toBeUndefined();
    }
    const feed = await revisionService.listForGroup(g.id, { entityType: "Group" });
    expect(feed.map((r) => r.action).sort()).toEqual(["CREATE", "UPDATE"]);
  });

  it("updateCurrency: re-picking the active currency writes no Group revision and reports changed false; a real change writes exactly one (R2-08)", async () => {
    const g = await prisma.group.create({ data: { publicId: randomUUID(), name: "Currency House" } }); // starts in BRL
    await flushAudit(); // the house's own CREATE revision lands first
    const groupUpdates = () => prisma.entityRevision.count({ where: { entityType: "Group", entityId: String(g.id), action: "UPDATE" } });

    const noop = await groupService.updateCurrency(g.id, "BRL");
    await flushAudit();
    expect(noop).toMatchObject({ previousCurrency: "BRL", changed: false });
    expect(await groupUpdates()).toBe(0);

    const real = await groupService.updateCurrency(g.id, "USD");
    await flushAudit();
    expect(real).toMatchObject({ previousCurrency: "BRL", changed: true });
    expect((await prisma.group.findUniqueOrThrow({ where: { id: g.id } })).currency).toBe("USD");
    expect(await groupUpdates()).toBe(1);

    const again = await groupService.updateCurrency(g.id, "USD");
    await flushAudit();
    expect(again).toMatchObject({ previousCurrency: "USD", changed: false });
    expect(await groupUpdates()).toBe(1);
  });

  it("a Group revision never leaks into another house's feed", async () => {
    const a = await prisma.group.create({ data: { publicId: randomUUID(), name: "House A", joinCode: "AAA111" } });
    const b = await prisma.group.create({ data: { publicId: randomUUID(), name: "House B", joinCode: "BBB222" } });
    await prisma.group.update({ where: { id: a.id }, data: { currency: "EUR" } });
    await flushAudit();

    const feedA = await revisionService.listForGroup(a.id, { entityType: "Group" });
    const feedB = await revisionService.listForGroup(b.id, { entityType: "Group" });
    expect(feedA.every((r) => r.entityId === String(a.id))).toBe(true);
    expect(feedB.every((r) => r.entityId === String(b.id))).toBe(true);
    expect(feedA.map((r) => r.action).sort()).toEqual(["CREATE", "UPDATE"]);
    expect(feedB.map((r) => r.action)).toEqual(["CREATE"]);
    // Neither feed — nor any stored snapshot — exposes either house's join code.
    expect(JSON.stringify([feedA, feedB])).not.toMatch(/AAA111|BBB222/);
  });

  it("read-side redaction: a legacy revision that still stores joinCode never returns it, on any read path or depth", async () => {
    const g = await prisma.group.create({ data: { publicId: randomUUID(), name: "Legacy House" } });
    // Written before the audit fix: the snapshot (and a nested object) carries the join code.
    await prisma.entityRevision.create({
      data: {
        entityType: "Group",
        entityId: String(g.id),
        groupId: g.id,
        action: "UPDATE",
        before: { id: g.id, name: "Legacy House", joinCode: "LEGACY-BEFORE" },
        after: { id: g.id, name: "Renamed House", joinCode: "LEGACY-AFTER", nested: [{ joinCode: "LEGACY-DEEP", kept: 1 }] },
      },
    });
    await flushAudit();

    const byEntity = await revisionService.listForEntity(g.id, "Group", String(g.id));
    const feed = await revisionService.listForGroup(g.id, { entityType: "Group" });

    for (const records of [byEntity, feed]) {
      const legacy = records.find((r) => r.after?.name === "Renamed House");
      expect(legacy).toBeDefined(); // the row is still returned, only the secret is stripped
      expect(legacy!.before).toEqual({ id: g.id, name: "Legacy House" });
      expect(legacy!.after).toEqual({ id: g.id, name: "Renamed House", nested: [{ kept: 1 }] });
      expect(JSON.stringify(records)).not.toMatch(/LEGACY-/);
    }
  });

  it("listForGroup fills an UPDATE's missing before from the previous revision of the same entity (R2-09)", async () => {
    const g = await prisma.group.create({ data: { publicId: randomUUID(), name: "Chain House" } });
    await prisma.group.update({ where: { id: g.id }, data: { currency: "USD" } });
    await prisma.group.update({ where: { id: g.id }, data: { currency: "EUR" } });
    const item = await prisma.shoppingItem.create({ data: { publicId: randomUUID(), groupId: g.id, name: "Milk" } });
    await prisma.shoppingItem.update({ where: { id: item.id }, data: { name: "Oat milk" } });
    await flushAudit();

    const house = await revisionService.listForGroup(g.id, { entityType: "Group" });
    // Newest first (sorted by id: two updates can share a createdAt): EUR (was USD), then USD (was
    // BRL); the CREATE has nothing before it.
    const houseUpdates = house.filter((r) => r.action === "UPDATE").sort((a, b) => b.id - a.id);
    expect(houseUpdates.map((r) => [r.before?.currency, r.after?.currency]))
      .toEqual([["USD", "EUR"], ["BRL", "USD"]]);
    expect(house.find((r) => r.action === "CREATE")?.before).toBeNull();

    const items = await revisionService.listForGroup(g.id, { entityType: "ShoppingItem" });
    const rename = items.find((r) => r.action === "UPDATE");
    expect(rename?.before?.name).toBe("Milk");
    expect(rename?.after?.name).toBe("Oat milk");
  });

  it("the borrowed before stays in the same house and is redacted like any snapshot (R2-09)", async () => {
    const a = await prisma.group.create({ data: { publicId: randomUUID(), name: "House A" } });
    const b = await prisma.group.create({ data: { publicId: randomUUID(), name: "House B" } });
    await flushAudit(); // the groups' own CREATE revisions land first, so the manual rows below come after them
    // This house's previous snapshot is a legacy row that still stores the join code: borrowed, but redacted.
    await prisma.entityRevision.create({
      data: { entityType: "Group", entityId: String(a.id), groupId: a.id, action: "CREATE", after: { name: "Legacy", joinCode: "LEGACY-BORROWED" } },
    });
    // Another house holds a NEWER revision with the very same entity key (type + id): never borrowed.
    await prisma.entityRevision.create({
      data: { entityType: "Group", entityId: String(a.id), groupId: b.id, action: "CREATE", after: { name: "FOREIGN", currency: "JPY" } },
    });
    await prisma.entityRevision.create({
      data: { entityType: "Group", entityId: String(a.id), groupId: a.id, action: "UPDATE", after: { name: "Renamed" } },
    });
    await flushAudit();

    const feed = await revisionService.listForGroup(a.id, { entityType: "Group" });
    const update = feed.find((r) => r.after?.name === "Renamed");
    expect(update?.before).toEqual({ name: "Legacy" });
    expect(JSON.stringify(feed)).not.toMatch(/FOREIGN|JPY|LEGACY-BORROWED/);
  });

  it("a join-code regeneration records only a joinCodeChanged marker, never the code (R3-19)", async () => {
    const g = await prisma.group.create({ data: { publicId: randomUUID(), name: "Code House", joinCode: "OLD111" } });
    const fresh = await groupService.regenerateJoinCode(g.id);
    await prisma.group.update({ where: { id: g.id }, data: { currency: "USD" } });
    await flushAudit();

    const feed = await revisionService.listForGroup(g.id, { entityType: "Group" });
    const updates = feed.filter((r) => r.action === "UPDATE").sort((a, b) => a.id - b.id);
    expect(updates).toHaveLength(2);
    expect(updates[0].after?.joinCodeChanged).toBe(true);
    expect(updates[0].after).not.toHaveProperty("joinCode");
    expect(updates[1].after?.joinCodeChanged).toBeUndefined(); // a currency change carries no marker
    const stored = await prisma.entityRevision.findMany({ where: { entityType: "Group", entityId: String(g.id) } });
    expect(JSON.stringify([feed, stored])).not.toContain(fresh);
    expect(JSON.stringify([feed, stored])).not.toContain("OLD111");
  });

  it("a password change records passwordChanged, never the hash (R3-19)", async () => {
    const u = await prisma.user.create({
      data: { publicId: randomUUID(), name: "Pat", username: "pat-marker", password: "hash-before" },
    });
    await prisma.user.update({ where: { id: u.id }, data: { password: "hash-after" } });
    await flushAudit();

    const stored = await prisma.entityRevision.findMany({
      where: { entityType: "User", entityId: String(u.id) },
      orderBy: { id: "asc" },
    });
    const update = stored.find((r) => r.action === "UPDATE");
    expect((update!.after as Record<string, unknown>).passwordChanged).toBe(true);
    expect(update!.after).not.toHaveProperty("password");
    expect(JSON.stringify(stored)).not.toMatch(/hash-before|hash-after/);
  });

  it("a sensitive key left undefined (Prisma ignores it) writes no marker (R3-19)", async () => {
    const g = await prisma.group.create({ data: { publicId: randomUUID(), name: "Undefined House", joinCode: "KEEP11" } });
    await prisma.group.update({ where: { id: g.id }, data: { joinCode: undefined, currency: "EUR" } });
    await flushAudit();

    const update = await prisma.entityRevision.findFirst({
      where: { entityType: "Group", entityId: String(g.id), action: "UPDATE" },
    });
    expect(update).not.toBeNull();
    expect(update!.after).not.toHaveProperty("joinCodeChanged");
    expect((await prisma.group.findUniqueOrThrow({ where: { id: g.id } })).joinCode).toBe("KEEP11"); // really untouched
  });
});

// Spec 009 final review: createManyAndReturn / updateManyAndReturn were missing from WRITE_OPS, so these writes left
// no revision at all on an audited model. They hand back every written row, so each row gets its own revision.
describe("audit trail: bulk writes that return their rows (spec 009 final review, integration, real pglite DB)", () => {
  beforeEach(reset);

  async function seedUserGroup() {
    const u = await prisma.user.create({ data: { publicId: randomUUID(), name: "Zoe", username: "zoe-bulk" } });
    const g = await prisma.group.create({ data: { publicId: randomUUID(), name: "Bulk House" } });
    const other = await prisma.group.create({ data: { publicId: randomUUID(), name: "Other House" } });
    await flushAudit(); // the setup's own revisions land first
    return { u, g, other };
  }

  const revisionsOf = (entityType: string) =>
    prisma.entityRevision.findMany({ where: { entityType }, orderBy: { id: "asc" } });

  it("createManyAndReturn records one CREATE revision per returned row: its id, house, actor and snapshot", async () => {
    const { u, g } = await seedUserGroup();

    const rows = await runWithAuditContext({ actorId: u.id, groupId: g.id }, async () =>
      await prisma.category.createManyAndReturn({
        data: [
          { publicId: randomUUID(), groupId: g.id, name: "Pets" },
          { publicId: randomUUID(), groupId: g.id, name: "Garden" },
        ],
      })
    );
    await flushAudit();

    const revs = await revisionsOf("Category");
    const byId = (a: { entityId: string }, b: { entityId: string }) => Number(a.entityId) - Number(b.entityId);
    expect(revs.sort(byId).map((r) => [r.action, r.entityId, r.groupId, r.actorId])).toEqual(
      [...rows].sort((a, b) => a.id - b.id).map((row) => ["CREATE", String(row.id), g.id, u.id])
    );
    expect(revs.map((r) => (r.after as Record<string, unknown>).name).sort()).toEqual(["Garden", "Pets"]);
    expect(revs.every((r) => r.before === null)).toBe(true);
  });

  it("updateManyAndReturn records one UPDATE revision per returned row, and Detailed derives each before from that row's history (ADR 0009)", async () => {
    const { u, g, other } = await seedUserGroup();
    const milk = await prisma.shoppingItem.create({ data: { publicId: randomUUID(), groupId: g.id, name: "Milk" } });
    const eggs = await prisma.shoppingItem.create({ data: { publicId: randomUUID(), groupId: g.id, name: "Eggs" } });
    const elsewhere = await prisma.shoppingItem.create({ data: { publicId: randomUUID(), groupId: other.id, name: "Bread" } });
    await flushAudit();

    const updated = await runWithAuditContext({ actorId: u.id, groupId: g.id }, async () =>
      await prisma.shoppingItem.updateManyAndReturn({ where: { groupId: g.id }, data: { isPurchased: true } })
    );
    await flushAudit();

    expect(updated.map((row) => row.id).sort()).toEqual([milk.id, eggs.id].sort());
    const updates = (await revisionsOf("ShoppingItem")).filter((r) => r.action === "UPDATE");
    expect(updates.map((r) => [r.entityId, r.groupId, r.actorId]).sort()).toEqual(
      [[String(milk.id), g.id, u.id], [String(eggs.id), g.id, u.id]].sort()
    );
    expect(updates.every((r) => (r.after as Record<string, unknown>).isPurchased === true)).toBe(true);
    expect(updates.every((r) => r.before === null)).toBe(true); // like a single-row update: after only
    expect(updates.some((r) => r.entityId === String(elsewhere.id))).toBe(false);

    const feed = await revisionService.listForGroup(g.id, { entityType: "ShoppingItem" });
    const purchases = feed.filter((r) => r.action === "UPDATE");
    expect(purchases).toHaveLength(2);
    for (const r of purchases) {
      expect(r.before?.isPurchased).toBe(false);
      expect(r.after?.isPurchased).toBe(true);
    }
  });

  it("a sensitive field set through updateManyAndReturn records its change marker, never the value (R3-19)", async () => {
    const { g } = await seedUserGroup();
    await prisma.group.updateManyAndReturn({ where: { id: g.id }, data: { joinCode: "SECRET9" } });
    await flushAudit();

    const update = (await revisionsOf("Group")).find((r) => r.action === "UPDATE" && r.entityId === String(g.id));
    expect(update).toBeDefined();
    expect(update!.groupId).toBe(g.id);
    expect((update!.after as Record<string, unknown>).joinCodeChanged).toBe(true);
    expect(JSON.stringify(update)).not.toContain("SECRET9");
  });

  it("returned rows without an id (a select that leaves it out) fall back to one bulk:N marker", async () => {
    const { u, g } = await seedUserGroup();

    await runWithAuditContext({ actorId: u.id, groupId: g.id }, async () => {
      await prisma.category.createManyAndReturn({
        data: [
          { publicId: randomUUID(), groupId: g.id, name: "Kids" },
          { publicId: randomUUID(), groupId: g.id, name: "Car" },
        ],
        select: { name: true },
      });
      await prisma.category.updateManyAndReturn({ where: { groupId: g.id, name: "Car" }, data: { name: "Vehicle" }, select: { name: true } });
    });
    await flushAudit();

    const revs = await revisionsOf("Category");
    expect(revs.map((r) => [r.action, r.entityId, r.groupId, r.actorId])).toEqual([
      ["CREATE", "bulk:2", g.id, u.id],
      ["UPDATE", "bulk:1", g.id, u.id],
    ]);
  });

  it("an *AndReturn write that touches no row records nothing", async () => {
    const { g } = await seedUserGroup();
    await prisma.shoppingItem.updateManyAndReturn({ where: { groupId: g.id }, data: { isPurchased: true } });
    await prisma.category.createManyAndReturn({ data: [] });
    await flushAudit();

    expect(await prisma.entityRevision.count({ where: { entityType: { in: ["ShoppingItem", "Category"] } } })).toBe(0);
  });

  it("SKIP_MODELS still record nothing: Notification and RecurringExpenseOccurrence *AndReturn writes", async () => {
    const { ana, bob, houseA } = await seedTwoHouses();
    const rule = await prisma.recurringExpense.create({
      data: {
        publicId: randomUUID(), groupId: houseA.id, createdById: ana.id, payerId: ana.id, description: "Rent",
        amount: 1800, dayOfMonth: 5, timezone: "America/Sao_Paulo", activeFrom: new Date("2026-10-01T00:00:00Z"),
      },
    });
    await flushAudit();
    const before = await prisma.entityRevision.count();

    await runWithAuditContext({ actorId: ana.id, groupId: houseA.id }, async () => {
      await prisma.notification.createManyAndReturn({
        data: [{ publicId: randomUUID(), userId: bob.id, groupId: houseA.id, type: "EXPENSE_NEW", actorId: ana.id, params: { amount: "1.00" } }],
      });
      await prisma.notification.updateManyAndReturn({ where: { userId: bob.id }, data: { readAt: new Date() } });
      await prisma.recurringExpenseOccurrence.createManyAndReturn({
        data: [{ recurringExpenseId: rule.id, period: "2026-10", dueOn: new Date("2026-10-05T00:00:00Z"), status: "SKIPPED" }],
      });
      await prisma.recurringExpenseOccurrence.updateManyAndReturn({ where: { recurringExpenseId: rule.id }, data: { status: "SKIPPED" } });
    });
    await flushAudit();

    expect(await prisma.entityRevision.count({
      where: { entityType: { in: ["Notification", "RecurringExpenseOccurrence"] } },
    })).toBe(0);
    expect(await prisma.entityRevision.count()).toBe(before);
  });
});

describe("system actor for scheduled writes (spec 008, integration, real pglite DB)", () => {
  beforeEach(reset);
  afterEach(() => {
    requestCookies.session = undefined;
  });

  async function seedRule() {
    const seeded = await seedTwoHouses();
    const rule = await prisma.recurringExpense.create({
      data: {
        publicId: randomUUID(),
        groupId: seeded.houseA.id,
        createdById: seeded.ana.id,
        payerId: seeded.ana.id,
        description: "Rent",
        amount: 1800,
        dayOfMonth: 5,
        timezone: "America/Sao_Paulo",
        activeFrom: new Date("2026-10-01T00:00:00Z"),
      },
    });
    return { ...seeded, rule };
  }

  const signIn = (user: { id: number; publicId: string; name: string }) =>
    signSession({ userId: user.id, publicId: user.publicId, name: user.name, sessionVersion: 0 });

  const newExpense = (groupId: number, payerId: number, description: string) =>
    prisma.expense.create({
      data: { publicId: randomUUID(), groupId, payerId, description, amount: 10, participants: { create: [{ userId: payerId, amount: 10 }] } },
    });

  const revisionOf = (entityType: string, entityId: number) =>
    prisma.entityRevision.findFirstOrThrow({ where: { entityType, entityId: String(entityId), action: "CREATE" } });

  it("a write inside runWithAuditContext({ system: true }) records actorId null even with a session cookie present (criterion 13)", async () => {
    const { ana, houseA } = await seedRule();
    requestCookies.session = await signIn(ana);

    // Control: in the same "request", a member's own write is attributed to the cookie's user.
    const manual = await newExpense(houseA.id, ana.id, "Manual");
    // async + await: a PrismaPromise is lazy, so the write must run inside the context's callback.
    const automatic = await runWithAuditContext({ system: true, groupId: houseA.id }, async () =>
      await newExpense(houseA.id, ana.id, "Automatic")
    );
    await flushAudit();

    expect((await revisionOf("Expense", manual.id)).actorId).toBe(ana.id);
    const systemRevision = await revisionOf("Expense", automatic.id);
    expect(systemRevision.actorId).toBeNull();
    expect(systemRevision.groupId).toBe(houseA.id);
    expect((systemRevision.after as Record<string, unknown>).description).toBe("Automatic");
  });

  it("a callback that returns the un-awaited PrismaPromise still writes as the system (runWithAuditContext awaits inside the store)", async () => {
    const { ana, houseA } = await seedRule();
    requestCookies.session = await signIn(ana);

    // No async/await in the callback: the lazy query must still run inside the system context.
    const automatic = await runWithAuditContext({ system: true, groupId: houseA.id }, () =>
      newExpense(houseA.id, ana.id, "Lazy automatic")
    );
    await flushAudit();

    const revision = await revisionOf("Expense", automatic.id);
    expect(revision.actorId).toBeNull();
    expect(revision.groupId).toBe(houseA.id);
  });

  it("system wins over an explicit actorId merged into the same context", async () => {
    const { ana, houseA } = await seedRule();
    const automatic = await runWithAuditContext({ actorId: ana.id, system: true, groupId: houseA.id }, async () =>
      await newExpense(houseA.id, ana.id, "Automatic")
    );
    await flushAudit();
    expect((await revisionOf("Expense", automatic.id)).actorId).toBeNull();
  });

  it("the rule is audited like any model; its ledger rows are bookkeeping and write no revision", async () => {
    const { houseA, rule } = await seedRule();
    await runWithAuditContext({ system: true, groupId: houseA.id }, async () =>
      await prisma.recurringExpenseOccurrence.create({
        data: { recurringExpenseId: rule.id, period: "2026-10", dueOn: new Date("2026-10-05T00:00:00Z"), status: "SKIPPED" },
      })
    );
    await flushAudit();

    const ruleRevision = await revisionOf("RecurringExpense", rule.id);
    expect(ruleRevision.groupId).toBe(houseA.id);
    expect((ruleRevision.after as Record<string, unknown>).description).toBe("Rent");
    expect(await prisma.entityRevision.count({ where: { entityType: "RecurringExpenseOccurrence" } })).toBe(0);
  });

  it("expenseService.create with { db: tx, recurringExpenseId } writes in the transaction; the snapshot carries the rule id", async () => {
    const { ana, bob, houseA, rule } = await seedRule();
    requestCookies.session = await signIn(bob);

    const posted = await runWithAuditContext({ system: true, groupId: houseA.id }, async () =>
      await prisma.$transaction((tx) =>
        expenseService.create(
          houseA.id,
          [ana.id, bob.id],
          { payerId: ana.id, description: "Rent", amount: 1800, splitEqually: true, date: new Date("2026-10-05T12:00:00") },
          { db: tx, recurringExpenseId: rule.id }
        )
      )
    );
    await flushAudit();

    expect((await prisma.expense.findUniqueOrThrow({ where: { id: posted.id } })).recurringExpenseId).toBe(rule.id);
    const revision = await revisionOf("Expense", posted.id);
    expect(revision.actorId).toBeNull();
    expect((revision.after as Record<string, unknown>).recurringExpenseId).toBe(rule.id);
  });
});

describe("notices: schema + no audit trail (spec 009, integration, real pglite DB)", () => {
  beforeEach(reset);

  const notice = (userId: number, groupId: number, actorId: number | null, dedupeKey?: string) => ({
    publicId: randomUUID(),
    userId,
    groupId,
    type: "EXPENSE_NEW" as const,
    actorId,
    params: { description: "Groceries A", amount: "50.00" },
    dedupeKey,
  });

  it("writes to Notification and NotificationPreference record no EntityRevision on any write path (criterion 20)", async () => {
    const { ana, bob, houseA } = await seedTwoHouses();
    await flushAudit();
    const before = await prisma.entityRevision.count();

    await runWithAuditContext({ actorId: ana.id, groupId: houseA.id }, async () => {
      const one = await prisma.notification.create({ data: notice(bob.id, houseA.id, ana.id) });
      await prisma.notification.update({ where: { id: one.id }, data: { readAt: new Date() } });
      await prisma.notification.createMany({ data: [notice(bob.id, houseA.id, ana.id)] });
      await prisma.notification.createManyAndReturn({ data: [notice(bob.id, houseA.id, null, "k1")], skipDuplicates: true });
      await prisma.notification.updateMany({ where: { userId: bob.id }, data: { readAt: new Date() } });
      await prisma.notification.delete({ where: { id: one.id } });
      await prisma.notification.deleteMany({ where: { userId: bob.id } });

      const key = { userId_type: { userId: bob.id, type: "EXPENSE_NEW" as const } };
      await prisma.notificationPreference.upsert({ where: key, create: { userId: bob.id, type: "EXPENSE_NEW", enabled: false }, update: { enabled: false } });
      await prisma.notificationPreference.update({ where: key, data: { enabled: true } });
      await prisma.notificationPreference.create({ data: { userId: bob.id, type: "DEBT_REMINDER", enabled: false } });
      await prisma.notificationPreference.delete({ where: key });
      await prisma.notificationPreference.deleteMany({ where: { userId: bob.id } });

      // Control in the same context: a house model is still audited, so the zero below is not vacuous.
      await prisma.shoppingItem.create({ data: { publicId: randomUUID(), groupId: houseA.id, name: "Milk" } });
    });
    await flushAudit();

    expect(await prisma.entityRevision.count({
      where: { entityType: { in: ["Notification", "NotificationPreference"] } },
    })).toBe(0);
    const control = await prisma.entityRevision.findFirstOrThrow({ where: { entityType: "ShoppingItem" } });
    expect(control.actorId).toBe(ana.id);
    expect(await prisma.entityRevision.count()).toBe(before + 1);
  });

  it("dedupeKey is unique per recipient, NULL keys never collide, a mixed batch returns only the new row, and deleting a house removes only its notices", async () => {
    const { ana, bob, carol, houseA, houseB } = await seedTwoHouses();

    // Event notices carry no key: the same recipient can hold any number of them.
    await prisma.notification.createMany({ data: [notice(bob.id, houseA.id, ana.id), notice(bob.id, houseA.id, ana.id)] });
    // A scheduled key inserts once per recipient; the duplicate run is skipped and returns nothing.
    const first = await prisma.notification.createManyAndReturn({
      data: [notice(bob.id, houseA.id, null, "DEBT_REMINDER:1:2026-W41"), notice(ana.id, houseA.id, null, "DEBT_REMINDER:1:2026-W41")],
      skipDuplicates: true,
    });
    const again = await prisma.notification.createManyAndReturn({
      data: [notice(bob.id, houseA.id, null, "DEBT_REMINDER:1:2026-W41")],
      skipDuplicates: true,
    });
    expect(first.map((n) => n.userId).sort()).toEqual([ana.id, bob.id].sort());
    expect(again).toEqual([]);
    // A mixed batch: the duplicate key is skipped, the new key is inserted — and only it comes back
    // (spec 010 pushes exactly the returned rows).
    const mixed = await prisma.notification.createManyAndReturn({
      data: [notice(bob.id, houseA.id, null, "DEBT_REMINDER:1:2026-W41"), notice(bob.id, houseA.id, null, "DEBT_REMINDER:1:2026-W42")],
      skipDuplicates: true,
    });
    expect(mixed.map((n) => [n.userId, n.dedupeKey])).toEqual([[bob.id, "DEBT_REMINDER:1:2026-W42"]]);
    await expect(
      prisma.notification.create({ data: notice(bob.id, houseB.id, null, "DEBT_REMINDER:1:2026-W41") })
    ).rejects.toMatchObject({ code: "P2002" });
    expect(await prisma.notification.count({ where: { userId: bob.id } })).toBe(4);

    // The cascade is scoped to the deleted house: a notice in house B survives.
    const survivor = await prisma.notification.create({ data: notice(carol.id, houseB.id, null, "DEBT_REMINDER:2:2026-W41") });
    await prisma.group.delete({ where: { id: houseA.id } });
    expect((await prisma.notification.findMany()).map((n) => n.id)).toEqual([survivor.id]);
  });
});

// Spec 010: a subscription row holds the device's push secrets (p256dh/auth). EntityRevision feeds Activity ›
// Detailed, which every member of a house can read — so no write path may copy a subscription into it.
describe("push subscriptions: no audit trail (spec 010, integration, real pglite DB)", () => {
  beforeEach(reset);

  const subscription = (userId: number, n: number) => ({
    userId,
    endpoint: `https://fcm.googleapis.com/fcm/send/device-${n}`,
    p256dh: `p256dh-secret-${n}`,
    auth: `auth-secret-${n}`,
  });
  const first = { endpoint: "https://fcm.googleapis.com/fcm/send/device-1" };

  it("no Prisma write operation on PushSubscription records an EntityRevision, while a house model still does (criterion 13)", async () => {
    const { ana, bob, houseA } = await seedTwoHouses();
    await flushAudit();
    const before = await prisma.entityRevision.count();

    // One entry per write operation the audit extension intercepts, pinned to WRITE_OPS: an operation added
    // there without a case here fails this test instead of leaving an unchecked path.
    const writes: Record<string, () => Promise<unknown>> = {
      create: () => prisma.pushSubscription.create({ data: subscription(bob.id, 1) }),
      update: () => prisma.pushSubscription.update({ where: first, data: { locale: "pt" } }),
      upsert: () => prisma.pushSubscription.upsert({ where: first, create: subscription(ana.id, 1), update: { userId: ana.id } }),
      createMany: () => prisma.pushSubscription.createMany({ data: [subscription(bob.id, 2), subscription(bob.id, 3)] }),
      createManyAndReturn: () => prisma.pushSubscription.createManyAndReturn({ data: [subscription(bob.id, 4)] }),
      updateMany: () => prisma.pushSubscription.updateMany({ where: { userId: bob.id }, data: { locale: "es" } }),
      updateManyAndReturn: () => prisma.pushSubscription.updateManyAndReturn({ where: { userId: bob.id }, data: { locale: "fr" } }),
      delete: () => prisma.pushSubscription.delete({ where: first }),
      deleteMany: () => prisma.pushSubscription.deleteMany({ where: { userId: bob.id } }),
    };
    expect(Object.keys(writes).sort()).toEqual([...WRITE_OPS].sort());

    const results: Record<string, unknown> = {};
    await runWithAuditContext({ actorId: ana.id, groupId: houseA.id }, async () => {
      for (const [operation, write] of Object.entries(writes)) results[operation] = await write();
      // Control in the same context: a house model is still audited, so the zero below is not vacuous.
      await prisma.shoppingItem.create({ data: { publicId: randomUUID(), groupId: houseA.id, name: "Milk" } });
    });
    await flushAudit();

    // Every write really touched rows (the extension had something to record): the upsert moved the endpoint
    // to Ana, the bulk writes saw Bob's three devices, and nothing is left.
    expect((results.upsert as { userId: number }).userId).toBe(ana.id);
    expect(results.updateManyAndReturn).toHaveLength(3);
    expect(results.deleteMany).toEqual({ count: 3 });
    expect(await prisma.pushSubscription.count()).toBe(0);

    expect(await prisma.entityRevision.count({ where: { entityType: "PushSubscription" } })).toBe(0);
    const control = await prisma.entityRevision.findFirstOrThrow({ where: { entityType: "ShoppingItem" } });
    expect(control.actorId).toBe(ana.id);
    expect(await prisma.entityRevision.count()).toBe(before + 1);
    expect(JSON.stringify(await prisma.entityRevision.findMany())).not.toMatch(/auth-secret|p256dh-secret/);
  });
});

// Spec 010 (cycle B): the push service, the push after a notice insert and the deletion on every sessionVersion bump.
// web-push is mocked (above); push is configured with placeholder VAPID values the mock never checks.
describe("web push (spec 010, integration, real pglite DB)", () => {
  beforeEach(async () => {
    await reset();
    mockSendNotification.mockReset();
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "public-key");
    vi.stubEnv("VAPID_PRIVATE_KEY", "private-key");
    vi.stubEnv("VAPID_SUBJECT", "mailto:qa@homeshare.test");
  });
  afterEach(async () => {
    await flushPush();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const P256DH = Buffer.alloc(65, 4).toString("base64url");
  const AUTH = Buffer.alloc(16, 9).toString("base64url");
  const endpoint = (n: number) => `https://fcm.googleapis.com/fcm/send/device-${n}`;
  const device = (n: number, locale?: "en" | "pt" | "es" | "fr") => ({ endpoint: endpoint(n), p256dh: P256DH, auth: AUTH, locale });
  const devicesOf = async (userId: number) =>
    (await prisma.pushSubscription.findMany({ where: { userId }, orderBy: { id: "asc" } })).map((s) => s.endpoint);
  /** [endpoint, parsed payload] of every send, in call order. */
  const sends = () =>
    mockSendNotification.mock.calls.map(([subscription, payload]) => [subscription.endpoint as string, JSON.parse(payload as string)] as const);

  // ── Task 7: register / unregister ────────────────────────────────────────────────────────────────

  it("register upserts by endpoint: re-registering refreshes keys and locale, another member takes the endpoint over, and a missing locale keeps the stored one (criterion 5)", async () => {
    const { ana, bob } = await seedTwoHouses();
    await pushService.register(ana.id, ana.sessionVersion, device(1, "en"));
    const newKey = Buffer.alloc(65, 5).toString("base64url");
    await pushService.register(ana.id, ana.sessionVersion, { ...device(1, "pt"), p256dh: newKey });
    expect(await prisma.pushSubscription.findMany()).toEqual([
      expect.objectContaining({ userId: ana.id, endpoint: endpoint(1), p256dh: newKey, locale: "pt" }),
    ]);

    // Bob registers the same browser (shared device): one owner per endpoint. The worker's pushsubscriptionchange
    // re-POST carries no locale, so the stored one stays.
    await pushService.register(bob.id, bob.sessionVersion, device(1));
    expect(await prisma.pushSubscription.findMany()).toEqual([
      expect.objectContaining({ userId: bob.id, endpoint: endpoint(1), p256dh: P256DH, locale: "pt" }),
    ]);

    // A new endpoint without a locale gets the schema default.
    await pushService.register(bob.id, bob.sessionVersion, device(2));
    expect((await prisma.pushSubscription.findUniqueOrThrow({ where: { endpoint: endpoint(2) } })).locale).toBe("en");
  });

  it("a member keeps at most 10 subscriptions: the least recently (re)registered one goes, a re-registered device counts as fresh, nobody else's is touched (criterion 5)", async () => {
    const { ana, bob } = await seedTwoHouses();
    await pushService.register(ana.id, ana.sessionVersion, device(100, "en"));
    const DAY = 86_400_000;
    // Ten devices registered on ten past days: device-1 is the oldest.
    await prisma.pushSubscription.createMany({
      data: Array.from({ length: 10 }, (_, i) => ({
        userId: bob.id,
        ...device(i + 1, "en"),
        updatedAt: new Date(Date.now() - (20 - i) * DAY),
      })),
    });

    await pushService.register(bob.id, bob.sessionVersion, device(1, "en")); // Bob opens the app on device-1: no new row, nothing evicted
    expect(await devicesOf(bob.id)).toHaveLength(10);

    await pushService.register(bob.id, bob.sessionVersion, device(11, "en")); // the 11th device evicts device-2, now the stalest
    const bobs = await devicesOf(bob.id);
    expect(bobs).toHaveLength(10);
    expect(bobs).toEqual(expect.arrayContaining([endpoint(1), endpoint(11)]));
    expect(bobs).not.toContain(endpoint(2));
    expect(await devicesOf(ana.id)).toEqual([endpoint(100)]);
  });

  it("unregister deletes only the caller's row and is idempotent (criterion 5)", async () => {
    const { ana, bob } = await seedTwoHouses();
    await pushService.register(ana.id, ana.sessionVersion, device(1, "en"));

    await pushService.unregister(bob.id, endpoint(1)); // not Bob's: untouched
    expect(await devicesOf(ana.id)).toEqual([endpoint(1)]);

    await pushService.unregister(ana.id, endpoint(1));
    await pushService.unregister(ana.id, endpoint(1)); // again: no error
    expect(await prisma.pushSubscription.count()).toBe(0);
  });

  // ── Tasks 7–8: dispatch after a notice insert ────────────────────────────────────────────────────

  it("a notice insert pushes once per subscription of each recipient, in its locale, without the amount; 404/410 delete the row, a 500 keeps it and logs the host only (criteria 6, 7, 13)", async () => {
    const { ana, bob, houseA } = await seedTwoHouses();
    const dan = await prisma.user.create({ data: { publicId: randomUUID(), name: "Dan", username: "dan" } });
    await prisma.groupMember.create({ data: { userId: dan.id, groupId: houseA.id, role: "MEMBER", colorIndex: 2 } });
    await pushService.register(ana.id, ana.sessionVersion, device(1, "en")); // the actor: never notified, so never pushed
    await pushService.register(bob.id, bob.sessionVersion, device(2, "en"));
    await pushService.register(bob.id, bob.sessionVersion, device(3, "pt"));
    await pushService.register(dan.id, dan.sessionVersion, device(4, "es"));
    await pushService.register(dan.id, dan.sessionVersion, device(5, "fr"));
    const failures: Record<string, number> = { [endpoint(3)]: 410, [endpoint(4)]: 404, [endpoint(5)]: 500 };
    mockSendNotification.mockImplementation(async (subscription: { endpoint: string }) => {
      const statusCode = failures[subscription.endpoint];
      // Shaped like web-push's WebPushError, which carries the full endpoint.
      if (statusCode) throw Object.assign(new Error(`unexpected response ${subscription.endpoint}`), { statusCode, endpoint: subscription.endpoint });
      return { statusCode: 201 };
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const created = await notificationService.create({
      groupId: houseA.id,
      type: "EXPENSE_NEW",
      actorId: ana.id,
      notices: [ana, bob, dan].map((u) => ({
        userId: u.id,
        params: { expensePublicId: randomUUID(), description: "Electricity", amount: "987654.32" },
      })),
    });
    expect(created.map((n) => n.userId)).toEqual([bob.id, dan.id]);
    await flushPush();

    const sent = sends();
    expect(sent.map(([e]) => e)).toEqual([2, 3, 4, 5].map(endpoint));
    expect(sent.map(([, payload]) => payload.body)).toEqual([
      "Ana added “Electricity”",
      "Ana adicionou “Electricity”",
      "Ana añadió “Electricity”",
      "Ana a ajouté “Electricity”",
    ]);
    for (const [, payload] of sent) {
      expect(payload).toMatchObject({ title: "House A", url: `/expenses?house=${houseA.publicId}`, tag: `EXPENSE_NEW:${houseA.publicId}` });
    }
    expect(JSON.stringify(sent)).not.toMatch(/987|654/);

    expect(await devicesOf(bob.id)).toEqual([endpoint(2)]); // 410 deleted
    expect(await devicesOf(dan.id)).toEqual([endpoint(5)]); // 404 deleted, 500 kept
    expect(await devicesOf(ana.id)).toEqual([endpoint(1)]);
    const lines = warn.mock.calls.map(([line]) => String(line));
    expect(lines.filter((line) => line.includes("push delivery failed"))).toHaveLength(1);
    expect(lines.join("\n")).toContain('"host":"fcm.googleapis.com"');
    expect(lines.join("\n")).not.toContain("device-");
  });

  it("only inserted notices are pushed: a member who turned the type off and a repeated scheduled run get no push (criterion 6)", async () => {
    const { ana, bob, houseA } = await seedTwoHouses();
    await pushService.register(ana.id, ana.sessionVersion, device(1, "en"));
    await pushService.register(bob.id, bob.sessionVersion, device(2, "en"));
    await notificationService.setPreference(ana.id, { type: "DEBT_REMINDER", enabled: false });
    const run = () =>
      notificationService.create({
        groupId: houseA.id,
        type: "DEBT_REMINDER",
        actorId: null,
        notices: [ana, bob].map((u) => ({ userId: u.id, params: { amount: "10.00" }, dedupeKey: `DEBT_REMINDER:${houseA.id}:2026-W41` })),
      });

    expect((await run()).map((n) => n.userId)).toEqual([bob.id]);
    await flushPush();
    expect(sends().map(([e, payload]) => [e, payload.body])).toEqual([[endpoint(2), "You have an open balance to settle"]]);

    expect(await run()).toEqual([]); // the duplicate run inserts nothing...
    await flushPush();
    expect(mockSendNotification).toHaveBeenCalledTimes(1); // ...and pushes nothing
  });

  it("without the VAPID variables a notice is still created and nothing is sent (criterion 1)", async () => {
    vi.stubEnv("VAPID_PRIVATE_KEY", "");
    const { ana, bob, houseA } = await seedTwoHouses();
    await prisma.pushSubscription.create({ data: { userId: bob.id, ...device(1, "en") } });

    const created = await notificationService.create({
      groupId: houseA.id,
      type: "EXPENSE_NEW",
      actorId: ana.id,
      notices: [{ userId: bob.id, params: { description: "Milk", amount: "5.00" } }],
    });
    await flushPush();

    expect(created).toHaveLength(1);
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  // ── Task 9: every sessionVersion bump deletes the member's subscriptions ─────────────────────────
  // "In the same transaction" is pinned by auth.service.test.ts (the deletion is an operation of the bump's batch /
  // tx). It cannot be exercised here: a failed transaction leaves the shared pglite socket connection out of step
  // (every later query receives the previous query's result), which would break every test after it.

  it("logout, password change and account deletion each delete all of the member's subscriptions — never another member's (criterion 9)", async () => {
    const { ana, bob } = await seedTwoHouses();
    await pushService.register(ana.id, ana.sessionVersion, device(9, "en"));
    // Each register carries the version of a session signed after the previous bump (the live column).
    const registerBob = async (sessionVersion: number) => {
      await pushService.register(bob.id, sessionVersion, device(1, "en"));
      await pushService.register(bob.id, sessionVersion, device(2, "pt"));
      expect(await devicesOf(bob.id)).toHaveLength(2);
    };

    await registerBob(0);
    expect(await authService.bumpSessionVersion(bob.id)).toBe(1); // logout
    expect(await devicesOf(bob.id)).toEqual([]);

    await registerBob(1);
    expect(await authService.changePassword(bob.id, undefined, "new-password-123", Math.floor(Date.now() / 1000))).toEqual({
      ok: true,
      sessionVersion: 2,
    });
    expect(await devicesOf(bob.id)).toEqual([]);

    await registerBob(2);
    expect(await authService.deleteAccount(bob.id, "new-password-123")).toEqual({ ok: true });
    expect(await devicesOf(bob.id)).toEqual([]);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: bob.id } })).sessionVersion).toBe(3);

    expect(await devicesOf(ana.id)).toEqual([endpoint(9)]);
  });

  // Cycle G review M6: the logout-vs-register race against the real row lock. A register still carrying the version of
  // a session revoked meanwhile reads the live column under FOR UPDATE, writes nothing and commits (a write-free
  // transaction — never a failed one, which would desync the shared pglite connection); the service then answers 401.
  it("a register carrying a revoked session's version answers 401 SESSION_REVOKED and stores nothing (criterion 9)", async () => {
    const { bob } = await seedTwoHouses();
    expect(await authService.bumpSessionVersion(bob.id)).toBe(1); // a logout committed after this request's session check

    await expect(pushService.register(bob.id, 0, device(1, "en"))).rejects.toMatchObject({ status: 401, code: "SESSION_REVOKED" });
    expect(await prisma.pushSubscription.count()).toBe(0);

    // The connection is still in step and the lock released: the live version registers at once.
    await pushService.register(bob.id, 1, device(1, "en"));
    expect(await devicesOf(bob.id)).toEqual([endpoint(1)]);
  });
});

describe("notification center (spec 009, integration, real pglite DB)", () => {
  beforeEach(reset);

  const svc = notificationService;

  /** House A: Ana (admin), Bob, Dan, Eve, Fay. House B: Carol (admin), Bob. expA: Ana paid 100, Ana/Bob 50/50. */
  async function seed() {
    const seeded = await seedTwoHouses();
    const mkUser = (name: string, username: string) =>
      prisma.user.create({ data: { publicId: randomUUID(), name, username } });
    const dan = await mkUser("Dan", "dan");
    const eve = await mkUser("Eve", "eve");
    const fay = await mkUser("Fay", "fay");
    await prisma.groupMember.createMany({
      data: [
        { userId: dan.id, groupId: seeded.houseA.id, role: "MEMBER", colorIndex: 2 },
        { userId: eve.id, groupId: seeded.houseA.id, role: "MEMBER", colorIndex: 3 },
        { userId: fay.id, groupId: seeded.houseA.id, role: "MEMBER", colorIndex: 4 },
        { userId: seeded.bob.id, groupId: seeded.houseB.id, role: "MEMBER", colorIndex: 1 },
      ],
    });
    return { ...seeded, dan, eve, fay };
  }

  const leave = (userId: number, groupId: number) =>
    prisma.groupMember.update({ where: { userId_groupId: { userId, groupId } }, data: { leftAt: new Date() } });

  const rowsOf = (userId: number) =>
    prisma.notification.findMany({ where: { userId }, orderBy: { id: "asc" } });

  const params = { description: "Groceries", amount: "50.00" };

  // ── Task 4: create + preferences ─────────────────────────────────────────────────────────────────

  it("create keeps only active members of the event's house: the actor, an ex-member, a deleted account and another house's member get nothing (criteria 4, 9)", async () => {
    const { ana, bob, carol, dan, fay, houseA } = await seed();
    await leave(dan.id, houseA.id);
    // Even with a stale active membership, a deleted account is never a recipient.
    await prisma.user.update({ where: { id: fay.id }, data: { deletedAt: new Date() } });

    const created = await svc.create({
      groupId: houseA.id,
      type: "EXPENSE_NEW",
      actorId: ana.id,
      notices: [ana, bob, dan, fay, carol].map((u) => ({ userId: u.id, params })),
    });

    expect(created.map((n) => n.userId)).toEqual([bob.id]);
    expect(await prisma.notification.count()).toBe(1);
    expect(await prisma.notification.findFirstOrThrow()).toMatchObject({
      userId: bob.id,
      groupId: houseA.id,
      type: "EXPENSE_NEW",
      actorId: ana.id,
      params,
      dedupeKey: null,
      readAt: null,
    });
  });

  it("a type turned off creates no notice of that type for that member, in any house; other types and members are unaffected (criteria 9, 13)", async () => {
    const { ana, bob, dan, houseA, houseB } = await seed();
    const allOn = { EXPENSE_NEW: true, PAYMENT_RECEIVED: true, DEBT_REMINDER: true, RECURRING_DUE: true };
    expect(await svc.getPreferences(bob.id)).toEqual(allOn);

    expect(await svc.setPreference(bob.id, { type: "EXPENSE_NEW", enabled: false })).toEqual({ ...allOn, EXPENSE_NEW: false });
    expect(await svc.setPreference(bob.id, { type: "EXPENSE_NEW", enabled: false })).toEqual({ ...allOn, EXPENSE_NEW: false });
    expect(await prisma.notificationPreference.count()).toBe(1);

    const expenseNew = (groupId: number) =>
      svc.create({ groupId, type: "EXPENSE_NEW", actorId: ana.id, notices: [bob, dan].map((u) => ({ userId: u.id, params })) });
    expect((await expenseNew(houseA.id)).map((n) => n.userId)).toEqual([dan.id]);
    expect(await expenseNew(houseB.id)).toEqual([]); // the switch is per user, across houses
    const payment = await svc.create({ groupId: houseA.id, type: "PAYMENT_RECEIVED", actorId: ana.id, notices: [{ userId: bob.id, params }] });
    expect(payment.map((n) => n.userId)).toEqual([bob.id]);

    await svc.setPreference(bob.id, { type: "EXPENSE_NEW", enabled: true });
    expect((await expenseNew(houseA.id)).map((n) => n.userId)).toEqual([bob.id, dan.id]);
    expect(await svc.getPreferences(dan.id)).toEqual(allOn);
  });

  it("a scheduled dedupeKey inserts once per recipient: the repeated create returns no row and inserts nothing (criterion 17)", async () => {
    const { bob, dan, houseA } = await seed();
    const run = () =>
      svc.create({
        groupId: houseA.id,
        type: "DEBT_REMINDER",
        actorId: null,
        notices: [bob, dan].map((u) => ({ userId: u.id, params: { amount: "10.00" }, dedupeKey: `DEBT_REMINDER:${houseA.id}:2026-W41` })),
      });
    expect((await run()).map((n) => n.userId)).toEqual([bob.id, dan.id]);
    expect(await run()).toEqual([]);
    expect(await prisma.notification.count()).toBe(2);
  });

  // ── Task 5: event producers ──────────────────────────────────────────────────────────────────────

  it("expenseCreated notifies the payer and every participant with a share > 0 — never the author, a zero share or an ex-member (criterion 4)", async () => {
    const { ana, bob, carol, dan, eve, fay, houseA } = await seed();
    // Ana records an expense Bob paid (Bob takes no part); Eve's share is zero; Fay left meanwhile.
    const expense = await expenseService.create(houseA.id, [], {
      payerId: bob.id,
      description: "Dinner",
      amount: 100,
      participants: [
        { userId: ana.id, amount: 30 },
        { userId: dan.id, amount: 30 },
        { userId: eve.id, amount: 0 },
        { userId: fay.id, amount: 40 },
      ],
    });
    await leave(fay.id, houseA.id);

    const created = await svc.expenseCreated(expense, ana.id);

    expect(created.map((n) => n.userId).sort()).toEqual([bob.id, dan.id].sort());
    for (const user of [ana, eve, fay, carol]) expect(await rowsOf(user.id)).toEqual([]);
    expect(await rowsOf(dan.id)).toEqual([
      expect.objectContaining({
        groupId: houseA.id,
        type: "EXPENSE_NEW",
        actorId: ana.id,
        params: { expensePublicId: expense.publicId, description: "Dinner", amount: "100.00", recurring: false },
        dedupeKey: null,
        readAt: null,
      }),
    ]);
  });

  it("a recurring posting (no actor) notifies the payer and every participant, marked recurring (criterion 5)", async () => {
    const { ana, bob, houseA } = await seed();
    const posted = await expenseService.create(houseA.id, [ana.id, bob.id], {
      payerId: ana.id,
      description: "Rent",
      amount: 1800,
      splitEqually: true,
    });

    const created = await svc.expenseCreated(posted, null);

    expect(created.map((n) => n.userId).sort()).toEqual([ana.id, bob.id].sort());
    expect(created.map((n) => [n.actorId, n.params])).toEqual([
      [null, { expensePublicId: posted.publicId, description: "Rent", amount: "1800.00", recurring: true }],
      [null, { expensePublicId: posted.publicId, description: "Rent", amount: "1800.00", recurring: true }],
    ]);
  });

  it("settlementCreated notifies the recipient — unless they recorded it, or they left the house (criterion 6)", async () => {
    const { ana, bob, dan, eve, houseA } = await seed();
    const toAna = await settlementService.create(houseA.id, { fromUserId: bob.id, toUserId: ana.id, amount: 20.5 });
    const created = await svc.settlementCreated(toAna, bob.id);
    expect(created).toEqual([
      expect.objectContaining({
        userId: ana.id,
        groupId: houseA.id,
        type: "PAYMENT_RECEIVED",
        actorId: bob.id,
        params: { settlementPublicId: toAna.publicId, fromUserId: bob.id, amount: "20.50" },
      }),
    ]);

    // Eve records Bob's payment to Ana: the notice names the payer (Bob); the recorder (Eve) is the actor.
    expect(await svc.settlementCreated(toAna, eve.id)).toEqual([
      expect.objectContaining({ userId: ana.id, actorId: eve.id, params: { settlementPublicId: toAna.publicId, fromUserId: bob.id, amount: "20.50" } }),
    ]);

    // Ana records Bob's payment to herself: nothing to tell her.
    expect(await svc.settlementCreated(toAna, ana.id)).toEqual([]);
    const toDan = await settlementService.create(houseA.id, { fromUserId: bob.id, toUserId: dan.id, amount: 5 });
    await leave(dan.id, houseA.id);
    expect(await svc.settlementCreated(toDan, bob.id)).toEqual([]);
    expect(await prisma.notification.count()).toBe(2);
  });

  it("the recurring poster notifies the payer and every participant of a posted period, marked recurring, with no actor — once (criterion 5)", async () => {
    const { ana, bob, dan, eve, fay, houseA } = await seed();
    const rule = await prisma.recurringExpense.create({
      data: {
        publicId: randomUUID(),
        groupId: houseA.id,
        payerId: ana.id,
        description: "Rent",
        amount: 1800,
        dayOfMonth: 5,
        timezone: "America/Sao_Paulo",
        activeFrom: new Date("2026-10-01T00:00:00Z"),
      },
    });
    const dueDay = new Date("2026-10-05T15:00:00Z"); // noon in São Paulo

    expect((await recurringExpenseService.postDue(dueDay)).posted).toBe(1);
    const [posted] = await prisma.expense.findMany({ where: { recurringExpenseId: rule.id } });
    const rows = await prisma.notification.findMany({ orderBy: { userId: "asc" } });
    // Split ALL among house A's five active members: the payer (Ana) is notified too — nobody to exclude.
    expect(rows.map((n) => n.userId)).toEqual([ana, bob, dan, eve, fay].map((u) => u.id).sort((a, b) => a - b));
    for (const row of rows) {
      expect(row).toMatchObject({
        groupId: houseA.id,
        type: "EXPENSE_NEW",
        actorId: null,
        params: { expensePublicId: posted.publicId, description: "Rent", amount: "1800.00", recurring: true },
        dedupeKey: null,
      });
    }

    // A second run posts nothing, so it notifies nothing.
    expect((await recurringExpenseService.postDue(dueDay)).posted).toBe(0);
    expect(await prisma.notification.count()).toBe(5);
  });

  // ── Task 6: read side ────────────────────────────────────────────────────────────────────────────

  /** A notice stamped `minutesAgo` before 2026-10-04 12:00 UTC (read when `read`). */
  const stamped = (userId: number, groupId: number, minutesAgo: number, read = false) => {
    const createdAt = new Date(Date.parse("2026-10-04T12:00:00Z") - minutesAgo * 60_000);
    return {
      publicId: randomUUID(),
      userId,
      groupId,
      type: "EXPENSE_NEW" as const,
      actorId: null,
      params: { description: `n${minutesAgo}`, amount: "1.00" },
      createdAt,
      readAt: read ? createdAt : null,
    };
  };

  it("list returns at most 50 of the member's notices in the active house, newest first, plus the unread count; other members and houses never (criterion 11)", async () => {
    const { ana, bob, houseA, houseB } = await seed();
    // Bob in house A: 55 notices, every 3rd one read (minute 0 is the newest).
    await prisma.notification.createMany({
      data: Array.from({ length: 55 }, (_, i) => stamped(bob.id, houseA.id, i, i % 3 === 0)),
    });
    const unreadInA = Array.from({ length: 55 }, (_, i) => i).filter((i) => i % 3 !== 0).length;
    await prisma.notification.createMany({ data: [stamped(ana.id, houseA.id, 0), stamped(bob.id, houseB.id, 0)] });

    const all = await svc.list(bob.id, houseA.id);
    expect(all.notifications).toHaveLength(50);
    expect(all.notifications.map((n) => n.params.description)).toEqual(Array.from({ length: 50 }, (_, i) => `n${i}`));
    expect(all.unreadCount).toBe(unreadInA); // counts beyond the 50 listed
    expect(all.notifications[0]).toEqual({
      publicId: expect.any(String),
      type: "EXPENSE_NEW",
      actorId: null,
      params: { description: "n0", amount: "1.00" },
      read: true,
      createdAt: "2026-10-04T12:00:00.000Z",
    });

    const unread = await svc.list(bob.id, houseA.id, { unreadOnly: true });
    expect(unread.notifications.every((n) => !n.read)).toBe(true);
    expect(unread.notifications.map((n) => n.params.description).slice(0, 3)).toEqual(["n1", "n2", "n4"]);
    expect(unread.notifications).toHaveLength(Math.min(50, unreadInA));

    expect((await svc.list(bob.id, houseB.id)).notifications).toHaveLength(1);
    expect(await svc.unreadCount(bob.id, houseA.id)).toBe(unreadInA);
    expect(await svc.unreadCount(bob.id, houseB.id)).toBe(1);
  });

  it("markRead, markAllRead and delete change only the member's notices in the active house; anyone else's id is a 404 (criterion 12)", async () => {
    const { ana, bob, houseA, houseB } = await seed();
    const [mine, mineToo, anas, mineInB] = await prisma.notification.createManyAndReturn({
      data: [stamped(bob.id, houseA.id, 1), stamped(bob.id, houseA.id, 2), stamped(ana.id, houseA.id, 1), stamped(bob.id, houseB.id, 1)],
    });
    const notFound = { status: 404, code: "NOTIFICATION_NOT_FOUND" };

    // Another member's notice, the same member's notice in another house, a missing or malformed id.
    for (const id of [anas.publicId, mineInB.publicId, randomUUID(), "not-a-uuid"]) {
      await expect(svc.markRead(bob.id, houseA.id, id)).rejects.toMatchObject(notFound);
      await expect(svc.delete(bob.id, houseA.id, id)).rejects.toMatchObject(notFound);
    }
    expect(await prisma.notification.count({ where: { readAt: null } })).toBe(4);

    expect(await svc.markRead(bob.id, houseA.id, mine.publicId)).toBe(1);
    const firstRead = (await prisma.notification.findUniqueOrThrow({ where: { id: mine.id } })).readAt;
    expect(firstRead).not.toBeNull();
    expect(await svc.markRead(bob.id, houseA.id, mine.publicId)).toBe(1); // idempotent
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: mine.id } })).readAt).toEqual(firstRead);

    expect(await svc.delete(bob.id, houseA.id, mine.publicId)).toBe(1);
    await expect(svc.delete(bob.id, houseA.id, mine.publicId)).rejects.toMatchObject(notFound);

    await svc.markAllRead(bob.id, houseA.id);
    expect(await svc.unreadCount(bob.id, houseA.id)).toBe(0);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: mineToo.id } })).readAt).not.toBeNull();
    // Ana's notice and Bob's notice in house B are untouched.
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: anas.id } })).readAt).toBeNull();
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: mineInB.id } })).readAt).toBeNull();
    expect(await prisma.notification.count()).toBe(3);
  });

  // ── Task 7: scheduled producers ──────────────────────────────────────────────────────────────────

  const allRows = () => prisma.notification.findMany({ orderBy: { id: "asc" } });
  /** A scheduled producer's result with nothing failed and nothing left for later. */
  const sent = (created: number) => ({ created, failed: 0, remaining: 0 });
  const shape = (rows: Awaited<ReturnType<typeof allRows>>) =>
    rows.map((n) => [n.userId, n.groupId, n.type, n.actorId, n.params, n.dedupeKey]);

  it("sendRecurringDueReminders reminds the payer of each unpaused rule whose next unskipped period is due tomorrow in the rule's timezone — once per (rule, period) (criteria 7, 17)", async () => {
    const { ana, bob, carol, dan, houseA, houseB } = await seed();
    const rule = (groupId: number, payerId: number, extra: Record<string, unknown> = {}) =>
      prisma.recurringExpense.create({
        data: {
          publicId: randomUUID(),
          groupId,
          payerId,
          description: "Rent",
          amount: 1800,
          dayOfMonth: 5,
          timezone: "America/Sao_Paulo",
          activeFrom: new Date("2026-10-01T00:00:00Z"),
          ...extra,
        },
      });
    const rent = await rule(houseA.id, ana.id);
    const water = await rule(houseB.id, carol.id, { description: "Water", amount: 80.5 });
    const utc = await rule(houseA.id, bob.id, { description: "Gym", timezone: "UTC" });
    await rule(houseA.id, bob.id, { description: "Paused", pausedAt: new Date() });
    await rule(houseA.id, bob.id, { description: "Skipped", skippedPeriods: ["2026-10"] });
    const closed = await rule(houseA.id, bob.id, { description: "Posted early" });
    await prisma.recurringExpenseOccurrence.create({
      data: { recurringExpenseId: closed.id, period: "2026-10", dueOn: new Date("2026-10-05T00:00:00Z"), status: "POSTED" },
    });
    await rule(houseA.id, dan.id, { description: "Payer left" });
    await leave(dan.id, houseA.id);

    expect(await svc.sendRecurringDueReminders(new Date("2026-10-03T12:00:00Z"))).toEqual(sent(0)); // two days before

    const dayBefore = new Date("2026-10-04T12:00:00Z"); // the job's hour: 09:00 in São Paulo
    expect(await svc.sendRecurringDueReminders(dayBefore)).toEqual(sent(3));
    expect(shape(await allRows())).toEqual([
      [ana.id, houseA.id, "RECURRING_DUE", null, { recurringExpensePublicId: rent.publicId, description: "Rent", amount: "1800.00", dueOn: "2026-10-05" }, `RECURRING_DUE:${rent.id}:2026-10`],
      [carol.id, houseB.id, "RECURRING_DUE", null, { recurringExpensePublicId: water.publicId, description: "Water", amount: "80.50", dueOn: "2026-10-05" }, `RECURRING_DUE:${water.id}:2026-10`],
      [bob.id, houseA.id, "RECURRING_DUE", null, { recurringExpensePublicId: utc.publicId, description: "Gym", amount: "1800.00", dueOn: "2026-10-05" }, `RECURRING_DUE:${utc.id}:2026-10`],
    ]);

    // Delivered twice the same day: nothing new.
    expect(await svc.sendRecurringDueReminders(dayBefore)).toEqual(sent(0));
    expect(await prisma.notification.count()).toBe(3);

    // 02:30 UTC on the 5th is 23:30 on the 4th in São Paulo: only the São Paulo rules are still due tomorrow.
    await prisma.notification.deleteMany();
    expect(await svc.sendRecurringDueReminders(new Date("2026-10-05T02:30:00Z"))).toEqual(sent(2));
    expect((await allRows()).map((n) => n.dedupeKey)).toEqual([`RECURRING_DUE:${rent.id}:2026-10`, `RECURRING_DUE:${water.id}:2026-10`]);
  });

  it("sendDebtReminders, on Mondays (UTC) only, tells each active member below zero in a house what they owe there — once per house and ISO week (criteria 8, 17)", async () => {
    const { ana, bob, carol, dan, houseA, houseB } = await seed();
    // House A: expA (Ana paid 100, Ana/Bob 50/50) → Bob −50; then Bob paid Ana 20 → Bob −30.
    await settlementService.create(houseA.id, { fromUserId: bob.id, toUserId: ana.id, amount: 20 });
    // Dan owes Ana 5, then leaves: an ex-member gets no reminder.
    await expenseService.create(houseA.id, [ana.id, dan.id], { payerId: ana.id, description: "Snacks", amount: 10, splitEqually: true });
    await leave(dan.id, houseA.id);
    // House B: Carol paid 30 for Carol/Bob → Bob −15 there.
    await expenseService.create(houseB.id, [carol.id, bob.id], { payerId: carol.id, description: "Water", amount: 30, splitEqually: true });

    expect(await svc.sendDebtReminders(new Date("2026-10-04T12:00:00Z"))).toEqual(sent(0)); // Sunday
    const monday = new Date("2026-10-05T12:00:00Z");
    expect(await svc.sendDebtReminders(monday)).toEqual(sent(2));
    expect(shape(await allRows())).toEqual([
      [bob.id, houseA.id, "DEBT_REMINDER", null, { amount: "30.00" }, `DEBT_REMINDER:${houseA.id}:2026-W41`],
      [bob.id, houseB.id, "DEBT_REMINDER", null, { amount: "15.00" }, `DEBT_REMINDER:${houseB.id}:2026-W41`],
    ]);

    expect(await svc.sendDebtReminders(monday)).toEqual(sent(0)); // delivered twice
    expect(await svc.sendDebtReminders(new Date("2026-10-06T12:00:00Z"))).toEqual(sent(0)); // Tuesday
    expect(await svc.sendDebtReminders(new Date("2026-10-12T12:00:00Z"))).toEqual(sent(2)); // next week, debt still open
    expect(await prisma.notification.count()).toBe(4);
  });

  it("prune deletes notices older than 90 days and nothing newer (criterion 18)", async () => {
    const { bob, houseA, houseB } = await seed();
    const now = new Date("2026-10-04T12:00:00Z");
    const DAY = 86_400_000;
    const aged = (groupId: number, ageMs: number) => ({
      publicId: randomUUID(),
      userId: bob.id,
      groupId,
      type: "EXPENSE_NEW" as const,
      params: { amount: "1.00" },
      createdAt: new Date(now.getTime() - ageMs),
    });
    await prisma.notification.createMany({
      data: [aged(houseA.id, 90 * DAY + 60_000), aged(houseB.id, 400 * DAY), aged(houseA.id, 90 * DAY), aged(houseB.id, DAY)],
    });

    expect(await svc.prune(now)).toBe(2);
    expect((await allRows()).map((n) => now.getTime() - n.createdAt.getTime())).toEqual([90 * DAY, DAY]);
  });

  // ── Task 8: account deletion ─────────────────────────────────────────────────────────────────────

  it("account deletion deletes the member's notices in every house and their preferences; other members' rows stay, even ones the member caused (criterion 19)", async () => {
    const { ana, bob, houseA, houseB } = await seed();
    await prisma.notification.createMany({
      data: [stamped(bob.id, houseA.id, 1), stamped(bob.id, houseB.id, 1), { ...stamped(ana.id, houseA.id, 1), actorId: bob.id }],
    });
    await svc.setPreference(bob.id, { type: "DEBT_REMINDER", enabled: false });
    await svc.setPreference(ana.id, { type: "EXPENSE_NEW", enabled: false });

    expect(await authService.deleteAccount(bob.id, undefined)).toEqual({ ok: true });

    expect(await rowsOf(bob.id)).toEqual([]);
    expect(await prisma.notificationPreference.count({ where: { userId: bob.id } })).toBe(0);
    // Ana's notice keeps its actor: the soft-deleted account is resolved to its anonymized name at read time.
    expect((await rowsOf(ana.id)).map((n) => n.actorId)).toEqual([bob.id]);
    expect((await svc.getPreferences(ana.id)).EXPENSE_NEW).toBe(false);
  });
});

describe("custom categories (integration, real pglite DB)", () => {
  beforeEach(reset);

  async function seedHouse() {
    const ana = await prisma.user.create({ data: { publicId: randomUUID(), name: "Ana", username: "ana-cat" } });
    const house = await prisma.group.create({ data: { publicId: randomUUID(), name: "Cat House" } });
    await prisma.groupMember.create({ data: { userId: ana.id, groupId: house.id, role: "ADMIN", colorIndex: 0 } });
    return { ana, house };
  }

  it("create trims the name, is group-scoped, and rejects duplicates", async () => {
    const { house } = await seedHouse();
    const c = await categoryService.create(house.id, "  Streaming  ");
    expect(c.name).toBe("Streaming");
    expect(c.groupId).toBe(house.id);
    await expect(categoryService.create(house.id, "Streaming")).rejects.toMatchObject({ status: 409 });
  });

  it("listWithCounts counts the expenses using each category by name", async () => {
    const { ana, house } = await seedHouse();
    await categoryService.create(house.id, "Streaming");
    await categoryService.create(house.id, "Unused");
    await expenseService.create(house.id, [ana.id], { payerId: ana.id, description: "Netflix", amount: 40, categories: ["Streaming"], splitEqually: true });
    await expenseService.create(house.id, [ana.id], { payerId: ana.id, description: "Spotify", amount: 20, categories: ["Streaming"], splitEqually: true });
    const list = await categoryService.listWithCounts(house.id);
    const byName = new Map(list.map((c) => [c.name, c._count.expenses]));
    expect(byName.get("Streaming")).toBe(2);
    expect(byName.get("Unused")).toBe(0);
  });

  it("delete removes the category and uncategorizes its expenses", async () => {
    const { ana, house } = await seedHouse();
    const c = await categoryService.create(house.id, "Streaming");
    const exp = await expenseService.create(house.id, [ana.id], { payerId: ana.id, description: "Netflix", amount: 40, categories: ["Streaming"], splitEqually: true });
    await categoryService.delete(house.id, c.publicId);
    expect(await categoryService.findByPublicId(house.id, c.publicId)).toBeNull();
    const after = await prisma.expense.findUnique({ where: { id: exp.id } });
    expect(after!.category).toBeNull();
  });

  it("delete records an explicit UPDATE revision per affected expense (raw SQL is invisible to the audit extension), so the next edit shows no phantom category diff (I3)", async () => {
    const { ana, house } = await seedHouse();
    const otherHouse = await prisma.group.create({ data: { publicId: randomUUID(), name: "Other" } });
    const streaming = await categoryService.create(house.id, "Streaming");
    const used = await expenseService.create(house.id, [ana.id], { payerId: ana.id, description: "Netflix", amount: 40, categories: ["Streaming", "Bills"], splitEqually: true });
    const unused = await expenseService.create(house.id, [ana.id], { payerId: ana.id, description: "Rent", amount: 900, categories: ["Bills"], splitEqually: true });
    // Same tag name in ANOTHER house: the removal is scoped to the active house.
    const foreign = await prisma.expense.create({
      data: { publicId: randomUUID(), groupId: otherHouse.id, payerId: ana.id, description: "Foreign", amount: 5, categories: ["Streaming"], participants: { create: [{ userId: ana.id, amount: 5 }] } },
    });
    await flushAudit();

    await categoryService.delete(house.id, streaming.publicId, ana.id);
    await flushAudit();

    const updatesOf = (expenseId: number) =>
      prisma.entityRevision.findMany({ where: { entityType: "Expense", entityId: String(expenseId), action: "UPDATE" }, orderBy: { id: "asc" } });
    const [removal] = await updatesOf(used.id);
    expect(removal).toMatchObject({ groupId: house.id, actorId: ana.id });
    expect((removal.before as Record<string, unknown>).categories).toEqual(["Streaming", "Bills"]);
    expect((removal.after as Record<string, unknown>).categories).toEqual(["Bills"]);
    // Full snapshots, same shape as the extension's Expense UPDATE (expenseInclude): the split and the
    // payer are there, so Activity's split diff never reads this `before` as "participants untracked".
    const shares = (snapshot: unknown) =>
      (snapshot as { participants: { userId: number; amount: string }[] }).participants.map((p) => [p.userId, p.amount]);
    expect(shares(removal.before)).toEqual([[ana.id, "40"]]);
    expect(shares(removal.after)).toEqual([[ana.id, "40"]]);
    expect(removal.after).toMatchObject({ payer: { id: ana.id }, payerId: ana.id, description: "Netflix" });
    expect(Object.keys(removal.after as object)).not.toContain("platformIds"); // legacy columns omitted like the extension's snapshot
    expect(await updatesOf(unused.id)).toHaveLength(0); // never held the tag
    expect(await updatesOf(foreign.id)).toHaveLength(0);
    expect((await prisma.expense.findUniqueOrThrow({ where: { id: foreign.id } })).categories).toEqual(["Streaming"]);

    // The edit that follows borrows the removal's `after` as its derived before: only the amount differs.
    await runWithAuditContext({ actorId: ana.id, groupId: house.id }, async () =>
      expenseService.update(house.id, used.id, ana.id, true, [ana.id], { amount: 45 })
    );
    await flushAudit();
    const feed = await revisionService.listForGroup(house.id, { entityType: "Expense" });
    const edit = feed.find((r) => r.action === "UPDATE" && r.after?.amount === "45");
    expect(edit?.before?.categories).toEqual(["Bills"]);
    expect(edit?.before?.categories).toEqual(edit?.after?.categories);
    expect(edit?.before?.amount).toBe("40");
    expect(shares(edit?.before)).toEqual([[ana.id, "40"]]);
    expect(shares(edit?.after)).toEqual([[ana.id, "45"]]);
  });

  it("a house cannot delete another house's category", async () => {
    const { house: houseA } = await seedHouse();
    const houseB = await prisma.group.create({ data: { publicId: randomUUID(), name: "Other" } });
    const c = await categoryService.create(houseA.id, "Streaming");
    await expect(categoryService.delete(houseB.id, c.publicId)).rejects.toMatchObject({ status: 404 });
    expect(await categoryService.findByPublicId(houseA.id, c.publicId)).not.toBeNull();
  });

  it("existsInGroup is scoped to the house", async () => {
    const { house: houseA } = await seedHouse();
    const houseB = await prisma.group.create({ data: { publicId: randomUUID(), name: "Other" } });
    await categoryService.create(houseA.id, "Streaming");
    expect(await categoryService.existsInGroup(houseA.id, "Streaming")).toBe(true);
    expect(await categoryService.existsInGroup(houseB.id, "Streaming")).toBe(false);
  });
});

// BL-16: leave/kick soft-removes (never deletes) a GroupMember row, keeping real name/color for
// history while excluding the person from new-expense assignment; rejoining reactivates the same
// row instead of duplicating it.
describe("membership leave/kick (integration, real pglite DB)", () => {
  beforeEach(reset);

  async function seedHouse(roles: Array<"ADMIN" | "MEMBER">) {
    const users = await Promise.all(
      roles.map((_, i) => prisma.user.create({ data: { publicId: randomUUID(), name: `U${i}`, username: `u${i}-mem` } }))
    );
    const house = await prisma.group.create({ data: { publicId: randomUUID(), name: "Mem House", joinCode: `CODE${roles.length}` } });
    await prisma.groupMember.createMany({
      data: users.map((u, i) => ({ userId: u.id, groupId: house.id, role: roles[i], colorIndex: i })),
    });
    return { users, house };
  }

  it("removeMember soft-removes: row survives with leftAt set, not deleted", async () => {
    const { users: [admin, member], house } = await seedHouse(["ADMIN", "MEMBER"]);
    await groupService.removeMember(house.id, member.id);
    const row = await prisma.groupMember.findUnique({ where: { userId_groupId: { userId: member.id, groupId: house.id } } });
    expect(row).not.toBeNull();
    expect(row!.leftAt).not.toBeNull();
    const list = await groupService.listMembers(house.id);
    const entry = list.find((m) => m.id === member.id)!;
    expect(entry.active).toBe(false);
    expect(entry.name).toBe(member.name); // real name preserved, not anonymized
    void admin;
  });

  // I1: no membership row is ever deleted, so leaving/being removed/rejoining are GroupMember UPDATEs —
  // the Detailed feed reads them off the leftAt transition between the revision and its derived before.
  it("removeMember and a rejoin are GroupMember UPDATE revisions whose before/after carry the leftAt transition (I1)", async () => {
    const admin = await prisma.user.create({ data: { publicId: randomUUID(), name: "Adm", username: "adm-rev" } });
    const member = await prisma.user.create({ data: { publicId: randomUUID(), name: "Mem", username: "mem-rev" } });
    const house = await prisma.group.create({ data: { publicId: randomUUID(), name: "Rev House", joinCode: "CODE2" } });
    // Created one by one (not createMany, which logs only a bulk marker): the CREATE revision is the
    // earlier snapshot the leave borrows its `before` from.
    await prisma.groupMember.create({ data: { userId: admin.id, groupId: house.id, role: "ADMIN", colorIndex: 0 } });
    await prisma.groupMember.create({ data: { userId: member.id, groupId: house.id, role: "MEMBER", colorIndex: 1 } });
    await flushAudit();

    await runWithAuditContext({ actorId: member.id, groupId: house.id }, () => groupService.removeMember(house.id, member.id));
    await flushAudit();
    const afterLeave = await revisionService.listForGroup(house.id, { entityType: "GroupMember" });
    const leave = afterLeave.find((r) => r.action === "UPDATE");
    expect(leave).toBeDefined();
    expect(leave!.actorId).toBe(member.id);
    expect(leave!.after?.userId).toBe(member.id);
    expect(leave!.before?.leftAt).toBeNull();
    expect(leave!.after?.leftAt).toEqual(expect.any(String));

    await runWithAuditContext({ actorId: member.id, groupId: house.id }, () => groupService.joinByCode(member.id, house.joinCode!));
    await flushAudit();
    const afterRejoin = await revisionService.listForGroup(house.id, { entityType: "GroupMember" });
    const rejoin = afterRejoin.filter((r) => r.action === "UPDATE").sort((a, b) => b.id - a.id)[0];
    expect(rejoin.id).not.toBe(leave!.id);
    expect(rejoin.before?.leftAt).toEqual(expect.any(String));
    expect(rejoin.after?.leftAt).toBeNull();
  });

  it("refuses to remove the sole admin while another active member remains (409 LAST_ADMIN)", async () => {
    const { users: [admin, member], house } = await seedHouse(["ADMIN", "MEMBER"]);
    await expect(groupService.removeMember(house.id, admin.id)).rejects.toMatchObject({ status: 409, code: "LAST_ADMIN" });
    // nothing changed — admin is still active
    const row = await prisma.groupMember.findUnique({ where: { userId_groupId: { userId: admin.id, groupId: house.id } } });
    expect(row!.leftAt).toBeNull();
    void member;
  });

  it("allows removing an admin when another active admin remains", async () => {
    const { users: [admin1, admin2], house } = await seedHouse(["ADMIN", "ADMIN"]);
    await expect(groupService.removeMember(house.id, admin1.id)).resolves.toBeUndefined();
    void admin2;
  });

  it("the last remaining member of a house can always leave (house becomes empty)", async () => {
    const { users: [admin], house } = await seedHouse(["ADMIN"]);
    await expect(groupService.removeMember(house.id, admin.id)).resolves.toBeUndefined();
  });

  // Adversarial-review finding: the pre-check + write in removeMember is check-then-act, not
  // atomic — two concurrent removals of the last two admins could both pass the pre-check
  // before either write commits. Fixed with a post-write re-check + self-heal (revert). This
  // exercises the actual race (both calls fired together, interleaving at their `await` points),
  // not just the sequential guard.
  it("concurrent removal of both remaining admins never leaves the house with zero active admins", async () => {
    const { users: [admin1, admin2, member], house } = await seedHouse(["ADMIN", "ADMIN", "MEMBER"]);
    const results = await Promise.allSettled([
      groupService.removeMember(house.id, admin1.id),
      groupService.removeMember(house.id, admin2.id),
    ]);
    // Both were freely removable pairwise (each pre-check saw the other as active), so both may
    // report success — the invariant that actually matters is the FINAL persisted state, not
    // which promise resolved which way.
    void results;
    const activeAdmins = await prisma.groupMember.count({ where: { groupId: house.id, role: "ADMIN", leftAt: null } });
    const activeMembers = await prisma.groupMember.count({ where: { groupId: house.id, leftAt: null } });
    if (activeMembers > 0) {
      expect(activeAdmins).toBeGreaterThan(0);
    }
    void member;
  });

  it("rejoining reactivates the SAME row (no duplicate) and restores active:true", async () => {
    const { users: [admin, member], house } = await seedHouse(["ADMIN", "MEMBER"]);
    await groupService.removeMember(house.id, member.id);

    const result = await groupService.joinByCode(member.id, house.joinCode!);
    expect("error" in result).toBe(false);

    const rows = await prisma.groupMember.findMany({ where: { userId: member.id, groupId: house.id } });
    expect(rows.length).toBe(1); // reactivated, not duplicated
    expect(rows[0].leftAt).toBeNull();
    const list = await groupService.listMembers(house.id);
    expect(list.find((m) => m.id === member.id)!.active).toBe(true);
    void admin;
  });

  // Spec 006 fix round 1: with promotion in the app a kicked admin could rejoin with the join code
  // and silently get ADMIN back, so a kick of an admin wouldn't stick.
  it("a kicked ex-admin who rejoins with the code comes back as MEMBER (the kick sticks)", async () => {
    const { users: [admin, member], house } = await seedHouse(["ADMIN", "MEMBER"]);
    await groupService.promoteToAdmin(house.id, admin.id, member.publicId);
    await groupService.removeMember(house.id, member.id); // allowed: `admin` is still an active admin

    const result = await groupService.joinByCode(member.id, house.joinCode!);
    expect("error" in result).toBe(false);

    const row = await prisma.groupMember.findUnique({ where: { userId_groupId: { userId: member.id, groupId: house.id } } });
    expect(row!.leftAt).toBeNull();
    expect(row!.role).toBe("MEMBER");
    const adminRow = await prisma.groupMember.findUnique({ where: { userId_groupId: { userId: admin.id, groupId: house.id } } });
    expect(adminRow!.role).toBe("ADMIN"); // the real admin is untouched
  });

  it("an ex-admin rejoining a house that has no active admin gets ADMIN (a house is never left without one)", async () => {
    const { users: [admin], house } = await seedHouse(["ADMIN"]);
    await groupService.removeMember(house.id, admin.id); // the last member can always leave
    expect(await prisma.groupMember.count({ where: { groupId: house.id, role: "ADMIN", leftAt: null } })).toBe(0);

    await groupService.joinByCode(admin.id, house.joinCode!);

    const row = await prisma.groupMember.findUnique({ where: { userId_groupId: { userId: admin.id, groupId: house.id } } });
    expect(row!.leftAt).toBeNull();
    expect(row!.role).toBe("ADMIN");
  });

  it("an ex-member (never admin) rejoining a house that has no active admin becomes ADMIN", async () => {
    const { users: [admin, member], house } = await seedHouse(["ADMIN", "MEMBER"]);
    await groupService.removeMember(house.id, member.id);
    await groupService.removeMember(house.id, admin.id); // now the last active member, so allowed
    expect(await prisma.groupMember.count({ where: { groupId: house.id, leftAt: null } })).toBe(0);

    await groupService.joinByCode(member.id, house.joinCode!);

    const row = await prisma.groupMember.findUnique({ where: { userId_groupId: { userId: member.id, groupId: house.id } } });
    expect(row!.leftAt).toBeNull();
    expect(row!.role).toBe("ADMIN");
  });

  it("a brand-new user joining a house whose only admin left becomes ADMIN (a house is never left without one)", async () => {
    const { users: [admin], house } = await seedHouse(["ADMIN"]);
    await groupService.removeMember(house.id, admin.id); // the last member can always leave
    expect(await prisma.groupMember.count({ where: { groupId: house.id, role: "ADMIN", leftAt: null } })).toBe(0);
    const newcomer = await prisma.user.create({ data: { publicId: randomUUID(), name: "Newcomer", username: "newcomer-mem" } });

    const result = await groupService.joinByCode(newcomer.id, house.joinCode!);
    expect("error" in result).toBe(false);

    const row = await prisma.groupMember.findUnique({ where: { userId_groupId: { userId: newcomer.id, groupId: house.id } } });
    expect(row!.leftAt).toBeNull();
    expect(row!.role).toBe("ADMIN");
  });

  it("a brand-new user joining a house that has an active admin becomes MEMBER", async () => {
    const { house } = await seedHouse(["ADMIN"]);
    const newcomer = await prisma.user.create({ data: { publicId: randomUUID(), name: "Newcomer", username: "newcomer-mem" } });

    await groupService.joinByCode(newcomer.id, house.joinCode!);

    const row = await prisma.groupMember.findUnique({ where: { userId_groupId: { userId: newcomer.id, groupId: house.id } } });
    expect(row!.role).toBe("MEMBER");
  });

  it("an ex-member is excluded from allActiveGroupMembers but still passes allGroupMembers (settlements stay possible)", async () => {
    const { users: [admin, member], house } = await seedHouse(["ADMIN", "MEMBER"]);
    await groupService.removeMember(house.id, member.id);
    expect(await allActiveGroupMembers(house.id, [member.id])).toBe(false);
    expect(await allGroupMembers(house.id, [member.id])).toBe(true);
    void admin;
  });

  it("a left/kicked user no longer resolves as a member for requireActiveGroup-style lookups (listForUser excludes it)", async () => {
    const { users: [admin, member], house } = await seedHouse(["ADMIN", "MEMBER"]);
    await groupService.removeMember(house.id, member.id);
    const houses = await groupService.listForUser(member.id);
    expect(houses.find((g) => g.id === house.id)).toBeUndefined();
    void admin;
  });

  it("promoteToAdmin: an admin promotes an active member, recorded as a GroupMember revision (spec 006)", async () => {
    const { users: [admin, member], house } = await seedHouse(["ADMIN", "MEMBER"]);
    await runWithAuditContext({ actorId: admin.id, groupId: house.id }, () =>
      groupService.promoteToAdmin(house.id, admin.id, member.publicId)
    );
    await flushAudit();
    const row = await prisma.groupMember.findUnique({ where: { userId_groupId: { userId: member.id, groupId: house.id } } });
    expect(row!.role).toBe("ADMIN");
    const rev = await prisma.entityRevision.findFirst({
      where: { entityType: "GroupMember", entityId: String(row!.id), action: "UPDATE" },
    });
    expect(rev).not.toBeNull();
    expect(rev!.groupId).toBe(house.id);
    expect(rev!.actorId).toBe(admin.id);
    expect((rev!.after as Record<string, unknown>).role).toBe("ADMIN");
  });

  it("promoteToAdmin: a non-admin is refused with 403 NOT_ADMIN and nothing changes", async () => {
    const { users: [, member, other], house } = await seedHouse(["ADMIN", "MEMBER", "MEMBER"]);
    await expect(groupService.promoteToAdmin(house.id, member.id, other.publicId))
      .rejects.toMatchObject({ status: 403, code: "NOT_ADMIN" });
    const row = await prisma.groupMember.findUnique({ where: { userId_groupId: { userId: other.id, groupId: house.id } } });
    expect(row!.role).toBe("MEMBER");
  });

  it("promoteToAdmin: a user of another house is 404 MEMBER_NOT_FOUND (tenant isolation)", async () => {
    const { users: [admin], house } = await seedHouse(["ADMIN", "MEMBER"]);
    const outsider = await prisma.user.create({ data: { publicId: randomUUID(), name: "Out", username: "out-mem" } });
    const otherHouse = await prisma.group.create({ data: { publicId: randomUUID(), name: "Other House" } });
    await prisma.groupMember.create({ data: { userId: outsider.id, groupId: otherHouse.id, role: "MEMBER", colorIndex: 0 } });
    await expect(groupService.promoteToAdmin(house.id, admin.id, outsider.publicId))
      .rejects.toMatchObject({ status: 404, code: "MEMBER_NOT_FOUND" });
    const row = await prisma.groupMember.findUnique({ where: { userId_groupId: { userId: outsider.id, groupId: otherHouse.id } } });
    expect(row!.role).toBe("MEMBER");
  });

  it("promoteToAdmin: an ex-member is 404 MEMBER_NOT_FOUND", async () => {
    const { users: [admin, member], house } = await seedHouse(["ADMIN", "MEMBER"]);
    await groupService.removeMember(house.id, member.id);
    await expect(groupService.promoteToAdmin(house.id, admin.id, member.publicId))
      .rejects.toMatchObject({ status: 404, code: "MEMBER_NOT_FOUND" });
  });

  it("lastAdminGroupIds: flags the only admin with other members, clears after a promotion, ignores a solo house", async () => {
    const { users: [admin, member], house } = await seedHouse(["ADMIN", "MEMBER"]);
    const solo = await prisma.group.create({ data: { publicId: randomUUID(), name: "Solo" } });
    await prisma.groupMember.create({ data: { userId: admin.id, groupId: solo.id, role: "ADMIN", colorIndex: 0 } });
    expect(await groupService.lastAdminGroupIds(admin.id)).toEqual([house.id]);
    await groupService.promoteToAdmin(house.id, admin.id, member.publicId);
    expect(await groupService.lastAdminGroupIds(admin.id)).toEqual([]);
  });

  // Spec 009 final review: a notice outlived the membership, so a member who left (or was kicked) and rejoined found
  // their old notices of that house back in the center.
  it("leaving or being kicked deletes that member's notices of that house only; a rejoin starts with an empty center", async () => {
    const { users: [admin, member], house } = await seedHouse(["ADMIN", "MEMBER"]);
    const elsewhere = await prisma.group.create({ data: { publicId: randomUUID(), name: "Elsewhere" } });
    await prisma.groupMember.create({ data: { userId: member.id, groupId: elsewhere.id, role: "ADMIN", colorIndex: 0 } });
    const notice = (userId: number, groupId: number) => ({
      publicId: randomUUID(), userId, groupId, type: "EXPENSE_NEW" as const, actorId: null, params: { description: "Rent", amount: "10.00" },
    });
    await prisma.notification.createMany({
      data: [notice(member.id, house.id), notice(member.id, house.id), notice(member.id, elsewhere.id), notice(admin.id, house.id)],
    });

    await groupService.removeMember(house.id, member.id); // the same path serves leave and kick

    const left = await prisma.notification.findMany({ select: { userId: true, groupId: true } });
    expect(left).toEqual(expect.arrayContaining([{ userId: member.id, groupId: elsewhere.id }, { userId: admin.id, groupId: house.id }]));
    expect(left).toHaveLength(2);

    await groupService.joinByCode(member.id, house.joinCode!);
    expect(await notificationService.list(member.id, house.id, { unreadOnly: false })).toEqual({ notifications: [], unreadCount: 0 });
  });

  it("a refused leave (409 LAST_ADMIN) keeps the member's notices", async () => {
    const { users: [admin, member], house } = await seedHouse(["ADMIN", "MEMBER"]);
    await prisma.notification.create({
      data: { publicId: randomUUID(), userId: admin.id, groupId: house.id, type: "DEBT_REMINDER", params: { amount: "5.00" } },
    });

    await expect(groupService.removeMember(house.id, admin.id)).rejects.toMatchObject({ status: 409, code: "LAST_ADMIN" });

    expect(await prisma.notification.count({ where: { userId: admin.id, groupId: house.id } })).toBe(1);
    void member;
  });
});

// BL-23: account deletion anonymizes the User row in place (never a real delete — Expense/
// Settlement FKs point at User.id) and soft-leaves every house the account is active in.
describe("account deletion (integration, real pglite DB)", () => {
  beforeEach(reset);

  async function seedUserWithPassword(name: string, username: string) {
    return prisma.user.create({
      data: { publicId: randomUUID(), name, username, password: "hashed-irrelevant-for-these-tests" },
    });
  }

  it("wrong current password is refused, nothing changes", async () => {
    const u = await seedUserWithPassword("Deletable", "deletable1");
    const result = await authService.deleteAccount(u.id, "definitely-wrong");
    expect(result).toMatchObject({ code: "CURRENT_PASSWORD_INVALID" });
    const row = await prisma.user.findUnique({ where: { id: u.id } });
    expect(row!.name).toBe("Deletable");
    expect(row!.deletedAt).toBeNull();
  });

  it("refuses when the account is the sole admin of a house with other active members (409 LAST_ADMIN), nothing changes", async () => {
    const admin = await prisma.user.create({ data: { publicId: randomUUID(), name: "SoleAdmin", username: "sole-admin1" } });
    const member = await prisma.user.create({ data: { publicId: randomUUID(), name: "Other", username: "other-mem1" } });
    const house = await prisma.group.create({ data: { publicId: randomUUID(), name: "H" } });
    await prisma.groupMember.createMany({
      data: [
        { userId: admin.id, groupId: house.id, role: "ADMIN", colorIndex: 0 },
        { userId: member.id, groupId: house.id, role: "MEMBER", colorIndex: 1 },
      ],
    });

    const result = await authService.deleteAccount(admin.id, undefined);
    expect(result).toMatchObject({ code: "LAST_ADMIN" });

    const userRow = await prisma.user.findUnique({ where: { id: admin.id } });
    expect(userRow!.name).toBe("SoleAdmin"); // untouched
    expect(userRow!.deletedAt).toBeNull();
    const memberRow = await prisma.groupMember.findUnique({ where: { userId_groupId: { userId: admin.id, groupId: house.id } } });
    expect(memberRow!.leftAt).toBeNull(); // untouched
  });

  it("anonymizes name/username/email, clears password/googleId, and leaves every active house", async () => {
    const u = await prisma.user.create({
      data: {
        publicId: randomUUID(),
        name: "Real Name",
        username: "realname1",
        email: "real@example.com",
        emailVerified: true,
        password: "hashed",
        googleId: "google-123",
      },
    });
    const houseA = await prisma.group.create({ data: { publicId: randomUUID(), name: "A" } });
    const houseB = await prisma.group.create({ data: { publicId: randomUUID(), name: "B" } });
    // Sole member of both (no other admins to conflict with) — deletion must succeed cleanly.
    await prisma.groupMember.createMany({
      data: [
        { userId: u.id, groupId: houseA.id, role: "ADMIN", colorIndex: 0 },
        { userId: u.id, groupId: houseB.id, role: "ADMIN", colorIndex: 0 },
      ],
    });

    const result = await authService.deleteAccount(u.id, "hashed" /* not actually verified against the fake hash, see note below */);
    // The fake "hashed" password above isn't a real bcrypt hash, so verifyPassword will correctly
    // reject it — assert the REAL behavior (refusal) here, then re-run with no password set at all
    // to exercise the actual anonymization path below.
    expect(result).toMatchObject({ code: "CURRENT_PASSWORD_INVALID" });

    // Re-seed a passwordless account (Google-only) to exercise the success path without needing a
    // real bcrypt hash in the test.
    const g = await prisma.user.create({
      data: { publicId: randomUUID(), name: "Google User", username: "googleuser1", email: "g@example.com", googleId: "google-456" },
    });
    const houseC = await prisma.group.create({ data: { publicId: randomUUID(), name: "C" } });
    await prisma.groupMember.create({ data: { userId: g.id, groupId: houseC.id, role: "ADMIN", colorIndex: 0 } });

    const success = await authService.deleteAccount(g.id, undefined);
    expect(success).toMatchObject({ ok: true });

    const row = await prisma.user.findUnique({ where: { id: g.id } });
    expect(row!.name).toBe("Deleted user");
    expect(row!.username).toBe(`deleted_user_${g.id}`);
    expect(row!.email).toBeNull();
    expect(row!.emailVerified).toBe(false);
    expect(row!.password).toBeNull();
    expect(row!.googleId).toBeNull();
    expect(row!.deletedAt).not.toBeNull();

    const membership = await prisma.groupMember.findUnique({ where: { userId_groupId: { userId: g.id, groupId: houseC.id } } });
    expect(membership!.leftAt).not.toBeNull();
  });
});

// Real-Postgres-only behaviors (BL-20/P3 — expense list's server-side filters, needed for the
// List view's infinite scroll): `hasSome` on array columns and `mode: 'insensitive'` are Postgres/
// Prisma feature interactions a mocked unit test can't actually verify.
describe("expense list filters + totalAmount aggregate (integration, real pglite DB)", () => {
  beforeEach(reset);

  async function seedHouseWithVariedExpenses() {
    const ana = await prisma.user.create({ data: { publicId: randomUUID(), name: "Ana", username: "ana" } });
    const bob = await prisma.user.create({ data: { publicId: randomUUID(), name: "Bob", username: "bob" } });
    const house = await prisma.group.create({ data: { publicId: randomUUID(), name: "House" } });
    await prisma.groupMember.createMany({
      data: [
        { userId: ana.id, groupId: house.id, role: "ADMIN", colorIndex: 0 },
        { userId: bob.id, groupId: house.id, role: "MEMBER", colorIndex: 1 },
      ],
    });

    await expenseService.create(house.id, [ana.id, bob.id], {
      payerId: ana.id, description: "Uber ride", amount: 30, platforms: ["uber"], date: new Date("2026-01-05T12:00:00"), splitEqually: true,
    });
    await expenseService.create(house.id, [ana.id, bob.id], {
      payerId: bob.id, description: "Groceries", amount: 70, categories: ["groceries"], paymentMethods: ["pix"], date: new Date("2026-02-10T12:00:00"), splitEqually: true,
    });
    await expenseService.create(house.id, [ana.id, bob.id], {
      payerId: ana.id, description: "Netflix", notes: "monthly subscription", amount: 40, date: new Date("2026-02-20T12:00:00"), splitEqually: true,
    });

    return { ana, bob, house };
  }

  it("filters by payerId (`in`)", async () => {
    const { ana, house } = await seedHouseWithVariedExpenses();
    const result = await expenseService.list(house.id, { ...listParams, filters: { payerIds: [ana.id] } });
    expect(result.expenses.map(e => e.description).sort()).toEqual(["Netflix", "Uber ride"]);
    expect(result.pagination.total).toBe(2);
  });

  it("filters by platform tag (`hasSome` on the array column)", async () => {
    const { house } = await seedHouseWithVariedExpenses();
    const result = await expenseService.list(house.id, { ...listParams, filters: { platforms: ["uber"] } });
    expect(result.expenses).toHaveLength(1);
    expect(result.expenses[0].description).toBe("Uber ride");
  });

  it("free-text query matches description OR notes OR payer name, case-insensitively", async () => {
    const { house } = await seedHouseWithVariedExpenses();
    const byDescription = await expenseService.list(house.id, { ...listParams, filters: { query: "NETFLIX" } });
    expect(byDescription.expenses.map(e => e.description)).toEqual(["Netflix"]);

    const byNotes = await expenseService.list(house.id, { ...listParams, filters: { query: "subscription" } });
    expect(byNotes.expenses.map(e => e.description)).toEqual(["Netflix"]);

    const byPayerName = await expenseService.list(house.id, { ...listParams, filters: { query: "bob" } });
    expect(byPayerName.expenses.map(e => e.description)).toEqual(["Groceries"]);
  });

  it("filters by date range (gte/lte, inclusive of the whole day)", async () => {
    const { house } = await seedHouseWithVariedExpenses();
    const result = await expenseService.list(house.id, {
      ...listParams,
      filters: { fromDate: new Date("2026-02-01T00:00:00"), toDate: new Date("2026-02-28T23:59:59") },
    });
    expect(result.expenses.map(e => e.description).sort()).toEqual(["Groceries", "Netflix"]);
  });

  it("combines two filter dimensions with AND semantics", async () => {
    const { bob, house } = await seedHouseWithVariedExpenses();
    const result = await expenseService.list(house.id, {
      ...listParams,
      filters: { payerIds: [bob.id], paymentMethods: ["pix"] },
    });
    expect(result.expenses.map(e => e.description)).toEqual(["Groceries"]);
  });

  it("totalAmount sums every matching row, not just the current page", async () => {
    const { house } = await seedHouseWithVariedExpenses();
    const onePerPage = await expenseService.list(house.id, { page: 1, pageSize: 1, sortField: "date", sortDirection: "desc" });
    expect(onePerPage.expenses).toHaveLength(1); // only one row on this page...
    expect(Number(onePerPage.pagination.totalAmount)).toBeCloseTo(140); // ...but the sum covers all 3 (30+70+40)
  });

  it("stable id-tiebreak means paging through 2 rows at a time never repeats or skips a row", async () => {
    const { house } = await seedHouseWithVariedExpenses();
    const page1 = await expenseService.list(house.id, { page: 1, pageSize: 2, sortField: "amount", sortDirection: "asc" });
    const page2 = await expenseService.list(house.id, { page: 2, pageSize: 2, sortField: "amount", sortDirection: "asc" });
    const seenIds = [...page1.expenses, ...page2.expenses].map(e => e.id);
    expect(new Set(seenIds).size).toBe(3);
  });

  it("month totals cover every matching expense beyond the loaded page, respect filters and the house (B5)", async () => {
    const { ana, bob, house } = await seedHouseWithVariedExpenses();
    // Seed: Jan 30 (Ana) · Feb 70 (Bob) · Feb 40 (Ana). One more Feb cent-sized expense proves exactness.
    await expenseService.create(house.id, [ana.id, bob.id], {
      payerId: bob.id, description: "Gum", amount: 0.1, date: new Date("2026-02-25T12:00:00"), splitEqually: true,
    });
    // Another house's February expense must never leak into these totals.
    const carol = await prisma.user.create({ data: { publicId: randomUUID(), name: "Carol", username: "carol" } });
    const other = await prisma.group.create({ data: { publicId: randomUUID(), name: "Other" } });
    await prisma.groupMember.create({ data: { userId: carol.id, groupId: other.id, role: "ADMIN", colorIndex: 0 } });
    await expenseService.create(other.id, [carol.id], {
      payerId: carol.id, description: "Foreign", amount: 999, date: new Date("2026-02-15T12:00:00"), splitEqually: true,
    });

    const page1 = await expenseService.list(house.id, {
      page: 1, pageSize: 1, sortField: "date", sortDirection: "desc", includeMonthTotals: true,
    });
    expect(page1.expenses).toHaveLength(1);
    expect(page1.pagination.monthTotals).toHaveLength(2);
    expect(page1.pagination.monthTotals).toEqual(expect.arrayContaining([
      { month: "2026-02", totalAmount: "110.10" },
      { month: "2026-01", totalAmount: "30.00" },
    ]));
    expect(page1.pagination.payerMonthTotals).toHaveLength(3);
    expect(page1.pagination.payerMonthTotals).toEqual(expect.arrayContaining([
      { payerId: ana.id, month: "2026-02", totalAmount: "40.00" },
      { payerId: bob.id, month: "2026-02", totalAmount: "70.10" },
      { payerId: ana.id, month: "2026-01", totalAmount: "30.00" },
    ]));

    const anaOnly = await expenseService.list(house.id, {
      page: 1, pageSize: 1, sortField: "date", sortDirection: "desc", includeMonthTotals: true,
      filters: { payerIds: [ana.id] },
    });
    expect(anaOnly.pagination.monthTotals).toHaveLength(2);
    expect(anaOnly.pagination.monthTotals).toEqual(expect.arrayContaining([
      { month: "2026-02", totalAmount: "40.00" },
      { month: "2026-01", totalAmount: "30.00" },
    ]));

    const plain = await expenseService.list(house.id, listParams);
    expect(plain.pagination).not.toHaveProperty("monthTotals");
    expect(plain.pagination).not.toHaveProperty("payerMonthTotals");
  });
});

// Spec 008 — the recurring-expense service on a real database: rules (task 6), control (task 7) and the
// idempotent poster (task 8). Clock and timezone are inputs, so every date below is deterministic.
describe("recurring expenses (spec 008, integration, real pglite DB)", () => {
  beforeEach(reset);
  afterEach(() => {
    requestCookies.session = undefined;
  });

  const svc = recurringExpenseService;
  const SP = "America/Sao_Paulo";
  /** 15:00 UTC = noon in São Paulo: the same calendar day in both. */
  const noonSP = (day: string) => new Date(`${day}T15:00:00Z`);
  /** The server-side noon convention a posted expense's date follows. */
  const noonLocal = (day: string) => new Date(`${day}T12:00:00`).getTime();
  const cents = (value: unknown) => toCents(String(value));

  async function seed() {
    const seeded = await seedTwoHouses();
    // House A: Ana (admin), Bob, Dan — in this membership order. House B: Carol (admin).
    const dan = await prisma.user.create({ data: { publicId: randomUUID(), name: "Dan", username: "dan" } });
    await prisma.groupMember.create({ data: { userId: dan.id, groupId: seeded.houseA.id, role: "MEMBER", colorIndex: 2 } });
    return {
      ...seeded,
      dan,
      asAna: { userId: seeded.ana.id, role: "ADMIN" as const },
      asBob: { userId: seeded.bob.id, role: "MEMBER" as const },
      asDan: { userId: dan.id, role: "MEMBER" as const },
      asCarol: { userId: seeded.carol.id, role: "ADMIN" as const },
    };
  }

  const rent = (payerId: number, extra: Record<string, unknown> = {}) => ({
    description: "Rent", amount: 1800, dayOfMonth: 5, payerId, splitMode: "ALL", timezone: SP, ...extra,
  });

  const leave = (userId: number, groupId: number) =>
    prisma.groupMember.update({ where: { userId_groupId: { userId, groupId } }, data: { leftAt: new Date() } });

  const postedExpenses = (recurringExpenseId: number) =>
    prisma.expense.findMany({
      where: { recurringExpenseId },
      include: { participants: { orderBy: { userId: "asc" } } },
      orderBy: { date: "asc" },
    });

  const ledger = (recurringExpenseId: number) =>
    prisma.recurringExpenseOccurrence.findMany({ where: { recurringExpenseId }, orderBy: { id: "asc" } });

  const split = (expense: { participants: { userId: number; amount: unknown }[] }) =>
    expense.participants.map((p) => [p.userId, cents(p.amount)]);

  const signIn = (user: { id: number; publicId: string; name: string }) =>
    signSession({ userId: user.id, publicId: user.publicId, name: user.name, sessionVersion: 0 });

  // ── Task 6: create, list ─────────────────────────────────────────────────────────────────────────

  it("create stores the rule in the active house and returns it with its next 3 upcoming periods (criteria 1, 6)", async () => {
    const { ana, houseA, asAna } = await seed();
    const { id, rule } = await svc.create(houseA.id, asAna, rent(ana.id, { description: "  Rent  ", dayOfMonth: 10 }), noonSP("2026-10-05"));

    expect(rule).toMatchObject({
      description: "Rent", amount: "1800.00", dayOfMonth: 10, payerId: ana.id, splitMode: "ALL", participantIds: [],
      timezone: SP, activeFrom: "2026-10-05", paused: false, pauseReason: null, skippedPeriods: [],
      lastClosedPeriod: null, canManage: true,
    });
    expect(rule.upcoming).toEqual([
      { period: "2026-10", dueOn: "2026-10-10", skipped: false },
      { period: "2026-11", dueOn: "2026-11-10", skipped: false },
      { period: "2026-12", dueOn: "2026-12-10", skipped: false },
    ]);
    const stored = await prisma.recurringExpense.findUniqueOrThrow({ where: { id } });
    expect(stored).toMatchObject({ groupId: houseA.id, createdById: ana.id, publicId: rule.publicId });
    expect(rule.updatedAt).toBe(stored.updatedAt.toISOString());
  });

  it("a rule created after this month's due day starts next month: no back-fill (criterion 6)", async () => {
    const { ana, houseA, asAna } = await seed();
    const { id, rule } = await svc.create(houseA.id, asAna, rent(ana.id, { dayOfMonth: 3 }), noonSP("2026-10-05"));
    expect(rule.upcoming[0]).toEqual({ period: "2026-11", dueOn: "2026-11-03", skipped: false });
    expect((await svc.postDue(noonSP("2026-10-05"))).posted).toBe(0);
    expect(await ledger(id)).toHaveLength(0);
  });

  it("'today' at creation is the calendar date in the rule's timezone, stored under its canonical IANA name (criterion 5)", async () => {
    const { ana, houseA, asAna } = await seed();
    const now = new Date("2026-10-05T02:30:00Z");
    const sp = await svc.create(houseA.id, asAna, rent(ana.id, { timezone: "america/sao_paulo" }), now);
    const tokyo = await svc.create(houseA.id, asAna, rent(ana.id, { timezone: "Asia/Tokyo" }), now);
    expect(sp.rule).toMatchObject({ timezone: "America/Sao_Paulo", activeFrom: "2026-10-04" });
    expect(tokyo.rule.activeFrom).toBe("2026-10-05");
  });

  it("rejects payers or participants who are not active members of the active house — another house's member included — and creates nothing (criterion 2)", async () => {
    const { ana, bob, carol, houseA, asAna } = await seed();
    await leave(bob.id, houseA.id);
    const now = noonSP("2026-10-05");
    for (const input of [
      rent(bob.id),
      rent(carol.id),
      rent(999_999),
      rent(ana.id, { splitMode: "SELECTED", participantIds: [ana.id, carol.id] }),
      rent(ana.id, { splitMode: "SELECTED", participantIds: [bob.id] }),
    ]) {
      await expect(svc.create(houseA.id, asAna, input, now)).rejects.toMatchObject({ status: 400, code: "RECURRING_MEMBER_INACTIVE" });
    }
    await expect(svc.create(houseA.id, asAna, rent(ana.id, { amount: 0 }), now)).rejects.toMatchObject({ status: 400, code: "AMOUNT_INVALID" });
    expect(await prisma.recurringExpense.count()).toBe(0);
  });

  it("the 51st rule of a house gets 409 RECURRING_LIMIT_REACHED; another house is not affected (criterion 3)", async () => {
    const { ana, carol, houseA, houseB, asAna, asCarol } = await seed();
    await prisma.recurringExpense.createMany({
      data: Array.from({ length: 50 }, (_, i) => ({
        publicId: randomUUID(), groupId: houseA.id, payerId: ana.id, description: `Rule ${i}`, amount: 10,
        dayOfMonth: 5, timezone: SP, activeFrom: new Date("2026-10-01T00:00:00Z"),
      })),
    });
    await expect(svc.create(houseA.id, asAna, rent(ana.id), noonSP("2026-10-05"))).rejects.toMatchObject({
      status: 409, code: "RECURRING_LIMIT_REACHED",
    });
    expect(await prisma.recurringExpense.count({ where: { groupId: houseA.id } })).toBe(50);
    await expect(svc.create(houseB.id, asCarol, rent(carol.id), noonSP("2026-10-05"))).resolves.toBeTruthy();
  });

  it("list returns only the active house's rules with an exact integer-cents summary and per-viewer canManage (criterion 4)", async () => {
    const { ana, bob, dan, carol, houseA, houseB, asAna, asBob, asDan, asCarol } = await seed();
    const now = noonSP("2026-10-05");
    await svc.create(houseA.id, asAna, rent(ana.id, { description: "Internet", amount: 100, dayOfMonth: 20 }), now);
    await svc.create(houseA.id, asBob, rent(bob.id, { description: "Gas", amount: 50.01, dayOfMonth: 20, splitMode: "SELECTED", participantIds: [bob.id, dan.id] }), now);
    const gym = await svc.create(houseA.id, asAna, rent(ana.id, { description: "Gym", amount: 70, dayOfMonth: 20 }), now);
    await prisma.recurringExpense.update({ where: { id: gym.id }, data: { pausedAt: now, pauseReason: "MANUAL" } });
    await svc.create(houseB.id, asCarol, rent(carol.id, { description: "Foreign" }), now);

    const forAna = await svc.list(houseA.id, asAna, now);
    expect(forAna.rules.map((r) => r.description)).toEqual(["Internet", "Gas", "Gym"]);
    // 100.00 ÷ 3 = 33.34 / 33.33 / 33.33 (Ana, Bob, Dan); 50.01 ÷ 2 = 25.01 / 25.00 (Bob, Dan); Gym is paused.
    expect(forAna.summary).toEqual({ monthlyTotal: "150.01", myMonthlyShare: "33.34", activeCount: 2, pausedCount: 1 });
    expect((await svc.list(houseA.id, asBob, now)).summary.myMonthlyShare).toBe("58.34");
    expect((await svc.list(houseA.id, asDan, now)).summary.myMonthlyShare).toBe("58.33");
    expect(forAna.rules.find((r) => r.description === "Gym")).toMatchObject({ paused: true, pauseReason: "MANUAL", upcoming: [] });
    expect(forAna.rules.every((r) => r.canManage)).toBe(true);
    expect((await svc.list(houseA.id, asBob, now)).rules.map((r) => [r.description, r.canManage])).toEqual([
      ["Internet", false], ["Gas", true], ["Gym", false],
    ]);

    const forCarol = await svc.list(houseB.id, asCarol, now);
    expect(forCarol.rules.map((r) => r.description)).toEqual(["Foreign"]);
    expect(forCarol.summary).toEqual({ monthlyTotal: "1800.00", myMonthlyShare: "1800.00", activeCount: 1, pausedCount: 0 });
  });

  it("list history: the house's 50 most recent closed periods, newest first, posted and skipped (criterion 4)", async () => {
    const { ana, carol, houseA, houseB, asAna, asCarol } = await seed();
    const { id, rule } = await svc.create(houseA.id, asAna, rent(ana.id), noonSP("2021-01-01"));
    // 60 skipped months (2021-01 … 2025-12) straight in the ledger, then one real posting (2026-01).
    await prisma.recurringExpenseOccurrence.createMany({
      data: Array.from({ length: 60 }, (_, i) => {
        const period = addMonths("2021-01", i);
        return { recurringExpenseId: id, period, dueOn: new Date(`${period}-05T00:00:00Z`), status: "SKIPPED" as const };
      }),
    });
    expect((await svc.postDue(noonSP("2026-01-05"), { recurringExpenseId: id })).posted).toBe(1);
    const foreign = await svc.create(houseB.id, asCarol, rent(carol.id), noonSP("2026-01-01"));
    await svc.postDue(noonSP("2026-01-05"), { recurringExpenseId: foreign.id });

    const { history, rules } = await svc.list(houseA.id, asAna, noonSP("2026-01-06"));
    const [expense] = await postedExpenses(id);
    expect(history).toHaveLength(50);
    expect(history[0]).toEqual({
      period: "2026-01", dueOn: "2026-01-05", status: "POSTED",
      rule: { publicId: rule.publicId, description: "Rent" },
      expense: { publicId: expense.publicId, amount: "1800.00", payerId: ana.id, participantCount: 3 },
    });
    expect(history[1]).toMatchObject({ period: "2025-12", status: "SKIPPED", expense: null });
    expect(history[49].period).toBe("2021-12");
    expect(history.every((h) => h.rule.publicId === rule.publicId)).toBe(true);
    expect(rules[0].lastClosedPeriod).toBe("2026-01");
  });

  // ── Task 7: update, pause/resume, skip/unskip, delete, ownership ─────────────────────────────────

  it("update applies to periods not yet posted only; a stale expectedUpdatedAt gets 409, a missing one 400 (criterion 16)", async () => {
    const { ana, houseA, asAna } = await seed();
    const { id, rule } = await svc.create(houseA.id, asAna, rent(ana.id), noonSP("2026-10-01"));
    await svc.postDue(noonSP("2026-10-05"), { recurringExpenseId: id });

    const now = noonSP("2026-10-06");
    const edited = await svc.update(houseA.id, asAna, rule.publicId, { amount: 1900, description: "Rent + condo" }, rule.updatedAt, now);
    expect(edited.changed).toBe(true);
    expect(edited.rule).toMatchObject({ amount: "1900.00", description: "Rent + condo", lastClosedPeriod: "2026-10" });
    expect(edited.changes).toEqual({
      description: { from: "Rent", to: "Rent + condo" },
      amount: { from: "1800.00", to: "1900.00" },
    });
    const [october] = await postedExpenses(id);
    expect(october.description).toBe("Rent");
    expect(cents(october.amount)).toBe(180000);

    // The token the edit form had is now stale; a missing token is not a valid edit.
    await expect(svc.update(houseA.id, asAna, rule.publicId, { amount: 2000 }, rule.updatedAt, now)).rejects.toMatchObject({
      status: 409, code: "STALE_RECURRING_EXPENSE",
    });
    await expect(svc.update(houseA.id, asAna, rule.publicId, { amount: 2000 }, undefined, now)).rejects.toMatchObject({
      status: 400, code: "RECURRING_PATCH_INVALID",
    });
    expect(cents((await prisma.recurringExpense.findUniqueOrThrow({ where: { id } })).amount)).toBe(190000);

    // November posts with the new values; October stays as it was.
    await svc.postDue(noonSP("2026-11-05"));
    const [oct, nov] = await postedExpenses(id);
    expect([cents(oct.amount), cents(nov.amount)]).toEqual([180000, 190000]);
    expect(nov.description).toBe("Rent + condo");
  });

  it("update of the split and payer: newly introduced people must be active members of this house; the same values are a no-op", async () => {
    const { ana, bob, dan, carol, houseA, asAna } = await seed();
    const now = noonSP("2026-10-06");
    const { rule } = await svc.create(houseA.id, asAna, rent(ana.id), now);

    await expect(svc.update(houseA.id, asAna, rule.publicId, { payerId: carol.id }, rule.updatedAt, now)).rejects.toMatchObject({
      status: 400, code: "RECURRING_MEMBER_INACTIVE",
    });
    await expect(svc.update(houseA.id, asAna, rule.publicId, { splitMode: "SELECTED" }, rule.updatedAt, now)).rejects.toMatchObject({
      status: 400, code: "RECURRING_SPLIT_INVALID",
    });
    const selected = await svc.update(houseA.id, asAna, rule.publicId, { splitMode: "SELECTED", participantIds: [bob.id, dan.id] }, rule.updatedAt, now);
    expect(selected.rule).toMatchObject({ splitMode: "SELECTED", participantIds: [bob.id, dan.id] });
    expect(selected.changes).toEqual({ splitMode: { from: "ALL", to: "SELECTED" }, participantIds: { from: [], to: [bob.id, dan.id] } });
    // Dan leaves: still on the rule (grandfathered), but he cannot become its payer.
    await leave(dan.id, houseA.id);
    await expect(svc.update(houseA.id, asAna, rule.publicId, { payerId: dan.id }, selected.rule.updatedAt, now)).rejects.toMatchObject({
      status: 400, code: "RECURRING_MEMBER_INACTIVE",
    });
    // Bob leaves: payer of his own rule (grandfathered), but he cannot be added to its split.
    const bobs = await svc.create(houseA.id, asAna, rent(bob.id), now);
    await leave(bob.id, houseA.id);
    await expect(
      svc.update(houseA.id, asAna, bobs.rule.publicId, { splitMode: "SELECTED", participantIds: [ana.id, bob.id] }, bobs.rule.updatedAt, now)
    ).rejects.toMatchObject({ status: 400, code: "RECURRING_MEMBER_INACTIVE" });
    expect((await svc.update(houseA.id, asAna, bobs.rule.publicId, { amount: 1700 }, bobs.rule.updatedAt, now)).changed).toBe(true);

    const back = await svc.update(houseA.id, asAna, rule.publicId, { splitMode: "ALL" }, selected.rule.updatedAt, now);
    expect(back.rule.participantIds).toEqual([]);

    await flushAudit();
    const revisions = () => prisma.entityRevision.count({ where: { entityType: "RecurringExpense" } });
    const before = await revisions();
    const noop = await svc.update(houseA.id, asAna, rule.publicId, { description: "Rent", amount: 1800, dayOfMonth: 5 }, back.rule.updatedAt, now);
    expect(noop).toMatchObject({ changed: false, changes: {} });
    expect(noop.rule.updatedAt).toBe(back.rule.updatedAt);
    await flushAudit();
    expect(await revisions()).toBe(before);
  });

  it("pause is MANUAL and audited as the member; the same state is a no-op; resume restarts at the local today and re-validates members (criterion 14)", async () => {
    const { bob, houseA, asAna, asBob } = await seed();
    const { id, rule } = await svc.create(houseA.id, asBob, rent(bob.id), noonSP("2026-09-01"));

    const paused = await runWithAuditContext({ actorId: bob.id, groupId: houseA.id }, () =>
      svc.setPaused(houseA.id, asBob, rule.publicId, true, noonSP("2026-09-02"))
    );
    expect(paused).toMatchObject({ changed: true, rule: { paused: true, pauseReason: "MANUAL", upcoming: [] } });
    await flushAudit();
    const revision = await prisma.entityRevision.findFirstOrThrow({ where: { entityType: "RecurringExpense", entityId: String(id), action: "UPDATE" } });
    expect(revision.actorId).toBe(bob.id);
    expect((revision.after as Record<string, unknown>).pauseReason).toBe("MANUAL");

    const again = await svc.setPaused(houseA.id, asBob, rule.publicId, true, noonSP("2026-09-03"));
    expect(again.changed).toBe(false);
    expect(again.rule.updatedAt).toBe(paused.rule.updatedAt);
    expect((await svc.postDue(noonSP("2026-10-05"))).posted).toBe(0);

    // Resumed on Oct 20: Oct 5 is not back-filled, the next due date is Nov 5.
    const resumed = await svc.setPaused(houseA.id, asBob, rule.publicId, false, noonSP("2026-10-20"));
    expect(resumed.rule).toMatchObject({ paused: false, pauseReason: null, activeFrom: "2026-10-20" });
    expect(resumed.rule.upcoming[0]).toEqual({ period: "2026-11", dueOn: "2026-11-05", skipped: false });

    // A rule whose payer left cannot be resumed.
    await svc.setPaused(houseA.id, asAna, rule.publicId, true, noonSP("2026-10-21"));
    await leave(bob.id, houseA.id);
    await expect(svc.setPaused(houseA.id, asAna, rule.publicId, false, noonSP("2026-10-22"))).rejects.toMatchObject({
      status: 400, code: "RECURRING_MEMBER_INACTIVE",
    });
    expect((await prisma.recurringExpense.findUniqueOrThrow({ where: { id } })).pausedAt).not.toBeNull();
  });

  it("skip / unskip: only the next 3 upcoming periods, idempotent; a period with a ledger row gets 409 (criterion 15)", async () => {
    const { ana, houseA, asAna } = await seed();
    const { id, rule } = await svc.create(houseA.id, asAna, rent(ana.id), noonSP("2026-10-01"));
    const oct1 = noonSP("2026-10-01");

    const skipped = await svc.skip(houseA.id, asAna, rule.publicId, "2026-11", oct1);
    expect(skipped.changed).toBe(true);
    expect(skipped.rule.skippedPeriods).toEqual(["2026-11"]);
    expect(skipped.rule.upcoming.map((u) => [u.period, u.skipped])).toEqual([["2026-10", false], ["2026-11", true], ["2026-12", false]]);
    const again = await svc.skip(houseA.id, asAna, rule.publicId, "2026-11", oct1);
    expect(again.changed).toBe(false);
    expect(again.rule.updatedAt).toBe(skipped.rule.updatedAt);

    for (const period of ["2027-01", "2026-09", "2026-13", "2026-1", "garbage"]) {
      await expect(svc.skip(houseA.id, asAna, rule.publicId, period, oct1)).rejects.toMatchObject({ status: 400, code: "RECURRING_PERIOD_INVALID" });
    }

    await svc.postDue(noonSP("2026-10-05"), { recurringExpenseId: id });
    const oct5 = noonSP("2026-10-05");
    await expect(svc.skip(houseA.id, asAna, rule.publicId, "2026-10", oct5)).rejects.toMatchObject({ status: 409, code: "RECURRING_PERIOD_CLOSED" });
    await expect(svc.unskip(houseA.id, asAna, rule.publicId, "2026-10", oct5)).rejects.toMatchObject({ status: 409, code: "RECURRING_PERIOD_CLOSED" });

    const unskipped = await svc.unskip(houseA.id, asAna, rule.publicId, "2026-11", oct5);
    expect(unskipped.changed).toBe(true);
    expect(unskipped.rule.skippedPeriods).toEqual([]);
    expect((await svc.unskip(houseA.id, asAna, rule.publicId, "2026-11", oct5)).changed).toBe(false);
    // After October closed, January 2027 is now one of the next 3.
    expect((await svc.skip(houseA.id, asAna, rule.publicId, "2027-01", oct5)).rule.skippedPeriods).toEqual(["2027-01"]);
  });

  it("a concurrent skip and unskip of different months both land: the loser of the updatedAt race re-reads and retries", async () => {
    const { ana, houseA, asAna } = await seed();
    const { id, rule } = await svc.create(houseA.id, asAna, rent(ana.id), noonSP("2026-10-01"));
    const oct1 = noonSP("2026-10-01");
    await svc.skip(houseA.id, asAna, rule.publicId, "2026-11", oct1);

    // Both read skippedPeriods ["2026-11"] before either writes (their queries interleave).
    const [unskipped, skipped] = await Promise.all([
      svc.unskip(houseA.id, asAna, rule.publicId, "2026-11", oct1),
      svc.skip(houseA.id, asAna, rule.publicId, "2026-12", oct1),
    ]);
    expect([unskipped.changed, skipped.changed]).toEqual([true, true]);
    expect((await prisma.recurringExpense.findUniqueOrThrow({ where: { id } })).skippedPeriods).toEqual(["2026-12"]);
  });

  it("delete removes the rule and its ledger, keeps the posted expenses with recurringExpenseId null, posts nothing more (criterion 17)", async () => {
    const { ana, houseA, asAna } = await seed();
    const { id, rule } = await svc.create(houseA.id, asAna, rent(ana.id), noonSP("2026-10-01"));
    await svc.postDue(noonSP("2026-10-05"), { recurringExpenseId: id });
    const [posted] = await postedExpenses(id);

    expect(await svc.delete(houseA.id, asAna, rule.publicId)).toMatchObject({ publicId: rule.publicId, description: "Rent" });
    expect(await prisma.recurringExpense.count()).toBe(0);
    expect(await prisma.recurringExpenseOccurrence.count()).toBe(0);
    expect((await prisma.expense.findUniqueOrThrow({ where: { id: posted.id } })).recurringExpenseId).toBeNull();
    expect((await svc.postDue(noonSP("2026-11-05"))).posted).toBe(0);
    await expect(svc.get(houseA.id, asAna, rule.publicId, noonSP("2026-11-05"))).rejects.toMatchObject({ status: 404, code: "RECURRING_NOT_FOUND" });
  });

  it("a member who is neither payer nor admin gets 403; another house gets 404 for every action — and nothing changes (criterion 18)", async () => {
    const { ana, bob, houseA, houseB, asAna, asBob, asCarol } = await seed();
    const now = noonSP("2026-10-05");
    const { id, rule } = await svc.create(houseA.id, asAna, rent(ana.id), now);
    const attempts = (groupId: number, who: { userId: number; role: "ADMIN" | "MEMBER" }) => [
      () => svc.update(groupId, who, rule.publicId, { amount: 1 }, rule.updatedAt, now),
      () => svc.setPaused(groupId, who, rule.publicId, true, now),
      () => svc.skip(groupId, who, rule.publicId, "2026-11", now),
      () => svc.unskip(groupId, who, rule.publicId, "2026-11", now),
      () => svc.delete(groupId, who, rule.publicId),
    ];
    for (const attempt of attempts(houseA.id, asBob)) {
      await expect(attempt()).rejects.toMatchObject({ status: 403, code: "NOT_RECURRING_OWNER" });
    }
    for (const attempt of attempts(houseB.id, asCarol)) {
      await expect(attempt()).rejects.toMatchObject({ status: 404, code: "RECURRING_NOT_FOUND" });
    }
    await expect(svc.get(houseB.id, asCarol, rule.publicId, now)).rejects.toMatchObject({ status: 404, code: "RECURRING_NOT_FOUND" });
    await expect(svc.get(houseA.id, asAna, "not-a-uuid", now)).rejects.toMatchObject({ status: 404, code: "RECURRING_NOT_FOUND" });
    expect((await svc.list(houseB.id, asCarol, now)).rules).toEqual([]);
    const stored = await prisma.recurringExpense.findUniqueOrThrow({ where: { id } });
    expect(stored.updatedAt.toISOString()).toBe(rule.updatedAt);

    // The payer manages their own rule; an admin manages anyone's.
    const bobs = await svc.create(houseA.id, asBob, rent(bob.id), now);
    expect((await svc.setPaused(houseA.id, asBob, bobs.rule.publicId, true, now)).changed).toBe(true);
    expect((await svc.skip(houseA.id, asAna, bobs.rule.publicId, "2026-11", now)).changed).toBe(true);
  });

  // ── Task 8: postDue ──────────────────────────────────────────────────────────────────────────────

  it("posts one expense on the due day — content, noon date, exact split, ledger link — and a second run posts nothing (criteria 7, 8, 9)", async () => {
    const { ana, bob, dan, houseA, asAna } = await seed();
    const { id } = await svc.create(houseA.id, asAna, rent(ana.id, { amount: 100 }), noonSP("2026-10-01"));

    expect(await svc.postDue(noonSP("2026-10-04"))).toEqual({ posted: 0, skipped: 0, paused: 0, duplicates: 0, failed: 0, remaining: 0 });
    expect(await svc.postDue(noonSP("2026-10-05"))).toEqual({ posted: 1, skipped: 0, paused: 0, duplicates: 0, failed: 0, remaining: 0 });

    const [expense] = await postedExpenses(id);
    expect(expense).toMatchObject({ groupId: houseA.id, payerId: ana.id, description: "Rent", recurringExpenseId: id });
    expect(cents(expense.amount)).toBe(10000);
    expect(expense.date.getTime()).toBe(noonLocal("2026-10-05"));
    expect(split(expense)).toEqual([[ana.id, 3334], [bob.id, 3333], [dan.id, 3333]]);
    const rows = await ledger(id);
    expect(rows).toMatchObject([{ period: "2026-10", status: "POSTED", expenseId: expense.id }]);
    expect(rows[0].dueOn.toISOString().slice(0, 10)).toBe("2026-10-05");

    expect((await svc.postDue(noonSP("2026-10-05"))).posted).toBe(0);
    expect((await svc.postDue(noonSP("2026-10-06"))).posted).toBe(0);
    expect(await postedExpenses(id)).toHaveLength(1);
    // The summary share is exactly the share the posting wrote.
    expect((await svc.list(houseA.id, asAna, noonSP("2026-10-06"))).summary.myMonthlyShare).toBe("33.34");
  });

  it("concurrent runs never double-post the same (rule, period): the losers' claims find the row taken (criterion 9)", async () => {
    const { ana, houseA, asAna } = await seed();
    const { id } = await svc.create(houseA.id, asAna, rent(ana.id), noonSP("2026-10-01"));
    const now = noonSP("2026-10-05");

    // All three runs read an empty ledger before any of them claims (their queries interleave), so the
    // ledger's unique (rule, period) is what keeps the second and third from posting.
    const runs = await Promise.all([svc.postDue(now), svc.postDue(now), svc.postDue(now)]);
    expect(runs.map((r) => r.posted).sort()).toEqual([0, 0, 1]);
    expect(runs.reduce((sum, r) => sum + r.duplicates, 0)).toBe(2);
    expect(runs.reduce((sum, r) => sum + r.failed, 0)).toBe(0);
    expect(await postedExpenses(id)).toHaveLength(1);
    expect(await ledger(id)).toHaveLength(1);
  });

  it("a period that already has a ledger row (simulated duplicate delivery) yields no expense (criterion 9)", async () => {
    const { ana, houseA, asAna } = await seed();
    const { id } = await svc.create(houseA.id, asAna, rent(ana.id), noonSP("2026-10-01"));
    await prisma.recurringExpenseOccurrence.create({
      data: { recurringExpenseId: id, period: "2026-10", dueOn: new Date("2026-10-05T00:00:00Z"), status: "POSTED" },
    });

    expect(await svc.postDue(noonSP("2026-10-05"))).toMatchObject({ posted: 0, failed: 0 });
    expect(await postedExpenses(id)).toHaveLength(0);
    expect(await ledger(id)).toMatchObject([{ period: "2026-10", expenseId: null }]);
  });

  it("a rule edited after the run loaded it aborts that posting and rolls the claim back; the next run posts the new amount", async () => {
    const { ana, houseA, asAna } = await seed();
    const { id, rule } = await svc.create(houseA.id, asAna, rent(ana.id), noonSP("2026-10-01"));
    const staleRow = await prisma.recurringExpense.findUniqueOrThrow({ where: { id } });
    await svc.update(houseA.id, asAna, rule.publicId, { amount: 1900 }, rule.updatedAt, noonSP("2026-10-04"));

    const poster = svc as unknown as {
      postPeriod: (row: typeof staleRow, period: string, due: string, memberIds: number[]) => Promise<string>;
    };
    expect(await poster.postPeriod(staleRow, "2026-10", "2026-10-05", [ana.id])).toBe("aborted");
    expect(await ledger(id)).toHaveLength(0);
    expect(await postedExpenses(id)).toHaveLength(0);

    expect((await svc.postDue(noonSP("2026-10-05"))).posted).toBe(1);
    const [posted] = await postedExpenses(id);
    expect(cents(posted.amount)).toBe(190000);
  });

  it("an Undo skip that lands after the run loaded the rule aborts the SKIPPED write; the next run posts the month", async () => {
    const { ana, houseA, asAna } = await seed();
    const { id, rule } = await svc.create(houseA.id, asAna, rent(ana.id), noonSP("2026-10-01"));
    await svc.skip(houseA.id, asAna, rule.publicId, "2026-10", noonSP("2026-10-01"));
    // The run loads the rule with October skipped; the payer undoes the skip before its SKIPPED write.
    const staleRow = await prisma.recurringExpense.findUniqueOrThrow({ where: { id } });
    await svc.unskip(houseA.id, asAna, rule.publicId, "2026-10", noonSP("2026-10-05"));

    const result = { posted: 0, skipped: 0, paused: 0, duplicates: 0, failed: 0, remaining: 0 };
    const poster = svc as unknown as {
      postRule: (row: typeof staleRow, periods: string[], now: Date, result: Record<string, number>) => Promise<void>;
    };
    await poster.postRule(staleRow, ["2026-10"], noonSP("2026-10-05"), result);
    expect(result).toEqual({ posted: 0, skipped: 0, paused: 0, duplicates: 0, failed: 0, remaining: 0 });
    expect(await ledger(id)).toHaveLength(0);

    expect(await svc.postDue(noonSP("2026-10-05"))).toMatchObject({ posted: 1, skipped: 0, failed: 0 });
    expect((await ledger(id)).map((r) => r.status)).toEqual(["POSTED"]);
    expect(await postedExpenses(id)).toHaveLength(1);
  });

  it("catch-up: three missed months are posted oldest first, each dated on its own due date (criterion 7)", async () => {
    const { ana, houseA, asAna } = await seed();
    const { id } = await svc.create(houseA.id, asAna, rent(ana.id), noonSP("2026-07-01"));

    expect((await svc.postDue(noonSP("2026-10-05"))).posted).toBe(4);
    expect((await ledger(id)).map((r) => r.period)).toEqual(["2026-07", "2026-08", "2026-09", "2026-10"]);
    expect((await postedExpenses(id)).map((e) => e.date.getTime())).toEqual(
      ["2026-07-05", "2026-08-05", "2026-09-05", "2026-10-05"].map(noonLocal)
    );
  });

  it("catch-up is capped at 12 periods per rule per run; the next run continues", async () => {
    const { ana, houseA, asAna } = await seed();
    const { id } = await svc.create(houseA.id, asAna, rent(ana.id), noonSP("2025-01-01"));

    expect((await svc.postDue(noonSP("2026-10-05"))).posted).toBe(12);
    expect((await ledger(id)).at(-1)!.period).toBe("2025-12");
    expect((await svc.postDue(noonSP("2026-10-05"))).posted).toBe(10);
    expect((await ledger(id)).at(-1)!.period).toBe("2026-10");
  });

  it("month-end clamping: day 31 posts on Feb 28, Mar 31 and Apr 30; day 29 on Feb 29 of a leap year (criterion 5)", async () => {
    const { ana, houseA, asAna } = await seed();
    const day31 = await svc.create(houseA.id, asAna, rent(ana.id, { dayOfMonth: 31 }), noonSP("2027-02-01"));
    expect((await svc.postDue(noonSP("2027-02-27"))).posted).toBe(0);
    expect((await svc.postDue(noonSP("2027-02-28"))).posted).toBe(1);
    expect((await svc.postDue(noonSP("2027-04-30"))).posted).toBe(2);
    expect((await postedExpenses(day31.id)).map((e) => e.date.getTime())).toEqual(
      ["2027-02-28", "2027-03-31", "2027-04-30"].map(noonLocal)
    );

    const day29 = await svc.create(houseA.id, asAna, rent(ana.id, { dayOfMonth: 29 }), noonSP("2028-02-01"));
    await svc.postDue(noonSP("2028-02-29"), { recurringExpenseId: day29.id });
    expect((await postedExpenses(day29.id)).map((e) => e.date.getTime())).toEqual([noonLocal("2028-02-29")]);
  });

  it("'today' is the rule's local date: São Paulo, Tokyo, a half-hour zone and a DST change (criterion 5)", async () => {
    const { ana, houseA, asAna } = await seed();
    const sp = await svc.create(houseA.id, asAna, rent(ana.id, { description: "SP" }), new Date("2026-10-01T15:00:00Z"));
    const tokyo = await svc.create(houseA.id, asAna, rent(ana.id, { description: "Tokyo", timezone: "Asia/Tokyo" }), new Date("2026-10-01T03:00:00Z"));
    const kolkata = await svc.create(houseA.id, asAna, rent(ana.id, { description: "Kolkata", timezone: "Asia/Kolkata" }), new Date("2026-10-01T06:00:00Z"));
    const count = async (id: number) => (await postedExpenses(id)).length;

    // 18:29 UTC on Oct 4: 23:59 in Kolkata (UTC+05:30), 03:29 on Oct 5 in Tokyo, 15:29 on Oct 4 in São Paulo.
    await svc.postDue(new Date("2026-10-04T18:29:00Z"));
    expect([await count(sp.id), await count(tokyo.id), await count(kolkata.id)]).toEqual([0, 1, 0]);
    // 18:30 UTC: midnight in Kolkata.
    await svc.postDue(new Date("2026-10-04T18:30:00Z"));
    expect(await count(kolkata.id)).toBe(1);
    // 02:30 UTC on Oct 5 is still Oct 4 in São Paulo; 03:00 UTC is its midnight.
    await svc.postDue(new Date("2026-10-05T02:30:00Z"));
    expect(await count(sp.id)).toBe(0);
    await svc.postDue(new Date("2026-10-05T03:00:00Z"));
    expect(await count(sp.id)).toBe(1);

    // New York springs forward on 2027-03-14: midnight of Mar 15 is 04:00 UTC (EDT), not 05:00 (EST).
    const ny = await svc.create(houseA.id, asAna, rent(ana.id, { description: "NY", dayOfMonth: 15, timezone: "America/New_York" }), new Date("2027-03-01T17:00:00Z"));
    await svc.postDue(new Date("2027-03-15T03:59:00Z"), { recurringExpenseId: ny.id });
    expect(await count(ny.id)).toBe(0);
    await svc.postDue(new Date("2027-03-15T04:00:00Z"), { recurringExpenseId: ny.id });
    expect(await count(ny.id)).toBe(1);
  });

  it("a deleted posted expense is never posted again: the period stays closed (criterion 10)", async () => {
    const { ana, houseA, asAna } = await seed();
    const { id } = await svc.create(houseA.id, asAna, rent(ana.id), noonSP("2026-10-01"));
    await svc.postDue(noonSP("2026-10-05"));
    const [expense] = await postedExpenses(id);
    await expenseService.delete(houseA.id, expense.id, ana.id, true);

    expect((await svc.postDue(noonSP("2026-10-05"))).posted).toBe(0);
    expect((await svc.postDue(noonSP("2026-10-20"))).posted).toBe(0);
    expect(await postedExpenses(id)).toHaveLength(0);
    expect(await ledger(id)).toMatchObject([{ period: "2026-10", status: "POSTED", expenseId: null }]);
  });

  it("a skipped period records a SKIPPED ledger row and no expense; the next month posts (criterion 11)", async () => {
    const { ana, houseA, asAna } = await seed();
    const { id, rule } = await svc.create(houseA.id, asAna, rent(ana.id), noonSP("2026-10-01"));
    await svc.skip(houseA.id, asAna, rule.publicId, "2026-10", noonSP("2026-10-01"));

    expect(await svc.postDue(noonSP("2026-10-05"))).toMatchObject({ posted: 0, skipped: 1 });
    expect(await ledger(id)).toMatchObject([{ period: "2026-10", status: "SKIPPED", expenseId: null }]);
    expect(await postedExpenses(id)).toHaveLength(0);
    expect((await svc.postDue(noonSP("2026-10-06"))).skipped).toBe(0);
    const dto = await svc.get(houseA.id, asAna, rule.publicId, noonSP("2026-10-06"));
    expect(dto).toMatchObject({ lastClosedPeriod: "2026-10", skippedPeriods: [] });

    expect((await svc.postDue(noonSP("2026-11-05"))).posted).toBe(1);
  });

  it("paused rules post nothing; a resumed rule never back-fills the due dates it missed (criteria 6, 14)", async () => {
    const { ana, houseA, asAna } = await seed();
    const { id, rule } = await svc.create(houseA.id, asAna, rent(ana.id), noonSP("2026-10-01"));
    await svc.setPaused(houseA.id, asAna, rule.publicId, true, noonSP("2026-10-02"));

    expect(await svc.postDue(noonSP("2026-10-05"))).toEqual({ posted: 0, skipped: 0, paused: 0, duplicates: 0, failed: 0, remaining: 0 });
    await svc.setPaused(houseA.id, asAna, rule.publicId, false, noonSP("2026-10-20"));
    expect((await svc.postDue(noonSP("2026-10-20"))).posted).toBe(0);
    expect((await svc.postDue(noonSP("2026-11-05"))).posted).toBe(1);
    expect((await postedExpenses(id)).map((e) => e.date.getTime())).toEqual([noonLocal("2026-11-05")]);
  });

  it("resume drops the skipped months before its new activeFrom month: they never linger in the rule or its later revisions", async () => {
    const { ana, houseA, asAna } = await seed();
    const { id, rule } = await svc.create(houseA.id, asAna, rent(ana.id), noonSP("2026-10-01"));
    await svc.skip(houseA.id, asAna, rule.publicId, "2026-11", noonSP("2026-10-01"));
    await svc.skip(houseA.id, asAna, rule.publicId, "2026-12", noonSP("2026-10-01"));
    await svc.setPaused(houseA.id, asAna, rule.publicId, true, noonSP("2026-10-02"));

    // Paused through November (no ledger row for it); resumed on Dec 1, before December's due date.
    const resumed = await svc.setPaused(houseA.id, asAna, rule.publicId, false, noonSP("2026-12-01"));
    expect(resumed.rule).toMatchObject({ activeFrom: "2026-12-01", skippedPeriods: ["2026-12"] });
    expect((await prisma.recurringExpense.findUniqueOrThrow({ where: { id } })).skippedPeriods).toEqual(["2026-12"]);
    await flushAudit();
    const [latest] = await prisma.entityRevision.findMany({
      where: { entityType: "RecurringExpense", entityId: String(id), action: "UPDATE" },
      orderBy: { id: "desc" },
      take: 1,
    });
    expect((latest.after as Record<string, unknown>).skippedPeriods).toEqual(["2026-12"]);

    // December's skip still applies.
    expect(await svc.postDue(noonSP("2026-12-05"))).toMatchObject({ posted: 0, skipped: 1 });
  });

  it("payer left: nothing is posted, the rule is auto-paused MEMBER_LEFT by the system, no ledger row (criterion 12)", async () => {
    const { ana, bob, houseA, asAna } = await seed();
    const { id, rule } = await svc.create(houseA.id, asAna, rent(bob.id), noonSP("2026-10-01"));
    await leave(bob.id, houseA.id);
    requestCookies.session = await signIn(ana);

    expect(await svc.postDue(noonSP("2026-10-05"))).toMatchObject({ posted: 0, paused: 1 });
    expect(await postedExpenses(id)).toHaveLength(0);
    expect(await ledger(id)).toHaveLength(0);
    expect(await svc.get(houseA.id, asAna, rule.publicId, noonSP("2026-10-05"))).toMatchObject({ paused: true, pauseReason: "MEMBER_LEFT" });
    await flushAudit();
    const pause = await prisma.entityRevision.findFirstOrThrow({ where: { entityType: "RecurringExpense", entityId: String(id), action: "UPDATE" } });
    expect(pause.actorId).toBeNull();
    expect(pause.groupId).toBe(houseA.id);

    expect((await svc.postDue(noonSP("2026-10-06"))).paused).toBe(0);
  });

  it("SELECTED: a participant who left pauses the rule; ALL splits among the members still active (criterion 12)", async () => {
    const { ana, bob, dan, houseA, asAna } = await seed();
    const gas = await svc.create(houseA.id, asAna, rent(ana.id, { description: "Gas", splitMode: "SELECTED", participantIds: [ana.id, dan.id] }), noonSP("2026-10-01"));
    const internet = await svc.create(houseA.id, asAna, rent(ana.id, { description: "Internet", amount: 100 }), noonSP("2026-10-01"));
    await leave(dan.id, houseA.id);

    expect(await svc.postDue(noonSP("2026-10-05"))).toMatchObject({ posted: 1, paused: 1 });
    expect(await postedExpenses(gas.id)).toHaveLength(0);
    expect((await prisma.recurringExpense.findUniqueOrThrow({ where: { id: gas.id } })).pauseReason).toBe("MEMBER_LEFT");
    const [posted] = await postedExpenses(internet.id);
    expect(split(posted)).toEqual([[ana.id, 5000], [bob.id, 5000]]);
  });

  it("SELECTED posts among exactly the chosen people, shares summing to the amount in integer cents (criterion 8)", async () => {
    const { ana, bob, dan, houseA, asBob } = await seed();
    const { id } = await svc.create(houseA.id, asBob, rent(bob.id, { amount: 50.01, splitMode: "SELECTED", participantIds: [bob.id, dan.id] }), noonSP("2026-10-01"));
    await svc.postDue(noonSP("2026-10-05"));
    const [posted] = await postedExpenses(id);
    expect(split(posted)).toEqual([[bob.id, 2501], [dan.id, 2500]]);
    expect(posted.participants.some((p) => p.userId === ana.id)).toBe(false);
  });

  it("posts as the system: the Expense CREATE revision and the Summary entry have actorId null even inside a member's session (criterion 13)", async () => {
    const { bob, ana, houseA, asAna } = await seed();
    const { id } = await svc.create(houseA.id, asAna, rent(ana.id), noonSP("2026-10-01"));
    requestCookies.session = await signIn(bob);

    await svc.postDue(noonSP("2026-10-05"), { recurringExpenseId: id });
    await flushAudit();
    const [expense] = await postedExpenses(id);
    const revision = await prisma.entityRevision.findFirstOrThrow({ where: { entityType: "Expense", entityId: String(expense.id), action: "CREATE" } });
    expect(revision.actorId).toBeNull();
    expect(revision.groupId).toBe(houseA.id);
    expect((revision.after as Record<string, unknown>).recurringExpenseId).toBe(id);

    const entry = await prisma.auditLog.findFirstOrThrow({ where: { groupId: houseA.id, entityId: expense.publicId } });
    expect(entry).toMatchObject({ actorId: null, entityType: "EXPENSE", action: "CREATE", summary: "Rent" });
    const changes = entry.changes as Record<string, unknown>;
    expect(changes).toMatchObject({ recurring: true, period: "2026-10" });
    expect(cents(changes.amount)).toBe(180000);
  });

  it("tenant isolation: a rule posts only into its own house with its own members; a targeted run touches one rule", async () => {
    const { ana, bob, dan, carol, houseA, houseB, asAna, asCarol } = await seed();
    const a = await svc.create(houseA.id, asAna, rent(ana.id, { amount: 90 }), noonSP("2026-10-01"));
    const b = await svc.create(houseB.id, asCarol, rent(carol.id, { description: "Foreign rent", amount: 90 }), noonSP("2026-10-01"));

    expect((await svc.postDue(noonSP("2026-10-05"), { recurringExpenseId: a.id })).posted).toBe(1);
    expect(await postedExpenses(b.id)).toHaveLength(0);
    await svc.postDue(noonSP("2026-10-05"));
    const [ea] = await postedExpenses(a.id);
    const [eb] = await postedExpenses(b.id);
    expect(ea.groupId).toBe(houseA.id);
    expect(ea.participants.map((p) => p.userId)).toEqual([ana.id, bob.id, dan.id]);
    expect(eb.groupId).toBe(houseB.id);
    expect(split(eb)).toEqual([[carol.id, 9000]]);

    // A rule in house A that (wrongly) names a house-B payer never posts anywhere: it pauses.
    const rogue = await prisma.recurringExpense.create({
      data: {
        publicId: randomUUID(), groupId: houseA.id, payerId: carol.id, description: "Rogue", amount: 10,
        dayOfMonth: 5, timezone: SP, activeFrom: new Date("2026-10-01T00:00:00Z"),
      },
    });
    expect(await svc.postDue(noonSP("2026-10-05"))).toMatchObject({ posted: 0, paused: 1 });
    expect(await prisma.expense.count({ where: { recurringExpenseId: rogue.id } })).toBe(0);
    expect(await prisma.expense.count({ where: { groupId: houseB.id } })).toBe(1);
  });

  it("deadline: rules not reached in time are counted as remaining and posted by the next run", async () => {
    const { ana, houseA, asAna } = await seed();
    await svc.create(houseA.id, asAna, rent(ana.id, { description: "Rent" }), noonSP("2026-10-01"));
    await svc.create(houseA.id, asAna, rent(ana.id, { description: "Internet" }), noonSP("2026-10-01"));

    expect(await svc.postDue(noonSP("2026-10-05"), { deadline: new Date(Date.now() - 1) })).toMatchObject({ posted: 0, remaining: 2 });
    expect(await svc.postDue(noonSP("2026-10-05"))).toMatchObject({ posted: 2, remaining: 0 });
  });
});
