import { NextResponse } from 'next/server'
import { shoppingItemService } from '@/services/shopping-item.service'
import { handleApiError, requireActiveGroup, recordActivity } from '@/lib/api-helpers'

export async function DELETE() {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const result = await shoppingItemService.clearPurchased(check.groupId)

    // A no-op clear (nothing was purchased) isn't worth an activity entry.
    if (result.count > 0) {
      await recordActivity({
        groupId: check.groupId,
        actorId: check.session.userId,
        entityType: 'SHOPPING_ITEM',
        action: 'CLEAR',
        summary: String(result.count),
      })
    }

    return NextResponse.json({ deleted: result.count })
  } catch (error) {
    return handleApiError(error, 'Erro ao limpar itens comprados')
  }
}
