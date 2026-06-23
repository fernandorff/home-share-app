import { NextResponse } from 'next/server'
import { settlementService } from '@/services/settlement.service'
import {
  validateSettlementInput,
  handleApiError,
  requireActiveGroup,
  allGroupMembers,
  recordActivity,
} from '@/lib/api-helpers'

export async function GET() {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const settlements = await settlementService.list(check.groupId)
    return NextResponse.json({ settlements })
  } catch (error) {
    return handleApiError(error, 'Erro ao listar pagamentos')
  }
}

export async function POST(request: Request) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const body = await request.json()
    const validation = validateSettlementInput(body)
    if (!validation.valid) return validation.response

    const { fromUserId, toUserId } = validation.data
    if (!(await allGroupMembers(check.groupId, [fromUserId, toUserId]))) {
      return NextResponse.json({ error: 'Pagador ou recebedor não é membro desta casa' }, { status: 400 })
    }

    const settlement = await settlementService.create(check.groupId, {
      ...validation.data,
      createdById: check.session.userId,
    })

    await recordActivity({
      groupId: check.groupId,
      actorId: check.session.userId,
      entityType: 'SETTLEMENT',
      entityId: settlement.publicId,
      action: 'CREATE',
      summary: `${settlement.fromUser.name} → ${settlement.toUser.name}`,
      changes: { amount: String(settlement.amount) },
    })

    return NextResponse.json({ settlement }, { status: 201 })
  } catch (error) {
    return handleApiError(error, 'Erro ao registrar pagamento')
  }
}
