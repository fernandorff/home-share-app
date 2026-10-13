import { prisma } from '@/lib/prisma'

// The recurring ledger's notion of "closed" (spec 008): a period with a ledger row, posted or skipped. One
// module for the poster (recurring-expense.service) and the due-date reminders (notification.service), so a
// reminder can never disagree with the poster about which month is still open. Imports neither service.

/** The rule's highest ledger period (posted or skipped), or null without a ledger row. */
export async function lastClosedPeriod(recurringExpenseId: number): Promise<string | null> {
  const row = await prisma.recurringExpenseOccurrence.findFirst({
    where: { recurringExpenseId },
    orderBy: { period: 'desc' },
    select: { period: true },
  })
  return row?.period ?? null
}

/** Each rule's highest ledger period, in one grouped query; rules without a ledger row are absent. */
export async function lastClosedPeriods(recurringExpenseIds: number[]): Promise<Map<number, string>> {
  if (recurringExpenseIds.length === 0) return new Map()
  const rows = await prisma.recurringExpenseOccurrence.groupBy({
    by: ['recurringExpenseId'],
    where: { recurringExpenseId: { in: recurringExpenseIds } },
    _max: { period: true },
  })
  return new Map(rows.flatMap((r) => (r._max.period ? [[r.recurringExpenseId, r._max.period] as const] : [])))
}
