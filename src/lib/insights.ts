import { toCents, fromCents } from '@/lib/currency'

export interface CategorySpend {
  category: string // "" = uncategorized
  total: number
}
export interface MonthSpend {
  month: string // "YYYY-MM"
  total: number
}

interface SpendInput {
  amount: number | string | { toString(): string }
  category?: string | null
  date: string | Date
}

const monthKey = (date: string | Date): string => {
  const iso = typeof date === 'string' ? date : date.toISOString()
  return iso.slice(0, 7)
}

/**
 * Spend aggregates for the insights view, computed in integer cents (no float drift):
 * total per category (uncategorized as "") and total per month, both newest/biggest first.
 */
export function aggregateSpend(expenses: SpendInput[]): {
  byCategory: CategorySpend[]
  byMonth: MonthSpend[]
} {
  const cat = new Map<string, number>()
  const mon = new Map<string, number>()

  for (const e of expenses) {
    const cents = toCents(e.amount)
    const c = e.category ?? ''
    cat.set(c, (cat.get(c) ?? 0) + cents)
    const m = monthKey(e.date)
    mon.set(m, (mon.get(m) ?? 0) + cents)
  }

  const byCategory = Array.from(cat.entries())
    .map(([category, cents]) => ({ category, total: fromCents(cents) }))
    .sort((a, b) => b.total - a.total)

  const byMonth = Array.from(mon.entries())
    .map(([month, cents]) => ({ month, total: fromCents(cents) }))
    .sort((a, b) => b.month.localeCompare(a.month))

  return { byCategory, byMonth }
}
