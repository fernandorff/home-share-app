import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { expenseService } from "@/services/expense.service";
import { settlementService } from "@/services/settlement.service";
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
    `TRUNCATE "User","Group","membro_grupo","plataforma","Expense","ExpenseParticipant","acerto","registro_auditoria","revisao_entidade" RESTART IDENTITY CASCADE`
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
    const { ana, bob, houseB, expA } = await seedTwoHouses();
    await expect(
      expenseService.update(houseB.id, expA.id, [ana.id, bob.id], { description: "hacked", amount: 50 })
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
      await newExpense(g.id, u.id, "Café", 10)
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
    expect(after.description).toBe("Café");
    // nested participants are captured inside the parent snapshot
    expect(Array.isArray(after.participants)).toBe(true);
    expect((after.participants as unknown[]).length).toBe(1);
  });

  it("UPDATE: records the new after-snapshot; the prior CREATE holds the old value (history chain)", async () => {
    const { u, g } = await seedUserGroup();
    const exp = await newExpense(g.id, u.id, "Café", 10);
    await runWithAuditContext({ actorId: u.id, groupId: g.id }, async () =>
      await prisma.expense.update({ where: { id: exp.id }, data: { description: "Chá" } })
    );
    await flushAudit();
    const upd = await prisma.entityRevision.findFirst({
      where: { entityType: "Expense", entityId: String(exp.id), action: "UPDATE" },
    });
    expect(upd).not.toBeNull();
    expect((upd!.after as Record<string, unknown>).description).toBe("Chá");
    expect(upd!.actorId).toBe(u.id);
    // the "before" of the update = the previous revision's "after"
    const create = await prisma.entityRevision.findFirst({
      where: { entityType: "Expense", entityId: String(exp.id), action: "CREATE" },
    });
    expect((create!.after as Record<string, unknown>).description).toBe("Café");
  });

  it("DELETE: records the removed row's final state", async () => {
    const { u, g } = await seedUserGroup();
    const exp = await newExpense(g.id, u.id, "Café", 10);
    await runWithAuditContext({ actorId: u.id, groupId: g.id }, async () =>
      await prisma.expense.delete({ where: { id: exp.id } })
    );
    await flushAudit();
    const r = await prisma.entityRevision.findFirst({
      where: { entityType: "Expense", entityId: String(exp.id), action: "DELETE" },
    });
    expect(r).not.toBeNull();
    expect((r!.before as Record<string, unknown>).description).toBe("Café");
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
    const exp = await newExpense(g.id, u.id, "Sem contexto", 5); // no runWithAuditContext
    await flushAudit();
    const r = await prisma.entityRevision.findFirst({
      where: { entityType: "Expense", entityId: String(exp.id) },
    });
    expect(r).not.toBeNull();
    expect(r!.actorId).toBeNull();
    expect(r!.groupId).toBe(g.id);
  });
});
