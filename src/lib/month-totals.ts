import { toCents } from "./currency";

export interface MonthTotal {
  month: string;
  totalAmount: string;
}

export interface PayerMonthTotal {
  payerId: number;
  month: string;
  totalAmount: string;
}

/** "2026-06" for a stored expense date. Dates are written at local noon (T12:00:00), so the UTC
 *  calendar month equals the writer's local month for every offset from UTC−11 to UTC+11 — the
 *  same "YYYY-MM" key `groupExpensesByMonth` builds client-side. */
export function utcMonthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

const centsToAmount = (cents: number) => (cents / 100).toFixed(2);

/** Buckets per-(payer, date) Decimal sums into exact per-month and per-payer-month totals (B5).
 *  All arithmetic is integer cents; the output keeps the API's decimal-string money format. */
export function bucketMonthTotals(
  rows: readonly { payerId: number; date: Date; amount: { toString(): string } | null }[]
): { monthTotals: MonthTotal[]; payerMonthTotals: PayerMonthTotal[] } {
  const byMonth = new Map<string, number>();
  const byPayerMonth = new Map<string, { payerId: number; month: string; cents: number }>();
  for (const row of rows) {
    const month = utcMonthKey(row.date);
    const cents = row.amount === null ? 0 : toCents(row.amount);
    byMonth.set(month, (byMonth.get(month) ?? 0) + cents);
    const key = `${row.payerId}|${month}`;
    const entry = byPayerMonth.get(key) ?? { payerId: row.payerId, month, cents: 0 };
    entry.cents += cents;
    byPayerMonth.set(key, entry);
  }
  return {
    monthTotals: [...byMonth].map(([month, cents]) => ({ month, totalAmount: centsToAmount(cents) })),
    payerMonthTotals: [...byPayerMonth.values()].map(({ payerId, month, cents }) => ({
      payerId,
      month,
      totalAmount: centsToAmount(cents),
    })),
  };
}
