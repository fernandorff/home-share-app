import { NextResponse } from 'next/server'
import { isValidUUID } from '@/lib/uuid'
import { settlementService } from '@/services/settlement.service'
import { handleApiError, requireActiveGroup, recordActivity } from '@/lib/api-helpers'

interface RouteParams {
  params: Promise<{ settlementId: string }>
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const { settlementId } = await params
    if (!isValidUUID(settlementId)) {
      return NextResponse.json({ error: 'Invalid ID' }, { status: 400 })
    }

    const removed = await settlementService.delete(check.groupId, settlementId)

    await recordActivity({
      groupId: check.groupId,
      actorId: check.session.userId,
      entityType: 'SETTLEMENT',
      entityId: settlementId,
      action: 'DELETE',
      // Same staleness caveat as the CREATE path above (BL-16/BL-23) — fromUserId/toUserId let
      // the Activity Summary feed re-resolve the current display name instead of this snapshot.
      summary: `${removed.fromUser.name} → ${removed.toUser.name}`,
      changes: { amount: String(removed.amount), fromUserId: removed.fromUserId, toUserId: removed.toUserId },
    })

    return NextResponse.json({ ok: true })
  } catch (error) {
    return handleApiError(error, 'Failed to delete settlement')
  }
}
