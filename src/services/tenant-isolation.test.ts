import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { expenseService } from "@/services/expense.service";
import { settlementService } from "@/services/settlement.service";
import { categoryService } from "@/services/category.service";
import { groupService } from "@/services/group.service";
import { authService } from "@/services/auth.service";
import { allActiveGroupMembers, allGroupMembers } from "@/lib/api-helpers";
import { runWithAuditContext } from "@/lib/audit-context";
import { flushAudit } from "@/lib/prisma-audit";

// Integration tests against a real (pglite) Postgres booted by test/global-setup.ts.
// They exercise the actual Prisma queries to prove the groupId scoping really isolates houses —
// the security boundary a unit test with mocks can't verify.

async function reset() {
  // Drain any deferred (fire-and-forget) audit writes before wiping, so a late revision from a
  // previous test can't land after the TRUNCATE and leak into the next one.
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
    ).rejects.toMatchObject({ status: 400 });
    expect(await prisma.expense.count({ where: { groupId: house.id } })).toBe(0);
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
});
