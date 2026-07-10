import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { toCents, fromCents } from '@/lib/currency'
import { verifySession, VerifiedSession, SESSION_COOKIE, GROUP_COOKIE } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { ApiError } from '@/lib/errors'
import { LIMITS } from '@/lib/constants'
import { auditService, type AuditEntry } from '@/services/audit.service'
import { setAuditContext } from '@/lib/audit-context'
import { isExpenseCategory } from '@/lib/categories'
import { isDefaultPlatform } from '@/lib/platforms'
import { isDefaultPaymentMethod } from '@/lib/payment-methods'
import { categoryService } from '@/services/category.service'
import { platformService } from '@/services/platform.service'
import { paymentMethodService } from '@/services/payment-method.service'

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
  | { ok: true; session: VerifiedSession }
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

  // The token's sessionVersion must match the CURRENT DB value — logout / password-change bump
  // the column, which is what actually revokes every previously issued (otherwise stateless) JWT.
  const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { sessionVersion: true } })
  if (!user || user.sessionVersion !== session.sessionVersion) {
    // Clear the dead cookie here, not just on the client: middleware only checks JWT validity
    // (never sessionVersion, to avoid a DB round-trip on every page nav), so a still-present but
    // revoked cookie would make it treat the browser as "logged in" and bounce it straight back
    // out of /auth/login — an infinite redirect loop instead of reaching the sign-in form.
    const response = NextResponse.json({ error: 'Sessão expirada, faça login novamente', code: 'SESSION_REVOKED' }, { status: 401 })
    response.cookies.delete(SESSION_COOKIE)
    return { ok: false, response }
  }

  // Best-effort: stamp the audit actor for writes in this request.
  setAuditContext({ actorId: session.userId })
  return { ok: true, session }
}

