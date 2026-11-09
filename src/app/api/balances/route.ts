import { NextResponse } from 'next/server'
import { applySettlements, simplifyDebts } from '@/lib/balance'
import { settlementService } from '@/services/settlement.service'
import { handleApiError, requireActiveGroup } from '@/lib/api-helpers'
import { fromCents } from '@/lib/currency'
import { balanceService } from '@/services/balance.service'

// Finished response per house, valid while the house's version (bumped by database triggers on every write
// that changes it) is unchanged. ponytail: per process; a shared cache only if a measured miss rate asks for it.
const bodies = new Map<number, { version: bigint; body: string }>()

export async function GET(request: Request) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response
    const groupId = check.groupId

    // Read the version BEFORE computing: a write landing mid-way bumps it again, so a stale body is never
    // stored under a newer version.
    const version = await balanceService.version(groupId)
    const etag = `"g${groupId}v${version}"`
    if (request.headers.get('if-none-match') === etag) return new NextResponse(null, { status: 304, headers: { etag } })
    const hit = bodies.get(groupId)
    if (hit?.version === version) return new NextResponse(hit.body, { headers: { 'content-type': 'application/json', etag } })

    // Totals come precomputed (spec 013); recorded payments are folded in as signed transfers.
    const [rawBalances, spend, payments] = await Promise.all([
      balanceService.aggregate(groupId),
      balanceService.spend(groupId),
      settlementService.list(groupId),
    ])
    const balances = applySettlements(rawBalances, payments)
    const body = JSON.stringify({
      balances,
      settlements: simplifyDebts(balances),
      totalExpenses: fromCents(spend.totalCents),
      payments,
      byCategory: spend.byCategory,
      byMonth: spend.byMonth,
    })
    bodies.set(groupId, { version, body })
    return new NextResponse(body, { headers: { 'content-type': 'application/json', etag } })
  } catch (error) {
    return handleApiError(error, 'Erro ao calcular saldos')
  }
}
