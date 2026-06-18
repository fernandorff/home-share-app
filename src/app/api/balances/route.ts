import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { calculateBalances, simplifyDebts } from '@/lib/balance'
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

    const balances = calculateBalances(expenses)
    const settlements = simplifyDebts(balances)
    const totalCents = balances.reduce((sum, b) => sum + Math.max(0, toCents(b.balance)), 0)

    return NextResponse.json({
      balances,
      settlements,
      totalExpenses: fromCents(totalCents)
    })
  } catch (error) {
    return handleApiError(error, 'Erro ao calcular saldos')
  }
}
