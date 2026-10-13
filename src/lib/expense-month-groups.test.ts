import { describe, expect, it } from "vitest";
import { groupExpensesByMonth } from "./expense-month-groups";

const expenses = [
  { date: "2026-05-20T12:00:00.000Z", amount: "0.10", id: "may" },
  { date: "2026-06-18T12:00:00.000Z", amount: "12.34", id: "june-a" },
  { date: "2026-06-02T12:00:00.000Z", amount: "0.20", id: "june-b" },
];

describe("groupExpensesByMonth", () => {
  it("groups newest-first, preserves item order, and sums exact cents", () => {
    const groups = groupExpensesByMonth(expenses, "en");

    expect(groups.map((group) => group.key)).toEqual(["2026-06", "2026-05"]);
    expect(groups[0]?.items.map((expense) => expense.id)).toEqual(["june-a", "june-b"]);
    expect(groups[0]?.subtotal).toBe(12.54);
    expect(groups[1]?.subtotal).toBe(0.1);
  });

  it("orders month sections oldest-first when requested", () => {
    expect(groupExpensesByMonth(expenses, "en", "asc").map((group) => group.key))
      .toEqual(["2026-05", "2026-06"]);
  });

  it("creates localized month and year labels", () => {
    expect(groupExpensesByMonth(expenses, "pt", "desc")[0]?.label).toBe("Junho\u00A0/\u00A02026");
  });

  it("glues month, slash and year with no-break spaces so the year never wraps alone (I8)", () => {
    for (const locale of ["en", "pt", "es", "fr"]) {
      const label = groupExpensesByMonth(expenses, locale, "desc")[0]?.label ?? "";
      expect(label).toMatch(/^\S+\u00A0\/\u00A02026$/);
      expect(label).not.toContain(" ");
    }
  });

  it("uses the server's full-month total when one is given, else the loaded sum (B5)", () => {
    const groups = groupExpensesByMonth(expenses, "en", "desc", new Map([["2026-06", 999.99]]));
    expect(groups[0]?.subtotal).toBe(999.99);
    expect(groups[1]?.subtotal).toBe(0.1);
  });
});
