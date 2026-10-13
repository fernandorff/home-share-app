import { NextResponse, after } from 'next/server'
import { cookies, headers } from 'next/headers'
import { flush } from '@sentry/nextjs'
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
import { logger } from '@/lib/logger'
import { captureServerError, setObservedHouse, setObservedUser } from '@/lib/observability/context'
import { readRequestContext, type RequestContext } from '@/lib/observability/request-context'
import type { NotificationType } from '@/lib/notifications'

/** Append an activity-log entry. A logging failure NEVER breaks the user's mutation. */
export async function recordActivity(entry: AuditEntry): Promise<void> {
  try {
    await auditService.log(entry)
  } catch (e) {
    logger.error('audit log failed', { entityType: entry.entityType }, e)
  }
}

/**
 * Run a notice producer once the action committed (spec 009). Same contract as recordActivity: a notice
 * failure is logged (type only, never the params) and NEVER fails or rolls back the action (criterion 10).
 * A thunk, so a producer that throws before returning its promise is caught too.
 */
export async function notifySafely(type: NotificationType, produce: () => Promise<unknown>): Promise<void> {
  try {
    await produce()
  } catch (e) {
    logger.error('notification failed', { type }, e)
  }
}

/**
 * Optimistic guard against a house-switch race: if the client sends the `expectedGroupId` it
 * believed was active (e.g. an expense form opened before the user switched houses in another
 * tab), and it no longer matches the authoritative active house (from the cookie), reject with 409
 * so the write never lands in the wrong house. Returns null (no error) when absent or matching.
 * The cookie stays the source of truth — this only DETECTS divergence, it never selects the house.
 */
export function assertExpectedGroup(activeGroupId: number, expectedGroupId: unknown): NextResponse | null {
  if (typeof expectedGroupId === 'number' && expectedGroupId !== activeGroupId) {
    return NextResponse.json(
      { error: 'Your active house changed in another tab. Reload to continue.', code: 'STALE_GROUP' },
      { status: 409 }
    )
  }
  return null
}

/**
 * CSRF guard for cookie-authenticated writes that take no other proof (spec 010: the push routes). The session cookie
 * is SameSite=Lax, so a sibling subdomain still sends it. A form (text/plain, urlencoded, multipart) or a no-cors fetch
 * cannot send application/json; a cross-origin fetch that does gets a CORS preflight this app never answers.
 */
