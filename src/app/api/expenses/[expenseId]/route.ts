import { NextResponse } from 'next/server'
import { isValidUUID } from '@/lib/uuid'
import { expenseService } from '@/services/expense.service'
import { groupService } from '@/services/group.service'
import {
  validateExpenseInput,
  handleApiError,
  requireActiveGroup,
  allGroupMembers,
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

    const { payerId, participants } = validation.data
    const involvedIds = [payerId, ...participants.map(p => p.userId)]
    if (!(await allGroupMembers(check.groupId, involvedIds))) {
      return NextResponse.json({ error: 'Pagador ou participante não é membro desta casa' }, { status: 400 })
    }

    const members = await groupService.listMembers(check.groupId)
    const memberIds = members.map(m => m.id)

    const expense = await expenseService.update(check.groupId, existingExpense.id, memberIds, validation.data)
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

    await expenseService.delete(check.groupId, expense.id)
    return NextResponse.json({ message: 'Despesa excluída com sucesso' })
  } catch (error) {
    return handleApiError(error, 'Erro ao excluir despesa')
  }
}
