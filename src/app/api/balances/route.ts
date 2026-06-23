import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { calculateBalances, applySettlements, simplifyDebts } from '@/lib/balance'
import { settlementService } from '@/services/settlement.service'
import { handleApiError, requireActiveGroup } from '@/lib/api-helpers'
import { toCents, fromCents } from '@/lib/currency'

export async function GET() {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const expenses = await prisma.expense.findMany({
      where: { groupId: check.groupId },
      include: {
        payer: { select: { id: true, name: true } },
        participants: {
          include: {
            user: { select: { id: true, name: true } }
          }
        }
      }
    })

    const payments = await settlementService.list(check.groupId)

    // Balances = expenses, then recorded payments folded in as signed transfers.
    const balances = applySettlements(calculateBalances(expenses), payments)
    const settlements = simplifyDebts(balances)
    // Total household SPEND = sum of every expense amount (not the sum of outstanding
    // credit, which is ~0 once everyone is split/settled).
    const totalCents = expenses.reduce((sum, e) => sum + toCents(e.amount), 0)

    return NextResponse.json({
      balances,
      settlements,
      totalExpenses: fromCents(totalCents),
      payments,
    })
  } catch (error) {
    return handleApiError(error, 'Erro ao calcular saldos')
  }
}
