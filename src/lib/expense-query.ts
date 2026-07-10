import type { ExpenseSortField } from "./types";

// Structurally matches ExpenseFiltersModal's `ExpenseFilters` (not imported directly — lib/
// stays decoupled from components/, and the shape is simple enough to duplicate here).
export interface ExpenseQueryFilters {
  query: string;
  payers: number[];
  platforms: string[];
  categories: string[];
  payments: string[];
  fromDate: string;
  toDate: string;
}

export interface BuildExpenseQueryParams {
  page: number;
  pageSize: number;
  sortField: ExpenseSortField;
  sortDirection: "asc" | "desc";
  filters: ExpenseQueryFilters;
}

/** Builds the /api/expenses query string for a given page + sort + filter set (BL-20/P3 —
 *  infinite scroll needs the server to do the filtering it used to do client-side). Filters are
 *  only appended when non-empty, so an unfiltered request looks exactly like before. */
export function buildExpenseQuery({ page, pageSize, sortField, sortDirection, filters }: BuildExpenseQueryParams): string {
  const sp = new URLSearchParams();
  sp.set("page", String(page));
  sp.set("pageSize", String(pageSize));
  sp.set("sortField", sortField);
  sp.set("sortDirection", sortDirection);
  if (filters.query.trim()) sp.set("query", filters.query.trim());
  filters.payers.forEach((id) => sp.append("payerIds", String(id)));
  filters.platforms.forEach((v) => sp.append("platforms", v));
  filters.categories.forEach((v) => sp.append("categories", v));
  filters.payments.forEach((v) => sp.append("paymentMethods", v));
  if (filters.fromDate) sp.set("fromDate", filters.fromDate);
  if (filters.toDate) sp.set("toDate", filters.toDate);
  return `/api/expenses?${sp.toString()}`;
}
