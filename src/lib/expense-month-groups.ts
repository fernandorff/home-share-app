import { toCents } from "./currency";
import type { Money } from "./types";

export interface MonthlyExpenseLike {
  amount: Money;
  date: string;
}

export interface ExpenseMonthGroup<T extends MonthlyExpenseLike> {
  key: string;
  label: string;
  subtotal: number;
  items: T[];
}

/** Localized "June / 2026" label, matching the expense ledger's editorial style. */
export function expenseMonthLabel(date: Date, locale: string): string {
  const month = new Intl.DateTimeFormat(locale, { month: "long" }).format(date);
  return `${month.charAt(0).toUpperCase()}${month.slice(1)} / ${date.getFullYear()}`;
}

/** Groups loaded expenses without disturbing their existing order inside each month. */
export function groupExpensesByMonth<T extends MonthlyExpenseLike>(
  expenses: readonly T[],
  locale: string,
  monthDirection: "asc" | "desc" = "desc"
): ExpenseMonthGroup<T>[] {
  const groups = new Map<string, ExpenseMonthGroup<T> & { subtotalCents: number }>();

  for (const expense of expenses) {
    const date = new Date(expense.date);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        label: expenseMonthLabel(date, locale),
        subtotal: 0,
        subtotalCents: 0,
        items: [],
      };
      groups.set(key, group);
    }
    group.subtotalCents += toCents(expense.amount);
    group.items.push(expense);
  }

  return Array.from(groups.values())
    .sort((a, b) => monthDirection === "asc" ? a.key.localeCompare(b.key) : b.key.localeCompare(a.key))
    .map(({ subtotalCents, ...group }) => ({ ...group, subtotal: subtotalCents / 100 }));
}
