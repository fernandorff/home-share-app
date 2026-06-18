import { NextResponse } from 'next/server'
import { shoppingItemService } from '@/services/shopping-item.service'
import { handleApiError, requireActiveGroup } from '@/lib/api-helpers'

export async function GET() {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const items = await shoppingItemService.list(check.groupId)
    return NextResponse.json({ items })
  } catch (error) {
    return handleApiError(error, 'Erro ao listar itens')
  }
}

export async function POST(request: Request) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const body = await request.json()
    const { name } = body

    if (!name || !name.trim()) {
      return NextResponse.json({ error: 'Nome é obrigatório' }, { status: 400 })
    }

    const item = await shoppingItemService.create(check.groupId, name, check.session.userId)
    return NextResponse.json({ item }, { status: 201 })
  } catch (error) {
    return handleApiError(error, 'Erro ao criar item')
  }
}
