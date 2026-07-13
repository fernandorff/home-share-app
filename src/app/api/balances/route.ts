import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { applySettlements, simplifyDebts } from '@/lib/balance'
import { aggregateSpend } from '@/lib/insights'
import { settlementService } from '@/services/settlement.service'
import { handleApiError, requireActiveGroup } from '@/lib/api-helpers'
import { toCents, fromCents } from '@/lib/currency'
import { balanceService } from '@/services/balance.service'

export async function GET() {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response
    const groupId = check.groupId

    // Balances = credit (what you paid as payer) - debit (your share as participant). These are
    // exact SUMs over Decimal(10,2), so we aggregate in the DB instead of hydrating every expense
    // with its participants+user (which grew unboundedly). Insights still need amount/categories/date,
    // fetched with a MINIMAL select and fed to the tested aggregateSpend (no SQL re-implementation).
    const [rawBalances, spendRows, payments] = await Promise.all([
      balanceService.aggregate(groupId),
      prisma.expense.findMany({ where: { groupId }, select: { amount: true, categories: true, date: true } }),
      settlementService.list(groupId),
    ])

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
