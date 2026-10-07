import { describe, it, expect } from "vitest";
import {
  equalPercents,
  distributeByPercent,
  detectSplitEqually,
  isEqualAmongParticipants,
  seedPercentFromExpense,
  clampPercentInput,
} from "@/lib/split";
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

describe("isEqualAmongParticipants", () => {
  const e = (amount: string, shares: string[]) =>
    ({ amount, participants: shares.map((a, i) => ({ userId: i + 1, amount: a })) } as unknown as Expense);

  it("is true for one participant", () => expect(isEqualAmongParticipants(e("159.90", ["159.90"]))).toBe(true));
  it("is true for an equal split with the odd cent", () =>
    expect(isEqualAmongParticipants(e("0.01", ["0.01", "0"]))).toBe(true));
  it("is true for 100.00 over 3", () =>
    expect(isEqualAmongParticipants(e("100", ["33.34", "33.33", "33.33"]))).toBe(true));
  it("is false for 70/30", () => expect(isEqualAmongParticipants(e("100", ["70", "30"]))).toBe(false));
});

describe("seedPercentFromExpense", () => {
  it("seeds each participant's real percentage, largest-remainder for the leftover point", () => {
    const exp = expenseWith(3, [
      { userId: 1, amount: 2 },
      { userId: 2, amount: 1 },
    ]);
    // 2/3 = 66.67%, 1/3 = 33.33% -> floors [66, 33] leave 1 point, given to the biggest fraction.
    expect(seedPercentFromExpense(exp, members)).toEqual({ 1: 67, 2: 33, 3: 0 });
  });

  it("seeds 0% for a member with no participant row on the expense", () => {
    const exp = expenseWith(100, [{ userId: 1, amount: 100 }]);
    expect(seedPercentFromExpense(exp, members)).toEqual({ 1: 100, 2: 0, 3: 0 });
  });
});

describe("clampPercentInput (U21)", () => {
  it("parses typed integers", () => {
    expect(clampPercentInput("42")).toBe(42);
    expect(clampPercentInput("07")).toBe(7);
    expect(clampPercentInput("3.5")).toBe(3);
  });
  it("clamps to 0–100", () => {
    expect(clampPercentInput("150")).toBe(100);
    expect(clampPercentInput("-5")).toBe(0);
  });
  it("treats empty or non-numeric input as 0", () => {
    expect(clampPercentInput("")).toBe(0);
    expect(clampPercentInput("abc")).toBe(0);
  });
});
