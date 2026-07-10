import { NextResponse } from 'next/server'
import { isValidUUID } from '@/lib/uuid'
import { expenseService } from '@/services/expense.service'
import { groupService } from '@/services/group.service'
import {
  validateExpenseInput,
  validateExpenseTags,
  handleApiError,
  requireActiveGroup,
  allActiveGroupMembers,
  recordActivity,
} from '@/lib/api-helpers'

interface RouteParams {
  params: Promise<{ expenseId: string }>
}

export async function PUT(request: Request, { params }: RouteParams) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const { expenseId: expensePublicId } = await params

    if (!isValidUUID(expensePublicId)) {
      return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
    }

    const existingExpense = await expenseService.findByPublicId(check.groupId, expensePublicId)
    if (!existingExpense) {
      return NextResponse.json({ error: 'Despesa não encontrada' }, { status: 404 })
    }

    const body = await request.json()
    const validation = validateExpenseInput(body)
    if (!validation.valid) return validation.response

    // Optimistic-lock token: the client sends back the `updatedAt` it had when the edit form
    // opened. A mismatch means someone else saved this expense in the meantime (see expense.service.ts).
    const expectedUpdatedAt = typeof body.expectedUpdatedAt === 'string' ? body.expectedUpdatedAt : undefined

    // An ex-member (BL-16) already on THIS expense stays editable (grandfathered) — they just
    // can't be newly (re-)introduced here or offered for equal-split among everyone.
    const existingInvolvedIds = new Set([existingExpense.payerId, ...existingExpense.participants.map(p => p.userId)])

    const { payerId, participants } = validation.data
    const involvedIds = [payerId, ...participants.map(p => p.userId)]
    const newlyIntroducedIds = involvedIds.filter(id => !existingInvolvedIds.has(id))
    if (!(await allActiveGroupMembers(check.groupId, newlyIntroducedIds))) {
      return NextResponse.json({ error: 'Pagador ou participante não é membro desta casa' }, { status: 400 })
    }

    const tagError = await validateExpenseTags(check.groupId, validation.data)
    if (tagError) return tagError

    const members = await groupService.listMembers(check.groupId)
    const memberIds = members.filter(m => m.active || existingInvolvedIds.has(m.id)).map(m => m.id)

    const expense = await expenseService.update(
      check.groupId,
      existingExpense.id,
      check.session.userId,
      check.role === 'ADMIN',
      memberIds,
      validation.data,
      expectedUpdatedAt
    )

    // Field-level diff for the activity history (only what actually changed).
    const changes: Record<string, { from: string; to: string }> = {}
    if (existingExpense.description !== validation.data.description) {
      changes.description = { from: existingExpense.description, to: validation.data.description }
    }
    if (Number(existingExpense.amount) !== validation.data.amount) {
      changes.amount = { from: String(existingExpense.amount), to: String(validation.data.amount) }
    }
    await recordActivity({
      groupId: check.groupId,
      actorId: check.session.userId,
      entityType: 'EXPENSE',
      entityId: expense.publicId,
      action: 'UPDATE',
      summary: expense.description,
      changes: Object.keys(changes).length ? changes : undefined,
    })

    return NextResponse.json({ expense })
  } catch (error) {
    return handleApiError(error, 'Erro ao atualizar despesa')
  }
}

export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const { expenseId: expensePublicId } = await params

    if (!isValidUUID(expensePublicId)) {
      return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
    }

    const expense = await expenseService.findByPublicId(check.groupId, expensePublicId)
    if (!expense) {
      return NextResponse.json({ error: 'Despesa não encontrada' }, { status: 404 })
    }

    await expenseService.delete(check.groupId, expense.id, check.session.userId, check.role === 'ADMIN')

    await recordActivity({
      groupId: check.groupId,
      actorId: check.session.userId,
      entityType: 'EXPENSE',
      entityId: expense.publicId,
      action: 'DELETE',
      summary: expense.description,
      changes: { amount: String(expense.amount) },
    })

    return NextResponse.json({ message: 'Despesa excluída com sucesso' })
  } catch (error) {
    return handleApiError(error, 'Erro ao excluir despesa')
  }
}
