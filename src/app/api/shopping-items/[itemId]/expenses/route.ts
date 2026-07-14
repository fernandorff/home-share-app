import { NextResponse } from 'next/server'
import { shoppingItemService } from '@/services/shopping-item.service'
import { isValidUUID } from '@/lib/uuid'
import {
  assertExpectedGroup,
  handleApiError,
  recordActivity,
  requireActiveGroup,
} from '@/lib/api-helpers'

const MAX_LINKS = 100

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ itemId: string }> }
) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const { itemId } = await params
    if (!isValidUUID(itemId)) {
      return NextResponse.json({ error: 'Invalid item ID', code: 'INVALID_EXPENSE_LINKS' }, { status: 400 })
    }

    const body = await request.json()
    const staleGroup = assertExpectedGroup(check.groupId, body.expectedGroupId)
    if (staleGroup) return staleGroup
    if (!Array.isArray(body.expenseIds) || body.expenseIds.some((id: unknown) => typeof id !== 'string' || !isValidUUID(id))) {
      return NextResponse.json({ error: 'Expense IDs must be valid UUIDs', code: 'INVALID_EXPENSE_LINKS' }, { status: 400 })
    }

    const expenseIds = [...new Set<string>(body.expenseIds)]
    if (expenseIds.length > MAX_LINKS) {
      return NextResponse.json({ error: `At most ${MAX_LINKS} expenses can be linked`, code: 'INVALID_EXPENSE_LINKS' }, { status: 400 })
    }

    const item = await shoppingItemService.replaceExpenseLinks(check.groupId, itemId, expenseIds)
    await recordActivity({
      groupId: check.groupId,
      actorId: check.session.userId,
      entityType: 'SHOPPING_ITEM',
      entityId: item.publicId,
      action: 'UPDATE',
      summary: item.name,
      changes: { linkedExpenseIds: expenseIds },
    })
    return NextResponse.json({ item })
  } catch (error) {
    return handleApiError(error, 'Failed to link expenses')
  }
}
