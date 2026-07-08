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
