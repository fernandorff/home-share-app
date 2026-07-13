import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Prisma singleton before importing the service (vi.mock + vi.hoisted are hoisted).
const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    expense: {
      create: vi.fn(),
      update: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      aggregate: vi.fn(),
      groupBy: vi.fn(),
      delete: vi.fn(),
    },
    expenseParticipant: { deleteMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import { expenseService, escapeCSVField } from "@/services/expense.service";

beforeEach(() => {
  vi.clearAllMocks();
});

const dataOfLastCreate = () => mockPrisma.expense.create.mock.calls.at(-1)![0].data;

describe("ExpenseService.create — split math + persisted shape", () => {
  it("equal split distributes integer cents exactly (largest-remainder)", async () => {
    mockPrisma.expense.create.mockResolvedValue({ id: 1 });
    // 0.05 across 3 members → 0.02 / 0.02 / 0.01 (sums to exactly 0.05)
    await expenseService.create(1, [1, 2, 3], {
      payerId: 1,
      description: "Test",
      amount: 0.05,
      splitEqually: true,
    });
    expect(dataOfLastCreate().participants.create).toEqual([
      { userId: 1, amount: 0.02 },
      { userId: 2, amount: 0.02 },
      { userId: 3, amount: 0.01 },
    ]);
  });

  it("uses the provided participants for a custom split", async () => {
    mockPrisma.expense.create.mockResolvedValue({ id: 2 });
    await expenseService.create(1, [1, 2], {
      payerId: 1,
      description: "Test",
      amount: 1,
      splitEqually: false,
      participants: [{ userId: 1, amount: 0.7 }, { userId: 2, amount: 0.3 }],
    });
    expect(dataOfLastCreate().participants.create).toEqual([
      { userId: 1, amount: 0.7 },
      { userId: 2, amount: 0.3 },
    ]);
  });

  it("falls back to equal split when participants is empty even if splitEqually is false", async () => {
    mockPrisma.expense.create.mockResolvedValue({ id: 3 });
    await expenseService.create(1, [1, 2], {
      payerId: 1,
      description: "Test",
      amount: 10,
      splitEqually: false,
      participants: [],
    });
    expect(dataOfLastCreate().participants.create).toEqual([
      { userId: 1, amount: 5 },
      { userId: 2, amount: 5 },
    ]);
  });

  it("scopes to the group and persists categories + trims description", async () => {
    mockPrisma.expense.create.mockResolvedValue({ id: 4 });
    await expenseService.create(7, [1, 2], {
      payerId: 1,
      description: "  Groceries  ",
      amount: 10,
      categories: ["groceries"],
      splitEqually: true,
    });
    const data = dataOfLastCreate();
    expect(data.groupId).toBe(7);
    expect(data.categories).toEqual(["groceries"]);
    expect(data.description).toBe("Groceries");
  });
});

describe("ExpenseService.update — tenant isolation + ownership (C1)", () => {
  it("throws ApiError 404 when the expense is not in the active group", async () => {
    // $transaction(cb) → run cb with a tx whose findFirst returns null (not found in group)
    mockPrisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({
        expense: { findFirst: vi.fn().mockResolvedValue(null), update: vi.fn() },
        expenseParticipant: { deleteMany: vi.fn() },
      })
    );
    await expect(
      expenseService.update(1, 999, 1, false, [1, 2], { description: "x", amount: 10 })
    ).rejects.toMatchObject({ status: 404 });
  });

  it("throws ApiError 403 when a non-admin member who didn't pay tries to edit someone else's expense", async () => {
    mockPrisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({
        expense: { findFirst: vi.fn().mockResolvedValue({ id: 999, payerId: 1 }), update: vi.fn() },
        expenseParticipant: { deleteMany: vi.fn() },
      })
    );
    // actingUserId=2 (not the payer, id 1), isAdmin=false
    await expect(
      expenseService.update(1, 999, 2, false, [1, 2], { description: "x", amount: 10 })
    ).rejects.toMatchObject({ status: 403, code: "NOT_EXPENSE_OWNER" });
  });

  it("allows the payer to edit their own expense (not admin)", async () => {
    const update = vi.fn().mockResolvedValue({ id: 999, description: "x" });
    mockPrisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({
        expense: { findFirst: vi.fn().mockResolvedValue({ id: 999, payerId: 1 }), update },
        expenseParticipant: { deleteMany: vi.fn() },
      })
    );
    await expenseService.update(1, 999, 1, false, [1, 2], { description: "x", amount: 10 });
    expect(update).toHaveBeenCalled();
  });

  it("allows an admin to edit an expense they didn't pay", async () => {
    const update = vi.fn().mockResolvedValue({ id: 999, description: "x" });
    mockPrisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({
        expense: { findFirst: vi.fn().mockResolvedValue({ id: 999, payerId: 1 }), update },
        expenseParticipant: { deleteMany: vi.fn() },
      })
    );
    // actingUserId=2 (not the payer), isAdmin=true
    await expenseService.update(1, 999, 2, true, [1, 2], { description: "x", amount: 10 });
    expect(update).toHaveBeenCalled();
  });
});

