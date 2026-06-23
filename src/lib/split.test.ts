import { describe, it, expect } from "vitest";
import { equalPercents, distributeByPercent, detectSplitEqually } from "@/lib/split";
import type { Expense, Member } from "@/lib/types";

const members = [
  { id: 1, name: "A" },
  { id: 2, name: "B" },
  { id: 3, name: "C" },
] as unknown as Member[];

const expenseWith = (amount: number, parts: { userId: number; amount: number }[]) =>
  ({ amount, participants: parts } as unknown as Expense);

describe("equalPercents", () => {
  it("sums to exactly 100, remainder on the first slots", () => {
    expect(equalPercents(2)).toEqual([50, 50]);
    expect(equalPercents(3)).toEqual([34, 33, 33]);
    expect(equalPercents(4)).toEqual([25, 25, 25, 25]);
    expect(equalPercents(0)).toEqual([]);
  });
});

describe("distributeByPercent — largest-remainder, exact to the cent when pct=100", () => {
  it("distributes the leftover cent to the biggest fraction", () => {
    expect(distributeByPercent(10, [33, 33, 34])).toEqual([3, 3, 4]);
  });

  it("always sums to the total when percentages sum to 100", () => {
    for (const total of [1, 99, 100, 1234, 99999]) {
      const out = distributeByPercent(total, [34, 33, 33]);
      expect(out.reduce((a, b) => a + b, 0)).toBe(total);
    }
  });

  it("returns zeros for a non-positive total or percentage sum", () => {
    expect(distributeByPercent(0, [50, 50])).toEqual([0, 0]);
    expect(distributeByPercent(100, [0, 0])).toEqual([0, 0]);
  });
});

describe("detectSplitEqually", () => {
  it("true when participants match the equal (largest-remainder) split", () => {
    // 0.05 split 3 ways → [0.02, 0.02, 0.01]
    const exp = expenseWith(0.05, [
      { userId: 1, amount: 0.02 },
      { userId: 2, amount: 0.02 },
      { userId: 3, amount: 0.01 },
    ]);
    expect(detectSplitEqually(exp, members)).toBe(true);
  });

  it("false for a custom (uneven) split", () => {
    const exp = expenseWith(0.05, [
      { userId: 1, amount: 0.03 },
      { userId: 2, amount: 0.01 },
      { userId: 3, amount: 0.01 },
    ]);
    expect(detectSplitEqually(exp, members)).toBe(false);
  });

  it("false when the participant count differs from members", () => {
    const exp = expenseWith(0.04, [
      { userId: 1, amount: 0.02 },
      { userId: 2, amount: 0.02 },
    ]);
    expect(detectSplitEqually(exp, members)).toBe(false);
  });
});
