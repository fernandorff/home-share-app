import { NextResponse } from 'next/server'
import { isValidUUID } from '@/lib/uuid'
import { expenseService } from '@/services/expense.service'
import { revisionService } from '@/services/revision.service'
import { handleApiError, requireActiveGroup } from '@/lib/api-helpers'

interface RouteParams {
  params: Promise<{ expenseId: string }>
}

// The change history of a single expense (from the EntityRevision trail).
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const { expenseId: expensePublicId } = await params
    if (!isValidUUID(expensePublicId)) {
      return NextResponse.json({ error: 'Invalid ID' }, { status: 400 })
    }

    // Group-scoped: never expose another house's expense. The trail keys on the internal id.
    const expense = await expenseService.findByPublicId(check.groupId, expensePublicId)
    if (!expense) {
      return NextResponse.json({ error: 'Expense not found' }, { status: 404 })
    }

    const revisions = await revisionService.listForEntity(check.groupId, 'Expense', String(expense.id))
    return NextResponse.json({ revisions })
  } catch (error) {
    return handleApiError(error, 'Failed to load expense history')
  }
}
