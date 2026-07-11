import { NextResponse } from 'next/server'
import { shoppingItemService } from '@/services/shopping-item.service'
import { handleApiError, requireActiveGroup, recordActivity } from '@/lib/api-helpers'

export async function GET() {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const items = await shoppingItemService.list(check.groupId)
    return NextResponse.json({ items })
  } catch (error) {
    return handleApiError(error, 'Failed to list items')
  }
}

export async function POST(request: Request) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const body = await request.json()
    const { name } = body

    if (typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ error: 'Name is required', code: 'NAME_REQUIRED' }, { status: 400 })
    }
    if (name.trim().length > 200) {
      return NextResponse.json({ error: 'Name too long (max 200 characters)', code: 'NAME_TOO_LONG' }, { status: 400 })
    }

    const item = await shoppingItemService.create(check.groupId, name, check.session.userId)

    await recordActivity({
      groupId: check.groupId,
      actorId: check.session.userId,
      entityType: 'SHOPPING_ITEM',
      entityId: item.publicId,
      action: 'CREATE',
      summary: item.name,
    })

    return NextResponse.json({ item }, { status: 201 })
  } catch (error) {
    return handleApiError(error, 'Failed to create item')
  }
}
