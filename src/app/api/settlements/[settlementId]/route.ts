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
      return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
    }

    const removed = await settlementService.delete(check.groupId, settlementId)

    await recordActivity({
      groupId: check.groupId,
      actorId: check.session.userId,
      entityType: 'SETTLEMENT',
      entityId: settlementId,
      action: 'DELETE',
      summary: `${removed.fromUser.name} → ${removed.toUser.name}`,
      changes: { amount: String(removed.amount) },
    })

    return NextResponse.json({ ok: true })
  } catch (error) {
    return handleApiError(error, 'Erro ao excluir pagamento')
  }
}