describe("ExpenseService.update — lost-update guard (concurrent-edit race, BL-05)", () => {
  const FIRST_SAVE_AT = new Date("2026-01-01T10:00:00.000Z");

  it("throws 409 STALE_EXPENSE when expectedUpdatedAt doesn't match the current row (someone else saved first)", async () => {
    mockPrisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({
        expense: {
          findFirst: vi.fn().mockResolvedValue({ id: 999, payerId: 1, updatedAt: FIRST_SAVE_AT }),
          update: vi.fn(),
        },
        expenseParticipant: { deleteMany: vi.fn() },
      })
    );
    await expect(
      expenseService.update(1, 999, 1, false, [1, 2], { description: "x", amount: 10 }, "2025-01-01T00:00:00.000Z")
    ).rejects.toMatchObject({ status: 409, code: "STALE_EXPENSE" });
  });

  it("succeeds when expectedUpdatedAt matches the current row's updatedAt", async () => {
    const update = vi.fn().mockResolvedValue({ id: 999, description: "x" });
    mockPrisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({
        expense: {
          findFirst: vi.fn().mockResolvedValue({ id: 999, payerId: 1, updatedAt: FIRST_SAVE_AT }),
          update,
        },
        expenseParticipant: { deleteMany: vi.fn() },
      })
    );
    await expenseService.update(1, 999, 1, false, [1, 2], { description: "x", amount: 10 }, FIRST_SAVE_AT.toISOString());
    expect(update).toHaveBeenCalled();
  });

  it("skips the check entirely when expectedUpdatedAt is not provided (backward compatible)", async () => {
    const update = vi.fn().mockResolvedValue({ id: 999, description: "x" });
    mockPrisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({
        expense: {
          findFirst: vi.fn().mockResolvedValue({ id: 999, payerId: 1, updatedAt: FIRST_SAVE_AT }),
          update,
        },
        expenseParticipant: { deleteMany: vi.fn() },
      })
    );
    await expenseService.update(1, 999, 1, false, [1, 2], { description: "x", amount: 10 });
    expect(update).toHaveBeenCalled();
  });

  // #37: the SIMULTANEOUS race — two saves both pass the updatedAt check, then collide on
  // ExpenseParticipant's unique constraint (P2002) or a write-conflict (P2034). Must surface the
  // same 409 STALE_EXPENSE as the slow race, not a raw 500.
  it.each(["P2002", "P2034"])("maps Prisma %s (concurrent write conflict) to 409 STALE_EXPENSE", async (code) => {
    mockPrisma.$transaction.mockRejectedValue(Object.assign(new Error("write conflict"), { code }));
    await expect(
      expenseService.update(1, 999, 1, false, [1, 2], { description: "x", amount: 10 }, FIRST_SAVE_AT.toISOString())
    ).rejects.toMatchObject({ status: 409, code: "STALE_EXPENSE" });
  });

  it("re-throws non-concurrency Prisma errors unchanged (not masked as 409)", async () => {
    mockPrisma.$transaction.mockRejectedValue(Object.assign(new Error("boom"), { code: "P2000" }));
    await expect(
      expenseService.update(1, 999, 1, false, [1, 2], { description: "x", amount: 10 })
    ).rejects.toMatchObject({ code: "P2000" });
  });
});

