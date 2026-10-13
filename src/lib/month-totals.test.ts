import { describe, it, expect } from "vitest";
import { bucketMonthTotals, utcMonthKey } from "./month-totals";

describe("bucketMonthTotals (B5)", () => {
  it("sums per-day rows into exact month and payer-month totals in integer cents", () => {
    const { monthTotals, payerMonthTotals } = bucketMonthTotals([
      { payerId: 1, date: new Date("2026-06-02T12:00:00Z"), amount: "0.10" },
      { payerId: 2, date: new Date("2026-06-18T12:00:00Z"), amount: "0.20" },
      { payerId: 1, date: new Date("2026-06-30T12:00:00Z"), amount: "12.34" },
      { payerId: 1, date: new Date("2026-05-20T12:00:00Z"), amount: "100.00" },
    ]);
    expect(monthTotals).toEqual([
      { month: "2026-06", totalAmount: "12.64" },
      { month: "2026-05", totalAmount: "100.00" },
    ]);
    expect(payerMonthTotals).toEqual([
      { payerId: 1, month: "2026-06", totalAmount: "12.44" },
      { payerId: 2, month: "2026-06", totalAmount: "0.20" },
      { payerId: 1, month: "2026-05", totalAmount: "100.00" },
    ]);
  });

  it("treats a null sum as zero", () => {
    expect(bucketMonthTotals([{ payerId: 1, date: new Date("2026-06-02T12:00:00Z"), amount: null }]).monthTotals)
      .toEqual([{ month: "2026-06", totalAmount: "0.00" }]);
  });

  it("keys months in UTC", () => {
    expect(utcMonthKey(new Date("2026-01-31T23:30:00Z"))).toBe("2026-01");
    expect(utcMonthKey(new Date("2026-12-01T00:00:00Z"))).toBe("2026-12");
  });
});
