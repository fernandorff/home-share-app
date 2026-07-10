import { describe, it, expect } from "vitest";
import { buildExpenseQuery, type ExpenseQueryFilters } from "./expense-query";

const EMPTY_FILTERS: ExpenseQueryFilters = {
  query: "",
  payers: [],
  platforms: [],
  categories: [],
  payments: [],
  fromDate: "",
  toDate: "",
};

function paramsOf(url: string): URLSearchParams {
  return new URL(url, "http://x").searchParams;
}

describe("buildExpenseQuery", () => {
  it("builds the base page/pageSize/sort params with no filters set", () => {
    const url = buildExpenseQuery({ page: 2, pageSize: 50, sortField: "date", sortDirection: "desc", filters: EMPTY_FILTERS });
    expect(url.startsWith("/api/expenses?")).toBe(true);
    const params = paramsOf(url);
    expect(params.get("page")).toBe("2");
    expect(params.get("pageSize")).toBe("50");
    expect(params.get("sortField")).toBe("date");
    expect(params.get("sortDirection")).toBe("desc");
    expect(params.has("query")).toBe(false);
    expect(params.has("payerIds")).toBe(false);
  });

  it("trims and only appends query when non-empty", () => {
    const withQuery = buildExpenseQuery({ page: 1, pageSize: 50, sortField: "date", sortDirection: "desc", filters: { ...EMPTY_FILTERS, query: "  uber  " } });
    expect(paramsOf(withQuery).get("query")).toBe("uber");

    const blankQuery = buildExpenseQuery({ page: 1, pageSize: 50, sortField: "date", sortDirection: "desc", filters: { ...EMPTY_FILTERS, query: "   " } });
    expect(paramsOf(blankQuery).has("query")).toBe(false);
  });

  it("appends one entry per value for array filters (not comma-joined, so a value containing a comma is never split)", () => {
    const url = buildExpenseQuery({
      page: 1,
      pageSize: 50,
      sortField: "date",
      sortDirection: "desc",
      filters: { ...EMPTY_FILTERS, payers: [3, 5], platforms: ["Foo, Bar", "netflix"] },
    });
    const params = paramsOf(url);
    expect(params.getAll("payerIds")).toEqual(["3", "5"]);
    expect(params.getAll("platforms")).toEqual(["Foo, Bar", "netflix"]);
  });

  it("includes fromDate/toDate only when set", () => {
    const url = buildExpenseQuery({ page: 1, pageSize: 50, sortField: "date", sortDirection: "asc", filters: { ...EMPTY_FILTERS, fromDate: "2026-01-01", toDate: "2026-01-31" } });
    const params = paramsOf(url);
    expect(params.get("fromDate")).toBe("2026-01-01");
    expect(params.get("toDate")).toBe("2026-01-31");
  });
});
