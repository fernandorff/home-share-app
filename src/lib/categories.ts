// Fixed set of expense categories. The stored value is a stable key (locale-independent);
// the UI translates it via the Expenses.category.<key> i18n messages. Keeping it a fixed
// list (not a CRUD entity) avoids management overhead and gives consistent breakdowns.
export const EXPENSE_CATEGORIES = [
  "groceries",
  "dining",
  "home",
  "utilities",
  "transport",
  "health",
  "leisure",
  "shopping",
  "pets",
  "other",
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export function isExpenseCategory(value: unknown): value is ExpenseCategory {
  return typeof value === "string" && (EXPENSE_CATEGORIES as readonly string[]).includes(value);
}