describe("ExpenseService.delete — tenant isolation + ownership (C1) + single-row audit trail (A2)", () => {
  it("throws ApiError 404 when the expense is not in the active group", async () => {
    mockPrisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({ expense: { findFirst: vi.fn().mockResolvedValue(null), delete: vi.fn() } })
    );
    await expect(expenseService.delete(1, 999, 1, false)).rejects.toMatchObject({ status: 404 });
  });

  it("throws ApiError 403 when a non-admin member who didn't pay tries to delete someone else's expense", async () => {
    mockPrisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({ expense: { findFirst: vi.fn().mockResolvedValue({ id: 999, payerId: 1 }), delete: vi.fn() } })
    );
    await expect(expenseService.delete(1, 999, 2, false)).rejects.toMatchObject({ status: 403, code: "NOT_EXPENSE_OWNER" });
  });

  it("allows the payer to delete their own expense, via a single-row delete (not deleteMany — keeps the audit trail per-entity)", async () => {
    const del = vi.fn().mockResolvedValue({ id: 999, payerId: 1 });
    mockPrisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({ expense: { findFirst: vi.fn().mockResolvedValue({ id: 999, payerId: 1 }), delete: del } })
    );
    await expenseService.delete(1, 999, 1, false);
    expect(del).toHaveBeenCalledWith({ where: { id: 999 } });
  });

  it("allows an admin to delete an expense they didn't pay", async () => {
    const del = vi.fn().mockResolvedValue({ id: 999, payerId: 1 });
    mockPrisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({ expense: { findFirst: vi.fn().mockResolvedValue({ id: 999, payerId: 1 }), delete: del } })
    );
    await expenseService.delete(1, 999, 2, true);
    expect(del).toHaveBeenCalledWith({ where: { id: 999 } });
  });
});

