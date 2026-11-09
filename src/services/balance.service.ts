import { fromCents } from '@/lib/currency'
import { prisma } from '@/lib/prisma'
import type { Balance } from '@/lib/balance'
import type { CategorySpend, MonthSpend } from '@/lib/insights'

// Reads the running totals that database triggers keep for every house (spec 013, migration
// 2_precomputed_balances): a few rows per house instead of a SUM over every expense.
export class BalanceService {
  /** Credit (paid as payer) minus debit (share as participant), per member, from the stored totals. */
  async aggregate(groupId: number): Promise<Balance[]> {
    const [credits, debits] = await Promise.all([
      prisma.balanceCredit.findMany({ where: { groupId }, orderBy: { userId: 'asc' } }),
      prisma.balanceDebit.findMany({ where: { groupId }, orderBy: { userId: 'asc' } }),
    ])

    const creditCents = new Map(credits.map((row) => [row.userId, Number(row.cents)]))
    const debitCents = new Map(debits.map((row) => [row.userId, Number(row.cents)]))
    const userIds = [...new Set([...creditCents.keys(), ...debitCents.keys()])]

    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true },
    })
    const nameById = new Map(users.map((user) => [user.id, user.name]))

    return userIds
      .map((userId) => ({
        userId,
        userName: nameById.get(userId) ?? '?',
        balance: fromCents((creditCents.get(userId) ?? 0) - (debitCents.get(userId) ?? 0)),
      }))
      .sort((a, b) => b.balance - a.balance)
  }

  /** Spend charts and the house total, from the stored totals (same split as `aggregateSpend`). */
  async spend(groupId: number): Promise<{ totalCents: number; byCategory: CategorySpend[]; byMonth: MonthSpend[] }> {
    const [categories, months] = await Promise.all([
      prisma.balanceCategoryTotal.findMany({ where: { groupId }, orderBy: [{ cents: 'desc' }, { category: 'asc' }] }),
      prisma.balanceMonthTotal.findMany({ where: { groupId }, orderBy: { month: 'desc' } }),
    ])
    return {
      totalCents: months.reduce((sum, row) => sum + Number(row.cents), 0),
      byCategory: categories.map((row) => ({ category: row.category, total: fromCents(Number(row.cents)) })),
      byMonth: months.map((row) => ({ month: row.month, total: fromCents(Number(row.cents)) })),
    }
  }

  /** Bumped by triggers on every write that changes this house's balances response. */
  async version(groupId: number): Promise<bigint> {
    const row = await prisma.groupVersion.findUnique({ where: { groupId } })
    return row?.v ?? BigInt(0)
  }
}

export const balanceService = new BalanceService()