export function isJsonRequest(request: Request): boolean {
  return (request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')
}

/** The answer to a write that is not JSON (isJsonRequest): 415, translated client-side from ApiErrors. */
export function notJson(): NextResponse {
  return NextResponse.json({ error: 'Send application/json', code: 'UNSUPPORTED_MEDIA_TYPE' }, { status: 415 })
}

/** Request-scoped context stamped by the middleware (spec 007); empty outside a request (tests, scripts). */
async function currentRequestContext(): Promise<RequestContext> {
  try {
    return readRequestContext(await headers())
  } catch {
    return {}
  }
}

/**
 * Serverless (Vercel): the function can be frozen right after the response, and the SDK only sends its
 * queue on a timer — so a captured 5xx would sit unsent. after() runs once the response is out and keeps
 * the function alive until the flush ends. Best effort: it never throws into the response, and outside a
 * request scope (tests, scripts) after() throws and there is nothing to keep alive. Kept here, not in
 * observability/context.ts: the browser imports that file and `next/server` must stay out of its bundle.
 */
function flushSentryAfterResponse(): void {
  try {
    after(async () => {
      try {
        await flush(2000)
      } catch {
        // delivery is best effort
      }
    })
  } catch {
    // outside a request scope
  }
}

/**
 * Runs `task` once the response is out (after()). Outside a request scope after() throws, so the task runs
 * right away instead. Never throws into the caller: a write that already committed must not turn into a 500
 * (a client retry would duplicate it).
 */
export function afterResponse(task: () => Promise<unknown>): void {
  try {
    after(task)
  } catch {
    void task()
  }
}

function apiErrorResponse(error: ApiError): NextResponse {
  return NextResponse.json(
    error.code ? { error: error.message, code: error.code } : { error: error.message },
    { status: error.status }
  )
}

export async function handleApiError(error: unknown, defaultMsg: string): Promise<NextResponse> {
  // Expected, typed 4xx failures (not-found, invalid input) are normal operation: answered with their
  // own status/code and never reported (spec 007 — they are not defects).
  if (error instanceof ApiError && error.status < 500) {
    return apiErrorResponse(error)
  }
  // Server failures: one Sentry event (no-op without a DSN) + one JSON log line, correlated by requestId.
  const status = error instanceof ApiError ? error.status : 500
  const code = error instanceof ApiError ? error.code : undefined
  const context = await currentRequestContext()
  const sentryEventId = captureServerError(error, { route: context.route, requestId: context.requestId, status, code })
  if (sentryEventId) flushSentryAfterResponse()
  logger.error(defaultMsg, { ...context, status, code, sentryEventId }, error)
  if (error instanceof ApiError) return apiErrorResponse(error)
  // Unexpected: generic message so we never leak stack traces, file paths, or DB internals.
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
      response: NextResponse.json({ error: 'Not authenticated', code: 'NOT_AUTHENTICATED' }, { status: 401 }),
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
    const response = NextResponse.json({ error: 'Session expired, please log in again', code: 'SESSION_REVOKED' }, { status: 401 })
    response.cookies.delete(SESSION_COOKIE)
    return { ok: false, response }
  }

  // Best-effort: stamp the audit actor for writes in this request.
  setAuditContext({ actorId: session.userId })
  // Observability (spec 007): the opaque publicId is the only user data Sentry ever gets.
  setObservedUser(session.publicId)
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
    select: { groupId: true, role: true, group: { select: { publicId: true } } },
  })

  if (memberships.length === 0) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'You are not a member of any house yet', code: 'NO_GROUP' },
        { status: 403 }
      ),
    }
  }

  const active =
    memberships.find(m => m.groupId === preferredGroupId) ?? memberships[0]

  setAuditContext({ groupId: active.groupId })
  setObservedHouse(active.group.publicId)
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
    (await validateTagList(input.categories, isExpenseCategory, (n) => categoryService.existsInGroup(groupId, n), 'Invalid category', 'INVALID_CATEGORY')) ??
    (await validateTagList(input.platforms, isDefaultPlatform, (n) => platformService.existsInGroup(groupId, n), 'Invalid platform', 'INVALID_PLATFORM')) ??
    (await validateTagList(input.paymentMethods, isDefaultPaymentMethod, (n) => paymentMethodService.existsInGroup(groupId, n), 'Invalid payment method', 'INVALID_PAYMENT'))
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

// C0 control chars except tab (\x09), newline (\x0a) and carriage return (\x0d) — NUL in
// particular is unstorable in a Postgres text column and would crash the write into a 500.
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f]/

/**
 * Parse a user-supplied date into a Date, or return null if it's not a real calendar date.
 * `new Date('2026-02-30')` doesn't throw — JS rolls it over to Mar 2 (found in QA: impossible
 * dates were silently accepted and shifted). For bare `YYYY-MM-DD` we verify the parsed Date's
 * components round-trip to the input (rejecting 02-30, 13-01, etc.) and bound the year to a sane
 * range. Other string forms (with time) fall back to a plain NaN check.
 */
