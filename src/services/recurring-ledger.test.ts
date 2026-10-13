import { describe, it, expect, vi, beforeEach } from "vitest";

// Prisma mocked: the query shapes. Against a real DB the poster and the reminders use these through
// tenant-isolation.test.ts ("recurring expenses" and "notification center" describes).
const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: { recurringExpenseOccurrence: { findFirst: vi.fn(), groupBy: vi.fn() } },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import { lastClosedPeriod, lastClosedPeriods } from "@/services/recurring-ledger";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("recurring ledger — a rule's last closed period (posted or skipped), shared by the poster and the reminders", () => {
  it("lastClosedPeriod: the rule's highest ledger period, or null without a ledger row", async () => {
    mockPrisma.recurringExpenseOccurrence.findFirst.mockResolvedValueOnce({ period: "2026-10" }).mockResolvedValueOnce(null);

    expect(await lastClosedPeriod(7)).toBe("2026-10");
    expect(await lastClosedPeriod(8)).toBeNull();
    expect(mockPrisma.recurringExpenseOccurrence.findFirst).toHaveBeenCalledWith({
      where: { recurringExpenseId: 7 },
      orderBy: { period: "desc" },
      select: { period: true },
    });
  });

  it("lastClosedPeriods: one grouped query for every rule; rules without a ledger row are absent from the map", async () => {
    mockPrisma.recurringExpenseOccurrence.groupBy.mockResolvedValueOnce([
      { recurringExpenseId: 1, _max: { period: "2026-09" } },
      { recurringExpenseId: 2, _max: { period: null } },
    ]);

    expect(await lastClosedPeriods([1, 2, 3])).toEqual(new Map([[1, "2026-09"]]));
    expect(mockPrisma.recurringExpenseOccurrence.groupBy).toHaveBeenCalledTimes(1);
    expect(mockPrisma.recurringExpenseOccurrence.groupBy).toHaveBeenCalledWith({
      by: ["recurringExpenseId"],
      where: { recurringExpenseId: { in: [1, 2, 3] } },
      _max: { period: true },
    });
  });

  it("lastClosedPeriods: no rule, no query", async () => {
    expect(await lastClosedPeriods([])).toEqual(new Map());
    expect(mockPrisma.recurringExpenseOccurrence.groupBy).not.toHaveBeenCalled();
  });
});
