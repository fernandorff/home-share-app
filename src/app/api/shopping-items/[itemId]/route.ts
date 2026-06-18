import { NextResponse } from 'next/server'
import { shoppingItemService } from '@/services/shopping-item.service'
import { isValidUUID } from '@/lib/uuid'
import { handleApiError, requireActiveGroup } from '@/lib/api-helpers'

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ itemId: string }> }
) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const { itemId } = await params
    if (!isValidUUID(itemId)) {
      return NextResponse.json({ error: 'ID de item inválido' }, { status: 400 })
    }

    const body = await request.json()
    const { name } = body

    if (!name || !name.trim()) {
      return NextResponse.json({ error: 'Nome é obrigatório' }, { status: 400 })
    }

    const item = await shoppingItemService.update(check.groupId, itemId, name)
    return NextResponse.json({ item })
  } catch (error) {
    return handleApiError(error, 'Erro ao atualizar item')
  }
}

export async function DELETE(
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

    await shoppingItemService.delete(check.groupId, itemId)
    return NextResponse.json({ success: true })
  } catch (error) {
    return handleApiError(error, 'Erro ao excluir item')
  }
}
