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
      delete: vi.fn(),
    },
    expenseParticipant: { deleteMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import { expenseService } from "@/services/expense.service";

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

  it("scopes to the group and persists category + trims description", async () => {
    mockPrisma.expense.create.mockResolvedValue({ id: 4 });
    await expenseService.create(7, [1, 2], {
      payerId: 1,
      description: "  Groceries  ",
      amount: 10,
      category: "groceries",
      splitEqually: true,
    });
    const data = dataOfLastCreate();
    expect(data.groupId).toBe(7);
    expect(data.category).toBe("groceries");
    expect(data.description).toBe("Groceries");
  });
});

describe("ExpenseService.update — tenant isolation", () => {
  it("throws ApiError 404 when the expense is not in the active group", async () => {
    // $transaction(cb) → run cb with a tx whose findFirst returns null (not found in group)
    mockPrisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({
        expense: { findFirst: vi.fn().mockResolvedValue(null), update: vi.fn() },
        expenseParticipant: { deleteMany: vi.fn() },
      })
    );
    await expect(
      expenseService.update(1, 999, [1, 2], { description: "x", amount: 10 })
    ).rejects.toMatchObject({ status: 404 });
  });
});
