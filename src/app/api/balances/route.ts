import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { applySettlements, simplifyDebts, type Balance } from '@/lib/balance'
import { aggregateSpend } from '@/lib/insights'
import { settlementService } from '@/services/settlement.service'
import { handleApiError, requireActiveGroup } from '@/lib/api-helpers'
import { toCents, fromCents } from '@/lib/currency'

export async function GET() {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response
    const groupId = check.groupId

    // Balances = credit (what you paid as payer) - debit (your share as participant). These are
    // exact SUMs over Decimal(10,2), so we aggregate in the DB instead of hydrating every expense
    // with its participants+user (which grew unboundedly). Insights still need amount/categories/date,
    // fetched with a MINIMAL select and fed to the tested aggregateSpend (no SQL re-implementation).
    const [creditByPayer, debitByUser, spendRows, payments] = await Promise.all([
      prisma.expense.groupBy({ by: ['payerId'], where: { groupId }, _sum: { amount: true } }),
      prisma.expenseParticipant.groupBy({ by: ['userId'], where: { expense: { groupId } }, _sum: { amount: true } }),
      prisma.expense.findMany({ where: { groupId }, select: { amount: true, categories: true, date: true } }),
      settlementService.list(groupId),
    ])

    const creditCents = new Map<number, number>()
    for (const c of creditByPayer) creditCents.set(c.payerId, toCents(c._sum.amount ?? 0))
    const debitCents = new Map<number, number>()
    for (const d of debitByUser) debitCents.set(d.userId, toCents(d._sum.amount ?? 0))

    const userIds = new Set<number>([...creditCents.keys(), ...debitCents.keys()])
    const users = await prisma.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, name: true } })
    const nameById = new Map(users.map((u) => [u.id, u.name]))

    const rawBalances: Balance[] = [...userIds].map((id) => ({
      userId: id,
      userName: nameById.get(id) ?? '?',
      balance: fromCents((creditCents.get(id) ?? 0) - (debitCents.get(id) ?? 0)),
    }))

    // Recorded payments folded in as signed transfers.
    const balances = applySettlements(rawBalances, payments)
    const settlements = simplifyDebts(balances)
    const totalCents = spendRows.reduce((sum, e) => sum + toCents(e.amount), 0)
    const { byCategory, byMonth } = aggregateSpend(spendRows)

    return NextResponse.json({
      balances,
      settlements,
      totalExpenses: fromCents(totalCents),
      payments,
      byCategory,
      byMonth,
    })
  } catch (error) {
    return handleApiError(error, 'Erro ao calcular saldos')
  }
}
