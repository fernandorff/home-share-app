import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { toCents, fromCents } from '@/lib/currency'
import { verifySession, SessionPayload, SESSION_COOKIE, GROUP_COOKIE } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { ApiError } from '@/lib/errors'
import { LIMITS } from '@/lib/constants'
import { auditService, type AuditEntry } from '@/services/audit.service'
import { setAuditContext } from '@/lib/audit-context'
import { isExpenseCategory } from '@/lib/categories'
import { categoryService } from '@/services/category.service'

/** Append an activity-log entry. A logging failure NEVER breaks the user's mutation. */
export async function recordActivity(entry: AuditEntry): Promise<void> {
  try {
    await auditService.log(entry)
  } catch (e) {
    console.error('audit log failed', e)
  }
}

export function handleApiError(error: unknown, defaultMsg: string): NextResponse {
  // Expected, typed failures (not-found, invalid input) carry their own status/code.
  if (error instanceof ApiError) {
    return NextResponse.json(
      error.code ? { error: error.message, code: error.code } : { error: error.message },
      { status: error.status }
    )
  }
  // Anything else is unexpected: log the full detail server-side, but return a
  // generic message so we never leak stack traces, file paths, or DB internals.
  console.error(defaultMsg, error)
  return NextResponse.json({ error: defaultMsg }, { status: 500 })
}

export type SessionCheck =
  | { ok: true; session: SessionPayload }
  | { ok: false; response: NextResponse }

export async function requireSession(): Promise<SessionCheck> {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE)?.value
  const session = token ? await verifySession(token) : null
  if (!session) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Não autenticado', code: 'NOT_AUTHENTICATED' }, { status: 401 }),
    }
  }
  // Best-effort: stamp the audit actor for writes in this request.
  setAuditContext({ actorId: session.userId })
  return { ok: true, session }
}

export type GroupCheck =
  | { ok: true; session: SessionPayload; groupId: number; role: 'ADMIN' | 'MEMBER' }
  | { ok: false; response: NextResponse }

/**
 * Resolves the active group for the request: the group cookie is a preference,
 * membership in the database is the authority. Falls back to the user's first group.
 */
export async function requireActiveGroup(): Promise<GroupCheck> {
  const check = await requireSession()
  if (!check.ok) return check

  const cookieStore = await cookies()
  const preferredGroupId = Number(cookieStore.get(GROUP_COOKIE)?.value) || null

  const memberships = await prisma.groupMember.findMany({
    where: { userId: check.session.userId },
    orderBy: { createdAt: 'asc' },
    select: { groupId: true, role: true },
  })

  if (memberships.length === 0) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Você ainda não participa de nenhuma casa', code: 'NO_GROUP' },
        { status: 403 }
      ),
    }
  }

  const active =
    memberships.find(m => m.groupId === preferredGroupId) ?? memberships[0]

  setAuditContext({ groupId: active.groupId })
  return { ok: true, session: check.session, groupId: active.groupId, role: active.role }
}

/**
 * An expense category must be a system default (lib/categories) or one of the group's custom
 * categories. Returns an error response if invalid, or null if OK (including no category).
 */
export async function validateCategory(
  groupId: number,
  category: string | null | undefined
): Promise<NextResponse | null> {
  if (!category) return null
  if (isExpenseCategory(category)) return null
  if (await categoryService.existsInGroup(groupId, category)) return null
  return NextResponse.json({ error: 'Categoria inválida', code: 'INVALID_CATEGORY' }, { status: 400 })
}

/** Validates that the given users are all members of the group (payer/participants). */
export async function allGroupMembers(groupId: number, userIds: number[]): Promise<boolean> {
  if (userIds.length === 0) return true
  const count = await prisma.groupMember.count({
    where: { groupId, userId: { in: userIds } },
  })
  return count === new Set(userIds).size
}

interface ExpenseInputRaw {
  description?: string
  notes?: string
  category?: string
  amount?: number
  date?: string
  payerId?: number
  platformId?: number
  splitEqually?: boolean
  participants?: { userId: number; amount: number }[]
}

export interface ValidatedExpenseInput {
  description: string
  notes?: string
  category?: string | null
  amount: number
  date?: Date
  payerId: number
  platformId?: number | null
  splitEqually: boolean
  participants: { userId: number; amount: number }[]
}

