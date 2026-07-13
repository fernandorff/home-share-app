import { fromCents, toCents } from '@/lib/currency'
import { prisma } from '@/lib/prisma'
import type { Balance } from '@/lib/balance'

export class BalanceService {
  /** Aggregate the source-of-truth expense ledger for one house in PostgreSQL. */
  async aggregate(groupId: number): Promise<Balance[]> {
    const [creditByPayer, debitByUser] = await Promise.all([
      prisma.expense.groupBy({
        by: ['payerId'],
        where: { groupId },
        _sum: { amount: true },
      }),
      prisma.expenseParticipant.groupBy({
        by: ['userId'],
        where: { expense: { groupId } },
        _sum: { amount: true },
      }),
    ])

    const creditCents = new Map(
      creditByPayer.map((row) => [row.payerId, toCents(row._sum.amount ?? 0)])
    )
    const debitCents = new Map(
      debitByUser.map((row) => [row.userId, toCents(row._sum.amount ?? 0)])
    )
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
}

export const balanceService = new BalanceService()