function parseInputDate(date: unknown): Date | null | undefined {
  if (date === undefined || date === null || date === '') return undefined
  const raw = typeof date === 'string' ? date : String(date)
  const isoDay = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  if (isoDay) {
    const [, ys, ms, ds] = isoDay
    const y = Number(ys), m = Number(ms), d = Number(ds)
    if (y < 2000 || y > 2100) return null
    const parsed = new Date(`${raw}T12:00:00`)
    if (parsed.getFullYear() !== y || parsed.getMonth() + 1 !== m || parsed.getDate() !== d) return null
    return parsed
  }
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed
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
    return fail('Description is required', 'DESCRIPTION_REQUIRED')
  }
  if (description.length > LIMITS.DESCRIPTION) {
    return fail(`Description too long (max ${LIMITS.DESCRIPTION} characters)`, 'DESCRIPTION_TOO_LONG')
  }
  // Postgres text columns can't hold a NUL byte — it reaches the DB write and crashes into a
  // generic 500 (found in QA). Reject it (and any C0 control char except tab/newline) as 400.
  if (CONTROL_CHARS.test(description)) {
    return fail('Description contains invalid characters', 'DESCRIPTION_INVALID')
  }
  if (notes !== undefined && notes !== null && typeof notes !== 'string') {
    return fail('Invalid notes', 'NOTES_INVALID')
  }
  if (notes && notes.length > LIMITS.NOTES) {
    return fail(`Notes too long (max ${LIMITS.NOTES} characters)`, 'NOTES_TOO_LONG')
  }
  if (notes && CONTROL_CHARS.test(notes)) {
    return fail('Notes contain invalid characters', 'NOTES_INVALID')
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    return fail('Amount must be greater than zero', 'AMOUNT_INVALID')
  }
  // Reject sub-cent precision: Decimal(10,2) rounds the decimal string while our cents math
  // uses float rounding — divergent rounding would break the participants-sum == total invariant.
  if (!isCents(amount)) {
    return fail('Amount must have at most 2 decimal places', 'AMOUNT_PRECISION')
  }
  // amount is stored as Decimal(10,2) — reject values that would overflow the column.
  if (toCents(amount) > 9_999_999_999) {
    return fail('Amount too high (max 99,999,999.99)', 'AMOUNT_TOO_HIGH')
  }
  // Tags (categories/platforms/paymentMethods) are cleaned above; the route confirms each value is
  // a system default or a group custom via validateExpenseTags.
  // Membership of payer/participants is validated by the route via allGroupMembers().
  if (payerRequired && !payerId) {
    return fail('Payer is required', 'PAYER_REQUIRED')
  }

  if (!Array.isArray(participants)) {
    return fail('Invalid participants list', 'PARTICIPANTS_INVALID')
  }

  // Custom split: every share must be a real, non-negative number, with no duplicate
  // participants, and the parts must sum exactly to the total (integer-cents comparison).
  if (!splitEqually) {
    if (participants.length === 0) {
      return fail('A custom split needs at least one participant', 'SPLIT_EMPTY')
    }
    const ids = participants.map(p => p.userId)
    if (new Set(ids).size !== ids.length) {
      return fail('There is a duplicate participant in the split', 'PARTICIPANT_DUPLICATE')
    }
    if (participants.some(p => !Number.isFinite(p.amount) || p.amount < 0)) {
      return fail("A participant's amount cannot be negative", 'PARTICIPANT_NEGATIVE')
    }
    if (participants.some(p => !isCents(p.amount))) {
      return fail("A participant's amount must have at most 2 decimal places", 'PARTICIPANT_PRECISION')
    }
    const totalCents = participants.reduce((sum, p) => sum + toCents(p.amount), 0)
    const totalParticipants = fromCents(totalCents)
    if (totalCents !== toCents(amount)) {
      return fail(
        `Sum of participant amounts (${totalParticipants.toFixed(2)}) differs from the total amount (${amount.toFixed(2)})`,
        'PARTICIPANTS_SUM_MISMATCH'
      )
    }
  }

  const parsedDate = parseInputDate(date)
  if (parsedDate === null) {
    return fail('Invalid date', 'DATE_INVALID')
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

  if (!Number.isInteger(fromUserId) || !Number.isInteger(toUserId)) return bad('Payer and recipient are required', 'SETTLEMENT_USERS_REQUIRED')
  if (fromUserId === toUserId) return bad('The payment must be between two different people', 'SETTLEMENT_SAME_USER')
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return bad('Amount must be greater than zero', 'AMOUNT_INVALID')
  if (!isCents(amount)) return bad('Amount must have at most 2 decimal places', 'AMOUNT_PRECISION')
  if (toCents(amount) > 9_999_999_999) return bad('Amount too high (max 99,999,999.99)', 'AMOUNT_TOO_HIGH')
  if (note && note.length > LIMITS.SETTLEMENT_NOTE) return bad(`Note too long (max ${LIMITS.SETTLEMENT_NOTE} characters)`, 'NOTE_TOO_LONG')

  const parsedDate = parseInputDate(date)
  if (parsedDate === null) return bad('Invalid date', 'DATE_INVALID')

  return {
    valid: true,
    data: {
      fromUserId: fromUserId!,
      toUserId: toUserId!,
      amount,
      note: note ?? null,
      date: parsedDate,
    },
  }
}
