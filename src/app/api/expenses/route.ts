import { NextResponse } from 'next/server'
import { expenseService, VALID_SORT_FIELDS } from '@/services/expense.service'
import { groupService } from '@/services/group.service'
import {
  validateExpenseInput,
  handleApiError,
  requireActiveGroup,
  allGroupMembers,
} from '@/lib/api-helpers'

export async function GET(request: Request) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const { searchParams } = new URL(request.url)
    const page = parseInt(searchParams.get('page') || '1')
    const pageSize = parseInt(searchParams.get('pageSize') || '10')
    const sortField = searchParams.get('sortField') || 'date'
    const sortDirection = searchParams.get('sortDirection') === 'asc' ? 'asc' as const : 'desc' as const

    if (!(VALID_SORT_FIELDS as readonly string[]).includes(sortField)) {
      return NextResponse.json({ error: `Campo de ordenação inválido: ${sortField}` }, { status: 400 })
    }

    const result = await expenseService.list(check.groupId, { page, pageSize, sortField, sortDirection })
    return NextResponse.json(result)
  } catch (error) {
    return handleApiError(error, 'Erro ao listar despesas')
  }
}

export async function POST(request: Request) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

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

    const expense = await expenseService.create(check.groupId, memberIds, validation.data)
    return NextResponse.json({ expense }, { status: 201 })
  } catch (error) {
    return handleApiError(error, 'Erro ao criar despesa')
  }
}
