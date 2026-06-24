import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { expenseService } from "@/services/expense.service";
import { settlementService } from "@/services/settlement.service";

// Integration tests against a real (pglite) Postgres booted by test/global-setup.ts.
// They exercise the actual Prisma queries to prove the groupId scoping really isolates houses —
// the security boundary a unit test with mocks can't verify.

async function reset() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "User","Group","membro_grupo","plataforma","Expense","ExpenseParticipant","acerto","registro_auditoria" RESTART IDENTITY CASCADE`
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
