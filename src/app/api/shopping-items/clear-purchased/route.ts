import { NextResponse } from 'next/server'
import { shoppingItemService } from '@/services/shopping-item.service'
import { handleApiError, requireActiveGroup } from '@/lib/api-helpers'

export async function DELETE() {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const result = await shoppingItemService.clearPurchased(check.groupId)
    return NextResponse.json({ deleted: result.count })
  } catch (error) {
    return handleApiError(error, 'Erro ao limpar itens comprados')
  }
}