describe("ExpenseService.list — server-side filters (BL-20/P3)", () => {
  const baseParams = { page: 1, pageSize: 50, sortField: "date", sortDirection: "desc" as const };

  beforeEach(() => {
    mockPrisma.expense.findMany.mockResolvedValue([]);
    mockPrisma.expense.count.mockResolvedValue(0);
    mockPrisma.expense.aggregate.mockResolvedValue({ _sum: { amount: null } });
    mockPrisma.expense.groupBy.mockResolvedValue([]);
  });

  const whereOfLastFindMany = () => mockPrisma.expense.findMany.mock.calls.at(-1)![0].where;

  it("scopes to groupId alone when no filters are given", async () => {
    await expenseService.list(7, baseParams);
    expect(whereOfLastFindMany()).toEqual({ groupId: 7 });
    // Same where clause reused for count + aggregate, so the total/totalAmount stay consistent.
    expect(mockPrisma.expense.count.mock.calls.at(-1)![0].where).toEqual({ groupId: 7 });
    expect(mockPrisma.expense.aggregate.mock.calls.at(-1)![0].where).toEqual({ groupId: 7 });
  });

  it("builds an `in` filter for payerIds", async () => {
    await expenseService.list(1, { ...baseParams, filters: { payerIds: [3, 5] } });
    expect(whereOfLastFindMany().payerId).toEqual({ in: [3, 5] });
  });

  it("builds `hasSome` filters for platforms/categories/paymentMethods", async () => {
    await expenseService.list(1, {
      ...baseParams,
      filters: { platforms: ["ifood"], categories: ["groceries"], paymentMethods: ["pix"] },
    });
    const where = whereOfLastFindMany();
    expect(where.platforms).toEqual({ hasSome: ["ifood"] });
    expect(where.categories).toEqual({ hasSome: ["groceries"] });
    expect(where.paymentMethods).toEqual({ hasSome: ["pix"] });
  });

  it("builds a gte/lte date range only from the bounds that were provided", async () => {
    const fromDate = new Date("2026-01-01T00:00:00");
    await expenseService.list(1, { ...baseParams, filters: { fromDate } });
    expect(whereOfLastFindMany().date).toEqual({ gte: fromDate });
  });

  it("builds a case-insensitive OR search across description/notes/payer name", async () => {
    await expenseService.list(1, { ...baseParams, filters: { query: "uber" } });
    expect(whereOfLastFindMany().OR).toEqual([
      { description: { contains: "uber", mode: "insensitive" } },
      { notes: { contains: "uber", mode: "insensitive" } },
      { payer: { name: { contains: "uber", mode: "insensitive" } } },
    ]);
  });

  it("tiebreaks the sort on `id` so equal-value rows keep a stable order across pages", async () => {
    await expenseService.list(1, { ...baseParams, sortField: "amount", sortDirection: "asc" });
    expect(mockPrisma.expense.findMany.mock.calls.at(-1)![0].orderBy).toEqual([
      { amount: "asc" },
      { id: "asc" },
    ]);
  });

  it("sorts by payer name via the relation, still tiebreaking on id", async () => {
    await expenseService.list(1, { ...baseParams, sortField: "payer", sortDirection: "desc" });
    expect(mockPrisma.expense.findMany.mock.calls.at(-1)![0].orderBy).toEqual([
      { payer: { name: "desc" } },
      { id: "desc" },
    ]);
  });

  it("returns totalAmount as the aggregate sum, defaulting to 0 when there are no matching rows", async () => {
    mockPrisma.expense.aggregate.mockResolvedValueOnce({ _sum: { amount: null } });
    const result = await expenseService.list(1, baseParams);
    expect(result.pagination.totalAmount).toBe("0");
  });

  it("returns exact filter-scoped payer totals only when requested", async () => {
    mockPrisma.expense.groupBy.mockResolvedValueOnce([
      { payerId: 3, _sum: { amount: { toString: () => "123.45" } } },
      { payerId: 5, _sum: { amount: { toString: () => "0.05" } } },
    ]);
    const result = await expenseService.list(7, {
      ...baseParams,
      filters: { categories: ["groceries"] },
      includePayerTotals: true,
    });
    expect(mockPrisma.expense.groupBy).toHaveBeenCalledWith({
      by: ["payerId"],
      where: { groupId: 7, categories: { hasSome: ["groceries"] } },
      _sum: { amount: true },
    });
    expect(result.pagination.payerTotals).toEqual([
      { payerId: 3, totalAmount: "123.45" },
      { payerId: 5, totalAmount: "0.05" },
    ]);
  });

  it("does not run the payer aggregate for ordinary list requests", async () => {
    const result = await expenseService.list(1, baseParams);
    expect(mockPrisma.expense.groupBy).not.toHaveBeenCalled();
    expect(result.pagination).not.toHaveProperty("payerTotals");
  });
});

describe("escapeCSVField — formula-injection guard", () => {
  it("prefixes a leading-apostrophe when a cell starts with =, +, -, or @", () => {
    expect(escapeCSVField("=HYPERLINK(evil.com)")).toBe("'=HYPERLINK(evil.com)");
    expect(escapeCSVField("+1234")).toBe("'+1234");
    expect(escapeCSVField("-1234")).toBe("'-1234");
    expect(escapeCSVField("@SUM(A1)")).toBe("'@SUM(A1)");
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeCSVField("Almoço")).toBe("Almoço");
    expect(escapeCSVField("")).toBe("");
    expect(escapeCSVField(null)).toBe("");
    expect(escapeCSVField(undefined)).toBe("");
  });

  it("still quotes commas/quotes/newlines, applied AFTER the formula-injection prefix", () => {
    expect(escapeCSVField("a,b")).toBe('"a,b"');
    expect(escapeCSVField("=1,2")).toBe("\"'=1,2\"");
    expect(escapeCSVField('say "hi"')).toBe('"say ""hi"""');
  });
});
