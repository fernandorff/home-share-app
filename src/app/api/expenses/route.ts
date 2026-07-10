import { NextResponse } from 'next/server'
import { expenseService, VALID_SORT_FIELDS, type ExpenseFilterParams } from '@/services/expense.service'
import { groupService } from '@/services/group.service'
import { LIMITS } from '@/lib/constants'
import {
  validateExpenseInput,
  validateExpenseTags,
  handleApiError,
  requireActiveGroup,
  allActiveGroupMembers,
  recordActivity,
} from '@/lib/api-helpers'

// Defensive cap on how many chip values a single filter dimension can carry — a house never
// has anywhere near this many payers/tags, so this only guards against an abusive query string.
const MAX_FILTER_VALUES = 50
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Parses the expense list's filter bar (BL-20/P3) off the query string. Malformed values are
 *  dropped silently (same forgiving style as page/pageSize below) rather than 400ing — a stale
 *  filter chip should never break the whole list. Returns undefined when nothing was set, so
 *  `expenseService.list` can skip building a `where` clause entirely for the common case. */
function parseExpenseFilters(searchParams: URLSearchParams): ExpenseFilterParams | undefined {
  const query = (searchParams.get('query') || '').trim().slice(0, LIMITS.DESCRIPTION)
  const payerIds = searchParams.getAll('payerIds')
    .map(v => parseInt(v, 10))
    .filter(n => Number.isFinite(n))
    .slice(0, MAX_FILTER_VALUES)
  const platforms = searchParams.getAll('platforms').slice(0, MAX_FILTER_VALUES)
  const categories = searchParams.getAll('categories').slice(0, MAX_FILTER_VALUES)
  const paymentMethods = searchParams.getAll('paymentMethods').slice(0, MAX_FILTER_VALUES)
  const fromDateRaw = searchParams.get('fromDate')
  const toDateRaw = searchParams.get('toDate')
  // Local-day bounds (not noon, unlike the write path) so the range covers the WHOLE calendar
  // day regardless of what time-of-day an individual expense's date carries.
  const fromDate = fromDateRaw && ISO_DATE.test(fromDateRaw) ? new Date(`${fromDateRaw}T00:00:00`) : undefined
  const toDate = toDateRaw && ISO_DATE.test(toDateRaw) ? new Date(`${toDateRaw}T23:59:59`) : undefined

  if (!query && !payerIds.length && !platforms.length && !categories.length && !paymentMethods.length && !fromDate && !toDate) {
    return undefined
  }
  return {
    ...(query && { query }),
    ...(payerIds.length && { payerIds }),
    ...(platforms.length && { platforms }),
    ...(categories.length && { categories }),
    ...(paymentMethods.length && { paymentMethods }),
    ...(fromDate && { fromDate }),
    ...(toDate && { toDate }),
  }
}

export async function GET(request: Request) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const { searchParams } = new URL(request.url)
    // Guard against NaN / negative / absurd values reaching the query layer.
    const pageRaw = parseInt(searchParams.get('page') || '1', 10)
    const pageSizeRaw = parseInt(searchParams.get('pageSize') || '10', 10)
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1
    const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? Math.min(pageSizeRaw, 100_000) : 10
    const sortField = searchParams.get('sortField') || 'date'
    const sortDirection = searchParams.get('sortDirection') === 'asc' ? 'asc' as const : 'desc' as const

    if (!(VALID_SORT_FIELDS as readonly string[]).includes(sortField)) {
      return NextResponse.json({ error: `Campo de ordenação inválido: ${sortField}` }, { status: 400 })
    }

    const filters = parseExpenseFilters(searchParams)
    const result = await expenseService.list(check.groupId, { page, pageSize, sortField, sortDirection, filters })
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
    // Active only (BL-16) — an ex-member can't be assigned to a brand-new expense.
    if (!(await allActiveGroupMembers(check.groupId, involvedIds))) {
      return NextResponse.json({ error: 'Pagador ou participante não é membro desta casa' }, { status: 400 })
    }

    const tagError = await validateExpenseTags(check.groupId, validation.data)
    if (tagError) return tagError

    const members = await groupService.listMembers(check.groupId)
    // Active only — "split equally" must never include someone who left/was removed.
    const memberIds = members.filter(m => m.active).map(m => m.id)

    const expense = await expenseService.create(check.groupId, memberIds, validation.data)

    await recordActivity({
      groupId: check.groupId,
      actorId: check.session.userId,
      entityType: 'EXPENSE',
      entityId: expense.publicId,
      action: 'CREATE',
      summary: expense.description,
      changes: { amount: String(expense.amount) },
    })

    return NextResponse.json({ expense }, { status: 201 })
  } catch (error) {
    return handleApiError(error, 'Erro ao criar despesa')
  }
}
