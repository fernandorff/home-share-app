import { NextResponse } from 'next/server'
import { shoppingItemService } from '@/services/shopping-item.service'
import { isValidUUID } from '@/lib/uuid'
import { handleApiError, requireActiveGroup, recordActivity } from '@/lib/api-helpers'

export async function PATCH(
  _request: Request,
  { params }: { params: Promise<{ itemId: string }> }
) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const { itemId } = await params
    if (!isValidUUID(itemId)) {
      return NextResponse.json({ error: 'ID de item inválido' }, { status: 400 })
    }

    const item = await shoppingItemService.togglePurchased(check.groupId, itemId)

    await recordActivity({
      groupId: check.groupId,
      actorId: check.session.userId,
      entityType: 'SHOPPING_ITEM',
      entityId: item.publicId,
      action: 'UPDATE',
      summary: item.name,
      changes: { purchased: { from: !item.isPurchased, to: item.isPurchased } },
    })

    return NextResponse.json({ item })
  } catch (error) {
    return handleApiError(error, 'Erro ao alternar item')
  }
}