export type GroupCheck =
  | { ok: true; session: VerifiedSession; groupId: number; role: 'ADMIN' | 'MEMBER' }
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

  // leftAt: null — a house you left/were kicked from (BL-16) must never resolve as your active
  // group again, even if the (now stale) group cookie still points at it.
  const memberships = await prisma.groupMember.findMany({
    where: { userId: check.session.userId, leftAt: null },
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

/** Each tag in a dimension must be a system default OR one of the group's custom entries. */
async function validateTagList(
  values: string[],
  isDefault: (v: string) => boolean,
  existsInGroup: (name: string) => Promise<boolean>,
  errorMsg: string,
  code: string
): Promise<NextResponse | null> {
  for (const v of values) {
    if (isDefault(v)) continue
    if (await existsInGroup(v)) continue
    return NextResponse.json({ error: errorMsg, code }, { status: 400 })
  }
  return null
}

/** Validates an expense's categories / platforms / payment methods against defaults + group customs. */
export async function validateExpenseTags(
  groupId: number,
  input: { categories: string[]; platforms: string[]; paymentMethods: string[] }
): Promise<NextResponse | null> {
  return (
    (await validateTagList(input.categories, isExpenseCategory, (n) => categoryService.existsInGroup(groupId, n), 'Categoria inválida', 'INVALID_CATEGORY')) ??
    (await validateTagList(input.platforms, isDefaultPlatform, (n) => platformService.existsInGroup(groupId, n), 'Plataforma inválida', 'INVALID_PLATFORM')) ??
    (await validateTagList(input.paymentMethods, isDefaultPaymentMethod, (n) => paymentMethodService.existsInGroup(groupId, n), 'Forma de pagamento inválida', 'INVALID_PAYMENT'))
  )
}

/** Validates that the given users were EVER members of the group (active or ex, BL-16) — used by
 *  settlements, where recording a payment involving an ex-member must stay possible so their
 *  locked balance can actually get resolved. */
export async function allGroupMembers(groupId: number, userIds: number[]): Promise<boolean> {
  if (userIds.length === 0) return true
  const count = await prisma.groupMember.count({
    where: { groupId, userId: { in: userIds } },
  })
  return count === new Set(userIds).size
}

/** Validates that the given users are CURRENTLY ACTIVE members of the group (BL-16) — used by
 *  expense create/update, where an ex-member must not be assignable to a brand-new expense. */
export async function allActiveGroupMembers(groupId: number, userIds: number[]): Promise<boolean> {
  if (userIds.length === 0) return true
  const count = await prisma.groupMember.count({
    where: { groupId, userId: { in: userIds }, leftAt: null },
  })
  return count === new Set(userIds).size
}

interface ExpenseInputRaw {
  description?: string
  notes?: string
  categories?: unknown
  platforms?: unknown
  paymentMethods?: unknown
  amount?: number
  date?: string
  payerId?: number
  splitEqually?: boolean
  participants?: { userId: number; amount: number }[]
}

export interface ValidatedExpenseInput {
  description: string
  notes?: string
  categories: string[]
  platforms: string[]
  paymentMethods: string[]
  amount: number
  date?: Date
  payerId: number
  splitEqually: boolean
  participants: { userId: number; amount: number }[]
}

/** True when `n` is a finite amount with at most 2 decimal places (a whole number of cents). */
function isCents(n: number): boolean {
  return Number.isFinite(n) && Math.abs(n - Math.round(n * 100) / 100) < 1e-9
}

/** Normalize a tag array from the request: strings only, trimmed, non-empty, deduped, bounded. */
function cleanTags(values: unknown, maxLen: number): string[] {
  if (!Array.isArray(values)) return []
  const out: string[] = []
  for (const v of values) {
    if (typeof v !== 'string') continue
    const t = v.trim()
    if (!t || t.length > maxLen) continue
    if (!out.includes(t)) out.push(t)
    if (out.length >= 20) break
  }
  return out
}

export function validateExpenseInput(
  body: ExpenseInputRaw,
  options: { payerRequired?: boolean } = {}
): { valid: true; data: ValidatedExpenseInput } | { valid: false; response: NextResponse } {
  const { description, notes, amount, date, payerId, splitEqually = true, participants = [] } = body
  const { payerRequired = true } = options
  const categories = cleanTags(body.categories, LIMITS.CATEGORY_NAME)
  const platforms = cleanTags(body.platforms, LIMITS.PLATFORM_NAME)
  const paymentMethods = cleanTags(body.paymentMethods, LIMITS.PAYMENT_NAME)

  // Each failure carries a stable `code` so the client can show a translated, specific
  // message (via the ApiErrors i18n namespace) instead of a generic fallback.
  const fail = (error: string, code: string) =>
    ({ valid: false as const, response: NextResponse.json({ error, code }, { status: 400 }) })

  // Wrong JSON field types (e.g. description sent as a number) bypass TS at runtime — guard
  // with typeof before calling string/array methods so a malformed body 400s instead of
  // crashing into a generic 500 (handleApiError's catch-all).
  if (typeof description !== 'string' || description.trim() === '') {
    return fail('Descrição é obrigatória', 'DESCRIPTION_REQUIRED')
  }
  if (description.length > LIMITS.DESCRIPTION) {
    return fail(`Descrição muito longa (máx. ${LIMITS.DESCRIPTION} caracteres)`, 'DESCRIPTION_TOO_LONG')
  }
  if (notes !== undefined && notes !== null && typeof notes !== 'string') {
    return fail('Observação inválida', 'NOTES_INVALID')
  }
  if (notes && notes.length > LIMITS.NOTES) {
    return fail(`Observação muito longa (máx. ${LIMITS.NOTES} caracteres)`, 'NOTES_TOO_LONG')
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    return fail('Valor deve ser maior que zero', 'AMOUNT_INVALID')
  }
  // Reject sub-cent precision: Decimal(10,2) rounds the decimal string while our cents math
  // uses float rounding — divergent rounding would break the participants-sum == total invariant.
  if (!isCents(amount)) {
    return fail('Valor deve ter no máximo 2 casas decimais', 'AMOUNT_PRECISION')
  }
  // amount is stored as Decimal(10,2) — reject values that would overflow the column.
  if (toCents(amount) > 9_999_999_999) {
    return fail('Valor muito alto (máx. 99.999.999,99)', 'AMOUNT_TOO_HIGH')
  }
  // Tags (categories/platforms/paymentMethods) are cleaned above; the route confirms each value is
  // a system default or a group custom via validateExpenseTags.
  // Membership of payer/participants is validated by the route via allGroupMembers().
  if (payerRequired && !payerId) {
    return fail('Pagador é obrigatório', 'PAYER_REQUIRED')
  }

  if (!Array.isArray(participants)) {
    return fail('Lista de participantes inválida', 'PARTICIPANTS_INVALID')
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
    if (participants.some(p => !isCents(p.amount))) {
      return fail('Valor de um participante deve ter no máximo 2 casas decimais', 'PARTICIPANT_PRECISION')
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

  let parsedDate: Date | undefined
  if (date) {
    const raw = typeof date === 'string' ? date : String(date)
    parsedDate = new Date(raw + (/^\d{4}-\d{2}-\d{2}$/.test(raw) ? 'T12:00:00' : ''))
    if (Number.isNaN(parsedDate.getTime())) {
      return fail('Data inválida', 'DATE_INVALID')
    }
  }

  return {
    valid: true,
    data: {
      description,
      notes,
      categories,
      platforms,
      paymentMethods,
      amount,
      date: parsedDate,
      payerId: payerId!,
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
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return bad('Valor deve ser maior que zero', 'AMOUNT_INVALID')
  if (!isCents(amount)) return bad('Valor deve ter no máximo 2 casas decimais', 'AMOUNT_PRECISION')
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