export function validateExpenseInput(
  body: ExpenseInputRaw,
  options: { payerRequired?: boolean } = {}
): { valid: true; data: ValidatedExpenseInput } | { valid: false; response: NextResponse } {
  const { description, notes, category, amount, date, payerId, platformId, splitEqually = true, participants = [] } = body
  const { payerRequired = true } = options

  // Each failure carries a stable `code` so the client can show a translated, specific
  // message (via the ApiErrors i18n namespace) instead of a generic fallback.
  const fail = (error: string, code: string) =>
    ({ valid: false as const, response: NextResponse.json({ error, code }, { status: 400 }) })

  if (!description || description.trim() === '') {
    return fail('Descrição é obrigatória', 'DESCRIPTION_REQUIRED')
  }
  if (description.length > LIMITS.DESCRIPTION) {
    return fail(`Descrição muito longa (máx. ${LIMITS.DESCRIPTION} caracteres)`, 'DESCRIPTION_TOO_LONG')
  }
  if (notes && notes.length > LIMITS.NOTES) {
    return fail(`Observação muito longa (máx. ${LIMITS.NOTES} caracteres)`, 'NOTES_TOO_LONG')
  }
  if (!amount || amount <= 0) {
    return fail('Valor deve ser maior que zero', 'AMOUNT_INVALID')
  }
  // amount is stored as Decimal(10,2) — reject values that would overflow the column.
  if (toCents(amount) > 9_999_999_999) {
    return fail('Valor muito alto (máx. 99.999.999,99)', 'AMOUNT_TOO_HIGH')
  }
  // Category may be a system key or a house's custom name; the route confirms it's valid for the
  // group. Here we only bound its length.
  if (typeof category === 'string' && category.trim().length > LIMITS.CATEGORY_NAME) {
    return fail('Categoria inválida', 'INVALID_CATEGORY')
  }
  // Membership of payer/participants is validated by the route via allGroupMembers().
  if (payerRequired && !payerId) {
    return fail('Pagador é obrigatório', 'PAYER_REQUIRED')
  }

  // Custom split: every share must be a real, non-negative number, with no duplicate
  // participants, and the parts must sum exactly to the total (integer-cents comparison).
  if (!splitEqually) {
    if (participants.length === 0) {
      return fail('Divisão personalizada precisa de ao menos um participante', 'SPLIT_EMPTY')
    }
    const ids = participants.map(p => p.userId)
    if (new Set(ids).size !== ids.length) {
      return fail('Há um participante repetido na divisão', 'PARTICIPANT_DUPLICATE')
    }
    if (participants.some(p => !Number.isFinite(p.amount) || p.amount < 0)) {
      return fail('Valor de um participante não pode ser negativo', 'PARTICIPANT_NEGATIVE')
    }
    const totalCents = participants.reduce((sum, p) => sum + toCents(p.amount), 0)
    const totalParticipants = fromCents(totalCents)
    if (totalCents !== toCents(amount)) {
      return fail(
        `Soma dos valores dos participantes (${totalParticipants.toFixed(2)}) difere do valor total (${amount.toFixed(2)})`,
        'PARTICIPANTS_SUM_MISMATCH'
      )
    }
  }

  return {
    valid: true,
    data: {
      description,
      notes,
      category: typeof category === 'string' && category.trim() ? category.trim() : null,
      amount,
      date: date ? new Date(date + (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? 'T12:00:00' : '')) : undefined,
      payerId: payerId!,
      platformId: platformId ?? null,
      splitEqually,
      participants,
    }
  }
}

interface SettlementInputRaw {
  fromUserId?: number
  toUserId?: number
  amount?: number
  note?: string
  date?: string
}

export interface ValidatedSettlementInput {
  fromUserId: number
  toUserId: number
  amount: number
  note?: string | null
  date?: Date
}

export function validateSettlementInput(
  body: SettlementInputRaw
): { valid: true; data: ValidatedSettlementInput } | { valid: false; response: NextResponse } {
  const { fromUserId, toUserId, amount, note, date } = body
  const bad = (error: string, code: string) => ({ valid: false as const, response: NextResponse.json({ error, code }, { status: 400 }) })

  if (!Number.isInteger(fromUserId) || !Number.isInteger(toUserId)) return bad('Pagador e recebedor são obrigatórios', 'SETTLEMENT_USERS_REQUIRED')
  if (fromUserId === toUserId) return bad('O pagamento precisa ser entre duas pessoas diferentes', 'SETTLEMENT_SAME_USER')
  if (!amount || amount <= 0) return bad('Valor deve ser maior que zero', 'AMOUNT_INVALID')
  if (toCents(amount) > 9_999_999_999) return bad('Valor muito alto (máx. 99.999.999,99)', 'AMOUNT_TOO_HIGH')
  if (note && note.length > LIMITS.SETTLEMENT_NOTE) return bad(`Observação muito longa (máx. ${LIMITS.SETTLEMENT_NOTE} caracteres)`, 'NOTE_TOO_LONG')

  return {
    valid: true,
    data: {
      fromUserId: fromUserId!,
      toUserId: toUserId!,
      amount,
      note: note ?? null,
      date: date ? new Date(date + (/^\d{4}-\d{2}-\d{2}$/.test(date) ? 'T12:00:00' : '')) : undefined,
    },
  }
}
