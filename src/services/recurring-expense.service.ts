import { prisma } from '@/lib/prisma'
import { uuidv7, isValidUUID } from '@/lib/uuid'
import { ApiError } from '@/lib/errors'
import { LIMITS } from '@/lib/constants'
import { toCents, fromCents, splitCents, toNumber } from '@/lib/currency'
import { dueOn, eligiblePeriods, isValidPeriod, isValidTimeZone, localToday, periodOf, upcomingPeriods, type UpcomingPeriod } from '@/lib/recurrence'
import { runWithAuditContext } from '@/lib/audit-context'
import { logger } from '@/lib/logger'
import { expenseService, type TransactionClient } from '@/services/expense.service'
import { auditService } from '@/services/audit.service'
import { notificationService } from '@/services/notification.service'
import { lastClosedPeriod, lastClosedPeriods } from '@/services/recurring-ledger'
import type {
  Prisma,
  RecurringExpense as RecurringExpenseRow,
  RecurringOccurrenceStatus,
  RecurringPauseReason,
  RecurringSplitMode,
} from '@/generated/prisma/client'

// Recurring expenses (spec 008): monthly rules that post an expense by themselves, and the idempotent
// poster behind the daily cron and the rule routes (ADR 0010). Money is integer cents (ADR 0003); posted
// expenses go through ExpenseService.create, so splits, audit revisions and balances work unchanged.

/** Abuse bounds (design › Security & tenant isolation). */
export const RECURRING_LIMITS = {
  RULES_PER_HOUSE: 50,
  PARTICIPANTS: 50,
  /** Periods one rule may post in one run (catch-up after missed runs). */
  CATCH_UP: 12,
  HISTORY: 50,
  UPCOMING: 3,
} as const

/** Who is acting: the session user and their role in the active house. */
export interface RecurringViewer {
  userId: number
  role: 'ADMIN' | 'MEMBER'
}

export interface RecurringExpenseInput {
  description: string
  amount: number
  dayOfMonth: number
  payerId: number
  splitMode: RecurringSplitMode
  /** SELECTED only — empty for ALL. Order matters: the leftover cents of the split go to the first ones. */
  participantIds: number[]
  timezone: string
}

/** The editable fields (the timezone is fixed at creation). */
export type RecurringExpensePatch = Partial<Omit<RecurringExpenseInput, 'timezone'>>

export interface RecurringExpenseDto {
  publicId: string
  description: string
  amount: string
  dayOfMonth: number
  payerId: number
  splitMode: RecurringSplitMode
  participantIds: number[]
  timezone: string
  activeFrom: string
  paused: boolean
  pauseReason: RecurringPauseReason | null
  /** Only periods without a ledger row. */
  skippedPeriods: string[]
  /** Highest ledger period. */
  lastClosedPeriod: string | null
  /** Next 3 periods; empty while paused. */
  upcoming: UpcomingPeriod[]
  /** The viewer is the payer or an admin. */
  canManage: boolean
  /** ISO — the expectedUpdatedAt token. */
  updatedAt: string
}

export interface RecurringHistoryItemDto {
  period: string
  dueOn: string
  status: RecurringOccurrenceStatus
  rule: { publicId: string; description: string }
  /** Null for a skipped period, and after the posted expense was deleted. */
  expense: { publicId: string; amount: string; payerId: number; participantCount: number } | null
}

export interface RecurringSummaryDto {
  /** Sum of the unpaused rules. */
  monthlyTotal: string
  /** The viewer's share of the unpaused rules — the same integer-cents split the posting writes. */
  myMonthlyShare: string
  activeCount: number
  pausedCount: number
}

export interface RecurringExpenseListDto {
  rules: RecurringExpenseDto[]
  summary: RecurringSummaryDto
  history: RecurringHistoryItemDto[]
}

/** `{ from, to }` per changed field — the Activity Summary payload of an edit. */
export type RecurringExpenseChanges = Record<string, { from: Prisma.InputJsonValue; to: Prisma.InputJsonValue }>

export interface PostDueOptions {
  /** Only this rule (the routes' synchronous run after create, edit or resume). */
  recurringExpenseId?: number
  /** Rules not started before this instant, and a started rule's later months, wait for the next run (`remaining`). */
  deadline?: Date
}

export interface PostDueResult {
  posted: number
  skipped: number
  /** Rules auto-paused because the payer or a selected participant left (MEMBER_LEFT). */
  paused: number
  /** Periods another run claimed first (the ledger's unique (rule, period)) — harmless by construction. */
  duplicates: number
  /** Rules whose posting threw unexpectedly: logged, rolled back, retried by the next run. */
  failed: number
  remaining: number
}

// ── Validation (pure) ─────────────────────────────────────────────────────────────────────────────

// Same rules as validateExpenseInput (api-helpers), restated here because services stay framework-free.
// C0 control chars except tab, newline and carriage return — NUL is unstorable in a Postgres text column.
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f]/
// Decimal(10,2) column bound.
const MAX_AMOUNT_CENTS = 9_999_999_999
// Postgres Int (ids) — a larger number would crash the query into a 500.
const MAX_INT = 2_147_483_647
const EDITABLE_FIELDS = ['description', 'amount', 'dayOfMonth', 'payerId', 'splitMode', 'participantIds'] as const

const invalid = (message: string, code: string) => new ApiError(message, 400, code)

function asRecord(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
}

function isId(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) <= MAX_INT
}

/** A finite amount with at most 2 decimal places (a whole number of cents). */
function isCents(n: number): boolean {
  return Math.abs(n - Math.round(n * 100) / 100) < 1e-9
}

function parseDescription(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalid('Description is required', 'DESCRIPTION_REQUIRED')
  if (value.length > LIMITS.DESCRIPTION) {
    throw invalid(`Description too long (max ${LIMITS.DESCRIPTION} characters)`, 'DESCRIPTION_TOO_LONG')
  }
  if (CONTROL_CHARS.test(value)) throw invalid('Description contains invalid characters', 'DESCRIPTION_INVALID')
  return value.trim()
}

function parseAmount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw invalid('Amount must be greater than zero', 'AMOUNT_INVALID')
  }
  if (!isCents(value)) throw invalid('Amount must have at most 2 decimal places', 'AMOUNT_PRECISION')
  if (toCents(value) > MAX_AMOUNT_CENTS) throw invalid('Amount too high (max 99,999,999.99)', 'AMOUNT_TOO_HIGH')
  return value
}

function parsePayer(value: unknown): number {
  if (!isId(value)) throw invalid('Payer is required', 'PAYER_REQUIRED')
  return value
}

function parseDay(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 31) {
    throw invalid('Day of month must be a whole number from 1 to 31', 'RECURRING_DAY_INVALID')
  }
  return value as number
}

function parseSplitMode(value: unknown): RecurringSplitMode {
  if (value !== 'ALL' && value !== 'SELECTED') throw invalid('Split must be ALL or SELECTED', 'RECURRING_SPLIT_INVALID')
  return value
}

/** Distinct user ids, at most 50 (the 1-person minimum applies to SELECTED and is checked by the caller). */
function parseParticipantIds(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    value.length > RECURRING_LIMITS.PARTICIPANTS ||
    !value.every(isId) ||
    new Set(value).size !== value.length
  ) {
    throw invalid(`Choose 1 to ${RECURRING_LIMITS.PARTICIPANTS} different people`, 'RECURRING_SPLIT_INVALID')
  }
  return [...value]
}

function requireParticipants(splitMode: RecurringSplitMode, participantIds: number[]): void {
  if (splitMode === 'SELECTED' && participantIds.length === 0) {
    throw invalid(`Choose 1 to ${RECURRING_LIMITS.PARTICIPANTS} different people`, 'RECURRING_SPLIT_INVALID')
  }
}

function parseTimeZone(value: unknown): string {
  if (!isValidTimeZone(value)) throw invalid('Unknown timezone', 'RECURRING_TIMEZONE_INVALID')
  // Stored under the name Intl resolves ("america/sao_paulo" → "America/Sao_Paulo").
  return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone
}

/** Validates a create body (criteria 1–2); throws ApiError(400, code). Membership is checked by `create`. */
export function parseRecurringExpenseInput(raw: unknown): RecurringExpenseInput {
  const body = asRecord(raw) ?? {}
  const description = parseDescription(body.description)
  const amount = parseAmount(body.amount)
  const payerId = parsePayer(body.payerId)
  const dayOfMonth = parseDay(body.dayOfMonth)
  const splitMode = parseSplitMode(body.splitMode)
  const participantIds = splitMode === 'SELECTED' ? parseParticipantIds(body.participantIds) : []
  requireParticipants(splitMode, participantIds)
  const timezone = parseTimeZone(body.timezone)
  return { description, amount, dayOfMonth, payerId, splitMode, participantIds, timezone }
}

/**
 * Validates the editable fields present in an edit body (criterion 16); throws ApiError(400, code).
 * Nothing editable → RECURRING_PATCH_INVALID. The split is resolved against the stored rule by `update`.
 */
export function parseRecurringExpensePatch(raw: unknown): RecurringExpensePatch {
  const body = asRecord(raw)
  const present = (key: (typeof EDITABLE_FIELDS)[number]) => body !== null && body[key] !== undefined
  if (!body || !EDITABLE_FIELDS.some(present)) {
    throw invalid('Nothing to change', 'RECURRING_PATCH_INVALID')
  }
  const patch: RecurringExpensePatch = {}
  if (present('description')) patch.description = parseDescription(body.description)
  if (present('amount')) patch.amount = parseAmount(body.amount)
  if (present('payerId')) patch.payerId = parsePayer(body.payerId)
  if (present('dayOfMonth')) patch.dayOfMonth = parseDay(body.dayOfMonth)
  if (present('splitMode')) patch.splitMode = parseSplitMode(body.splitMode)
  if (present('participantIds')) patch.participantIds = parseParticipantIds(body.participantIds)
  return patch
}

// ── Helpers ───────────────────────────────────────────────────────────────────────────────────────

/** `YYYY-MM-DD` of a `@db.Date` column (Prisma reads it as UTC midnight). */
const isoDate = (date: Date) => date.toISOString().slice(0, 10)
/** A `YYYY-MM-DD` local date as a `@db.Date` value. */
const dateOnly = (day: string) => new Date(`${day}T00:00:00Z`)
const money = (cents: number) => fromCents(cents).toFixed(2)
const moneyOf = (value: { toString(): string }) => money(toCents(value))

const notFound = () => new ApiError('Recurring expense not found in this house', 404, 'RECURRING_NOT_FOUND')
const stale = () =>
  new ApiError('This rule was changed by someone else. Reload to see the latest version.', 409, 'STALE_RECURRING_EXPENSE')

function prismaCode(e: unknown): unknown {
  return e !== null && typeof e === 'object' && 'code' in e ? (e as { code?: unknown }).code : undefined
}

const LEDGER_KEY_INDEX = 'RecurringExpenseOccurrence_recurringExpenseId_period_key'

/**
 * A P2002 on the ledger's unique (recurringExpenseId, period) — another run's claim. Prisma reports the key
 * as `meta.target`, or (driver adapters) as the constraint's fields/index; pg quotes camelCase fields.
 */
function isLedgerClaimConflict(e: unknown): boolean {
  if (prismaCode(e) !== 'P2002') return false
  const meta = (e as { meta?: Record<string, unknown> }).meta ?? {}
  const constraint = (meta.driverAdapterError as { cause?: { constraint?: Record<string, unknown> } } | undefined)?.cause
    ?.constraint
  const named = [meta.target, constraint?.fields, constraint?.index]
    .flatMap((v) => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []))
    .map((v) => String(v).replace(/"/g, ''))
  return named.includes(LEDGER_KEY_INDEX) || (named.includes('recurringExpenseId') && named.includes('period'))
}

function canManage(rule: Pick<RecurringExpenseRow, 'payerId'>, viewer: RecurringViewer): boolean {
  return viewer.role === 'ADMIN' || rule.payerId === viewer.userId
}

type SplitRule = Pick<RecurringExpenseRow, 'payerId' | 'splitMode' | 'participantIds'>

/** Who shares a posting, in the order the integer-cents split hands out the leftover cents. */
function shareMemberIds(rule: SplitRule, activeMemberIds: number[]): number[] {
  return rule.splitMode === 'SELECTED' ? rule.participantIds : activeMemberIds
}

/** The payer and (SELECTED) every participant are still active members of the rule's house. */
function membersStillActive(rule: SplitRule, activeMemberIds: number[]): boolean {
  const active = new Set(activeMemberIds)
  return active.has(rule.payerId) && (rule.splitMode === 'ALL' || rule.participantIds.every((id) => active.has(id)))
}

/** Thrown inside the posting transaction to roll the ledger claim back. */
class PostingAborted extends Error {}

/**
 * Interactive-transaction bounds of a posting (and of a SKIPPED write). Prisma's defaults — 2 s to start,
 * 5 s to finish — can roll a posting back when a run's first query wakes a suspended Neon compute; 10 s
 * and 15 s leave room for that wake-up and for the posting's handful of round trips. A function killed at
 * `maxDuration` never commits a half posting: the open transaction rolls back and the next run retries it.
 */
const POSTING_TRANSACTION = { maxWait: 10_000, timeout: 15_000 } as const

/**
 * What a failed claim transaction means for the rule: another run's claim (`duplicate`), or stop the rule
 * with the month still open (`aborted`, the next run retries it). Anything else is rethrown — `postDue`
 * counts it as `failed`.
 */
function claimFailure(e: unknown): 'duplicate' | 'aborted' {
  if (e instanceof PostingAborted) return 'aborted'
  // Only a conflict on the ledger key is another run's claim; any other unique violation stops the rule
  // with the month still open, so the next run retries it instead of the month being lost.
  if (prismaCode(e) === 'P2002') return isLedgerClaimConflict(e) ? 'duplicate' : 'aborted'
  // The claim's FK failed: the rule was deleted after it was loaded — nothing left to post.
  if (prismaCode(e) === 'P2003') return 'aborted'
  throw e
}

function toDto(rule: RecurringExpenseRow, viewer: RecurringViewer, lastClosedPeriod: string | null, now: Date): RecurringExpenseDto {
  const paused = rule.pausedAt !== null
  return {
    publicId: rule.publicId,
    description: rule.description,
    amount: moneyOf(rule.amount),
    dayOfMonth: rule.dayOfMonth,
    payerId: rule.payerId,
    splitMode: rule.splitMode,
    participantIds: rule.participantIds,
    timezone: rule.timezone,
    activeFrom: isoDate(rule.activeFrom),
    paused,
    pauseReason: rule.pauseReason,
    skippedPeriods: rule.skippedPeriods.filter((p) => lastClosedPeriod === null || p > lastClosedPeriod),
    lastClosedPeriod,
    upcoming: upcomingPeriods(
      { dayOfMonth: rule.dayOfMonth, paused, skippedPeriods: rule.skippedPeriods },
      localToday(rule.timezone, now),
      lastClosedPeriod,
      RECURRING_LIMITS.UPCOMING
    ),
    canManage: canManage(rule, viewer),
    updatedAt: rule.updatedAt.toISOString(),
  }
}

// ── Service ───────────────────────────────────────────────────────────────────────────────────────

export class RecurringExpenseService {
  /** The house's rules, summary and 50 most recent closed periods (criterion 4). */
  async list(groupId: number, viewer: RecurringViewer, now: Date): Promise<RecurringExpenseListDto> {
    const rules = await prisma.recurringExpense.findMany({ where: { groupId }, orderBy: { id: 'asc' } })
    const activeIds = await this.activeMemberIds(groupId)
    const lastClosed = await lastClosedPeriods(rules.map((r) => r.id))
    const history = await prisma.recurringExpenseOccurrence.findMany({
      where: { recurringExpense: { groupId } },
      orderBy: [{ dueOn: 'desc' }, { id: 'desc' }],
      take: RECURRING_LIMITS.HISTORY,
      select: {
        period: true,
        dueOn: true,
        status: true,
        recurringExpense: { select: { publicId: true, description: true } },
        expense: { select: { publicId: true, amount: true, payerId: true, _count: { select: { participants: true } } } },
      },
    })

    let totalCents = 0
    let shareCents = 0
    let pausedCount = 0
    for (const rule of rules) {
      if (rule.pausedAt !== null) {
        pausedCount++
        continue
      }
      const cents = toCents(rule.amount)
      totalCents += cents
      const sharers = shareMemberIds(rule, activeIds)
      const index = sharers.indexOf(viewer.userId)
      if (index >= 0) shareCents += splitCents(cents, sharers.length)[index]
    }

    return {
      rules: rules.map((rule) => toDto(rule, viewer, lastClosed.get(rule.id) ?? null, now)),
      summary: {
        monthlyTotal: money(totalCents),
        myMonthlyShare: money(shareCents),
        activeCount: rules.length - pausedCount,
        pausedCount,
      },
      history: history.map((row) => ({
        period: row.period,
        dueOn: isoDate(row.dueOn),
        status: row.status,
        rule: { publicId: row.recurringExpense.publicId, description: row.recurringExpense.description },
        expense: row.expense
          ? {
              publicId: row.expense.publicId,
              amount: moneyOf(row.expense.amount),
              payerId: row.expense.payerId,
              participantCount: row.expense._count.participants,
            }
          : null,
      })),
    }
  }

  /** One rule of the house (404 for a missing rule or another house's). */
  async get(groupId: number, viewer: RecurringViewer, publicId: string, now: Date): Promise<RecurringExpenseDto> {
    const rule = await this.findInHouse(groupId, publicId)
    return toDto(rule, viewer, await lastClosedPeriod(rule.id), now)
  }

  /**
   * Validates and creates a rule in the house (criteria 1–3). Eligibility starts at the local today
   * (no back-fill). `id` is for the caller's synchronous `postDue`.
   */
  async create(groupId: number, viewer: RecurringViewer, raw: unknown, now: Date): Promise<{ id: number; rule: RecurringExpenseDto }> {
    const input = parseRecurringExpenseInput(raw)
    await this.assertActiveMembers(groupId, [input.payerId, ...input.participantIds])
    if ((await prisma.recurringExpense.count({ where: { groupId } })) >= RECURRING_LIMITS.RULES_PER_HOUSE) {
      throw new ApiError(
        `This house already has ${RECURRING_LIMITS.RULES_PER_HOUSE} recurring expenses`,
        409,
        'RECURRING_LIMIT_REACHED'
      )
    }
    const rule = await prisma.recurringExpense.create({
      data: {
        publicId: uuidv7(),
        groupId,
        createdById: viewer.userId,
        payerId: input.payerId,
        description: input.description,
        amount: input.amount,
        dayOfMonth: input.dayOfMonth,
        splitMode: input.splitMode,
        participantIds: input.participantIds,
        timezone: input.timezone,
        activeFrom: dateOnly(localToday(input.timezone, now)),
      },
    })
    return { id: rule.id, rule: toDto(rule, viewer, null, now) }
  }

  /**
   * Edits the rule's fields (criterion 16) — posted expenses are independent rows and stay untouched.
   * `expectedUpdatedAt` is required (409 when stale). People newly introduced by the edit must be active
   * members; ones already on the rule are kept (resume re-validates them). Same values → no write.
   */
  async update(
    groupId: number,
    viewer: RecurringViewer,
    publicId: string,
    raw: unknown,
    expectedUpdatedAt: string | undefined,
    now: Date
  ): Promise<{ id: number; rule: RecurringExpenseDto; changes: RecurringExpenseChanges; changed: boolean }> {
    const patch = parseRecurringExpensePatch(raw)
    const rule = await this.findManageable(groupId, viewer, publicId)
    if (typeof expectedUpdatedAt !== 'string' || expectedUpdatedAt === '') {
      throw invalid('expectedUpdatedAt is required to edit a rule', 'RECURRING_PATCH_INVALID')
    }

    const splitMode = patch.splitMode ?? rule.splitMode
    const participantIds = splitMode === 'ALL' ? [] : (patch.participantIds ?? rule.participantIds)
    requireParticipants(splitMode, participantIds)
    const next = {
      description: patch.description ?? rule.description,
      amount: patch.amount !== undefined ? money(toCents(patch.amount)) : moneyOf(rule.amount),
      dayOfMonth: patch.dayOfMonth ?? rule.dayOfMonth,
      payerId: patch.payerId ?? rule.payerId,
      splitMode,
      participantIds,
    }
    await this.assertActiveMembers(groupId, [
      ...(next.payerId !== rule.payerId ? [next.payerId] : []),
      ...next.participantIds.filter((id) => !rule.participantIds.includes(id)),
    ])
    if (rule.updatedAt.toISOString() !== expectedUpdatedAt) throw stale()

    const current = {
      description: rule.description,
      amount: moneyOf(rule.amount),
      dayOfMonth: rule.dayOfMonth,
      payerId: rule.payerId,
      splitMode: rule.splitMode,
      participantIds: rule.participantIds,
    }
    const changes: RecurringExpenseChanges = {}
    for (const field of EDITABLE_FIELDS) {
      if (JSON.stringify(current[field]) !== JSON.stringify(next[field])) changes[field] = { from: current[field], to: next[field] }
    }
    const lastClosed = await lastClosedPeriod(rule.id)
    if (Object.keys(changes).length === 0) {
      return { id: rule.id, rule: toDto(rule, viewer, lastClosed, now), changes, changed: false }
    }

    try {
      // The `updatedAt` filter makes the token check atomic with the write (two simultaneous saves).
      const updated = await prisma.recurringExpense.update({
        where: { id: rule.id, updatedAt: rule.updatedAt },
        data: {
          ...('description' in changes && { description: next.description }),
          ...('amount' in changes && { amount: next.amount }),
          ...('dayOfMonth' in changes && { dayOfMonth: next.dayOfMonth }),
          ...('payerId' in changes && { payerId: next.payerId }),
          ...('splitMode' in changes && { splitMode: next.splitMode }),
          ...('participantIds' in changes && { participantIds: next.participantIds }),
        },
      })
      return { id: rule.id, rule: toDto(updated, viewer, lastClosed, now), changes, changed: true }
    } catch (e) {
      if (prismaCode(e) === 'P2025') throw stale()
      throw e
    }
  }

  /**
   * Pause (MANUAL) or resume (criterion 14). Resume re-checks the payer and participants and restarts
   * eligibility at the local today (no back-fill). The current state is a no-op (`changed: false`).
   */
  async setPaused(
    groupId: number,
    viewer: RecurringViewer,
    publicId: string,
    paused: boolean,
    now: Date
  ): Promise<{ id: number; rule: RecurringExpenseDto; changed: boolean }> {
    const rule = await this.findManageable(groupId, viewer, publicId)
    const lastClosed = await lastClosedPeriod(rule.id)
    if ((rule.pausedAt !== null) === paused) {
      return { id: rule.id, rule: toDto(rule, viewer, lastClosed, now), changed: false }
    }
    if (!paused) await this.assertActiveMembers(groupId, [rule.payerId, ...rule.participantIds])
    const activeFrom = localToday(rule.timezone, now)
    // Months before the new activeFrom's month can never post again: their skips would only linger.
    const skippedPeriods = rule.skippedPeriods.filter((p) => p >= periodOf(activeFrom))
    const prune = !paused && skippedPeriods.length !== rule.skippedPeriods.length
    try {
      const updated = await prisma.recurringExpense.update({
        // Pruning rewrites skippedPeriods: guard it like a skip, so a skip landing meanwhile is not lost.
        where: prune ? { id: rule.id, updatedAt: rule.updatedAt } : { id: rule.id },
        data: paused
          ? { pausedAt: now, pauseReason: 'MANUAL' }
          : { pausedAt: null, pauseReason: null, activeFrom: dateOnly(activeFrom), ...(prune && { skippedPeriods }) },
      })
      return { id: rule.id, rule: toDto(updated, viewer, lastClosed, now), changed: true }
    } catch (e) {
      if (prismaCode(e) === 'P2025') throw stale()
      throw e
    }
  }

  /** Skip one of the next 3 upcoming periods (criterion 15). Idempotent. */
  skip(groupId: number, viewer: RecurringViewer, publicId: string, period: string, now: Date) {
    return this.setSkipped(groupId, viewer, publicId, period, true, now)
  }

  /** Undo the skip of one of the next 3 upcoming periods (criterion 15). Idempotent. */
  unskip(groupId: number, viewer: RecurringViewer, publicId: string, period: string, now: Date) {
    return this.setSkipped(groupId, viewer, publicId, period, false, now)
  }

  /**
   * Deletes the rule and its ledger (criterion 17). Posted expenses stay: the FK sets their
   * `recurringExpenseId` to null (`onDelete: SetNull`).
   */
  async delete(groupId: number, viewer: RecurringViewer, publicId: string): Promise<{ publicId: string; description: string; amount: string }> {
    const rule = await this.findManageable(groupId, viewer, publicId)
    await prisma.recurringExpense.delete({ where: { id: rule.id } })
    return { publicId: rule.publicId, description: rule.description, amount: moneyOf(rule.amount) }
  }

  /**
   * Posts every due, unposted period of every unpaused rule (one rule with `recurringExpenseId`), oldest
   * due period first, until `deadline` (criteria 7–13). A reconciliation, not "since the last run":
   * idempotent through the ledger's unique (rule, period), claimed first inside each posting transaction.
   */
  async postDue(now: Date, options: PostDueOptions = {}): Promise<PostDueResult> {
    const result: PostDueResult = { posted: 0, skipped: 0, paused: 0, duplicates: 0, failed: 0, remaining: 0 }
    const rules = await prisma.recurringExpense.findMany({
      where: { pausedAt: null, ...(options.recurringExpenseId !== undefined && { id: options.recurringExpenseId }) },
      orderBy: { id: 'asc' },
    })
    // One ledger query for every rule; rules with nothing due cost no further query. The rest go oldest due
    // date first, so rules a deadline leaves behind lead the next run instead of starving every day.
    const lastClosed = await lastClosedPeriods(rules.map((r) => r.id))
    // One broken rule must not block the others; its transaction rolled back, the next run retries it.
    const fail = (rule: RecurringExpenseRow, e: unknown) => {
      result.failed++
      logger.error('recurring expense posting failed', { recurringExpenseId: rule.id }, e)
    }
    const dueRules: { rule: RecurringExpenseRow; periods: string[]; firstDue: string }[] = []
    for (const rule of rules) {
      try {
        const periods = eligiblePeriods(
          { dayOfMonth: rule.dayOfMonth, activeFrom: isoDate(rule.activeFrom) },
          localToday(rule.timezone, now),
          lastClosed.get(rule.id) ?? null,
          RECURRING_LIMITS.CATCH_UP
        )
        if (periods.length > 0) dueRules.push({ rule, periods, firstDue: dueOn(periods[0], rule.dayOfMonth) })
      } catch (e) {
        fail(rule, e)
      }
    }
    dueRules.sort((a, b) => (a.firstDue < b.firstDue ? -1 : a.firstDue > b.firstDue ? 1 : a.rule.id - b.rule.id))

    for (const [index, { rule, periods }] of dueRules.entries()) {
      if (options.deadline && Date.now() >= options.deadline.getTime()) {
        result.remaining = dueRules.length - index
        break
      }
      try {
        await this.postRule(rule, periods, now, result, options.deadline)
      } catch (e) {
        fail(rule, e)
      }
    }
    return result
  }

  // ── Posting internals ──────────────────────────────────────────────────────────────────────────

  /**
   * Posts or skips the rule's eligible `periods` (ascending, computed by `postDue`). Past the deadline it stops
   * between periods (the rule counts in `remaining`): a 12-month catch-up never runs on past the budget.
   */
  private async postRule(
    rule: RecurringExpenseRow,
    periods: string[],
    now: Date,
    result: PostDueResult,
    deadline?: Date
  ): Promise<void> {
    // Read outside the posting transaction: inside it only `tx` may query (single-connection pool).
    let activeIds: number[] | null = null

    for (const [index, period] of periods.entries()) {
      if (index > 0 && deadline && Date.now() >= deadline.getTime()) {
        result.remaining++
        return
      }
      const due = dueOn(period, rule.dayOfMonth)
      if (rule.skippedPeriods.includes(period)) {
        const outcome = await this.skipPeriod(rule, period, due)
        if (outcome === 'aborted') return
        if (outcome === 'duplicate') result.duplicates++
        else result.skipped++
        continue
      }

      activeIds ??= await this.activeMemberIds(rule.groupId)
      if (!membersStillActive(rule, activeIds)) {
        if (await this.pauseForMemberLeft(rule, now)) result.paused++
        return
      }

      const outcome = await this.postPeriod(rule, period, due, shareMemberIds(rule, activeIds))
      if (outcome === 'aborted') return
      if (outcome === 'duplicate') result.duplicates++
      else result.posted++
    }
  }

  private async postPeriod(
    rule: RecurringExpenseRow,
    period: string,
    due: string,
    memberIds: number[]
  ): Promise<'posted' | 'duplicate' | 'aborted'> {
    let expense
    try {
      // System actor: the Expense revision gets actorId null even inside a member's request (ADR 0010).
      expense = await runWithAuditContext({ system: true, groupId: rule.groupId }, async () =>
        await prisma.$transaction(async (tx) => {
          // 1–2. The claim, then the rule re-read (aborts when it changed since it was loaded).
          const claim = await this.claimPeriod(tx, rule, period, due, 'POSTED')
          if (!claim) return null
          // 3. The expense, through the same service as a manual one (integer-cents equal split).
          const created = await expenseService.create(
            rule.groupId,
            memberIds,
            {
              payerId: rule.payerId,
              description: rule.description,
              amount: toNumber(rule.amount),
              date: new Date(`${due}T12:00:00`),
              splitEqually: true,
            },
            { db: tx, recurringExpenseId: rule.id }
          )
          // 4. Link the ledger row to it.
          await tx.recurringExpenseOccurrence.update({ where: { id: claim.id }, data: { expenseId: created.id } })
          return created
        }, POSTING_TRANSACTION)
      )
    } catch (e) {
      return claimFailure(e)
    }
    if (expense === null) return 'duplicate'

    // Activity Summary (criterion 13): no person did this — the feed shows "Automatic".
    try {
      await auditService.log({
        groupId: rule.groupId,
        actorId: null,
        entityType: 'EXPENSE',
        entityId: expense.publicId,
        action: 'CREATE',
        summary: expense.description,
        changes: { amount: String(expense.amount), recurring: true, period },
      })
    } catch (e) {
      logger.error('audit log failed', { entityType: 'EXPENSE' }, e)
    }

    // Notices (spec 009, criterion 5): after the commit, outside the transaction, no actor (marked recurring).
    // Same contract as the routes' notifySafely (api-helpers stays out of framework-free services): a notice
    // failure is logged and never undoes or fails the posting (criterion 10).
    try {
      await notificationService.expenseCreated(expense, null)
    } catch (e) {
      logger.error('notification failed', { type: 'EXPENSE_NEW' }, e)
    }
    return 'posted'
  }

  /**
   * Closes a skipped period with a SKIPPED ledger row (criterion 11) — in a transaction like a posting, so an
   * Undo skip (or any other change) made after the run loaded the rule aborts the write: the next run reads
   * the rule again and posts the month.
   */
  private async skipPeriod(rule: RecurringExpenseRow, period: string, due: string): Promise<'skipped' | 'duplicate' | 'aborted'> {
    try {
      const claim = await prisma.$transaction(
        (tx) => this.claimPeriod(tx, rule, period, due, 'SKIPPED'),
        POSTING_TRANSACTION
      )
      return claim ? 'skipped' : 'duplicate'
    } catch (e) {
      return claimFailure(e)
    }
  }

  /**
   * The claim, first write of a posting or SKIPPED transaction, on the ledger's unique (rule, period).
   * ON CONFLICT DO NOTHING: a run racing an uncommitted claim waits for it, then gets no row — it writes
   * nothing and is a duplicate (null; no failing statement inside the transaction, so nothing to roll back).
   * Then the rule is re-read: any pause, skip, Undo skip or edit since it was loaded bumped `updatedAt` —
   * throw PostingAborted to roll the claim back.
   */
  private async claimPeriod(
    tx: TransactionClient,
    rule: RecurringExpenseRow,
    period: string,
    due: string,
    status: RecurringOccurrenceStatus
  ): Promise<{ id: number } | null> {
    const [claim] = await tx.recurringExpenseOccurrence.createManyAndReturn({
      data: [{ recurringExpenseId: rule.id, period, dueOn: dateOnly(due), status }],
      skipDuplicates: true,
      select: { id: true },
    })
    if (!claim) return null
    const current = await tx.recurringExpense.findUnique({
      where: { id: rule.id },
      select: { updatedAt: true, skippedPeriods: true },
    })
    if (
      !current ||
      current.updatedAt.getTime() !== rule.updatedAt.getTime() ||
      (status === 'SKIPPED' && !current.skippedPeriods.includes(period))
    ) {
      throw new PostingAborted()
    }
    return claim
  }

  /** Auto-pause (criterion 12), as the system — unless the rule changed since it was loaded. */
  private async pauseForMemberLeft(rule: RecurringExpenseRow, now: Date): Promise<boolean> {
    try {
      await runWithAuditContext({ system: true, groupId: rule.groupId }, async () =>
        await prisma.recurringExpense.update({
          where: { id: rule.id, updatedAt: rule.updatedAt },
          data: { pausedAt: now, pauseReason: 'MEMBER_LEFT' },
        })
      )
      return true
    } catch (e) {
      if (prismaCode(e) === 'P2025') return false
      throw e
    }
  }

  // ── Lookups ────────────────────────────────────────────────────────────────────────────────────

  private async findInHouse(groupId: number, publicId: string): Promise<RecurringExpenseRow> {
    // The column is a Postgres uuid: anything else would crash the query instead of being a 404.
    if (!isValidUUID(publicId)) throw notFound()
    const rule = await prisma.recurringExpense.findFirst({ where: { publicId, groupId } })
    if (!rule) throw notFound()
    return rule
  }

  /** House-scoped lookup first (another house's rule is a 404, never a 403), then payer-or-admin. */
  private async findManageable(groupId: number, viewer: RecurringViewer, publicId: string): Promise<RecurringExpenseRow> {
    const rule = await this.findInHouse(groupId, publicId)
    if (!canManage(rule, viewer)) {
      throw new ApiError('Only the payer or a house admin can change this rule', 403, 'NOT_RECURRING_OWNER')
    }
    return rule
  }

  private async setSkipped(
    groupId: number,
    viewer: RecurringViewer,
    publicId: string,
    period: string,
    skipped: boolean,
    now: Date
  ): Promise<{ id: number; rule: RecurringExpenseDto; changed: boolean }> {
    if (!isValidPeriod(period)) throw invalid('Invalid month', 'RECURRING_PERIOD_INVALID')
    try {
      return await this.trySetSkipped(groupId, viewer, publicId, period, skipped, now)
    } catch (e) {
      // Another write landed between our read and our write (a skip or unskip of another month): re-read once.
      if (prismaCode(e) !== 'P2025') throw e
    }
    try {
      return await this.trySetSkipped(groupId, viewer, publicId, period, skipped, now)
    } catch (e) {
      if (prismaCode(e) === 'P2025') throw stale()
      throw e
    }
  }

  /** One read-check-write pass; the write is guarded by `updatedAt`, so a lost update throws P2025. */
  private async trySetSkipped(
    groupId: number,
    viewer: RecurringViewer,
    publicId: string,
    period: string,
    skipped: boolean,
    now: Date
  ): Promise<{ id: number; rule: RecurringExpenseDto; changed: boolean }> {
    const rule = await this.findManageable(groupId, viewer, publicId)
    const closed = await prisma.recurringExpenseOccurrence.findUnique({
      where: { recurringExpenseId_period: { recurringExpenseId: rule.id, period } },
      select: { id: true },
    })
    if (closed) throw new ApiError('This month was already posted or skipped', 409, 'RECURRING_PERIOD_CLOSED')

    const lastClosed = await lastClosedPeriod(rule.id)
    // The next 3 periods as if unpaused, so a paused rule's skip can still be set or undone.
    const upcoming = upcomingPeriods(
      { dayOfMonth: rule.dayOfMonth, paused: false, skippedPeriods: rule.skippedPeriods },
      localToday(rule.timezone, now),
      lastClosed,
      RECURRING_LIMITS.UPCOMING
    )
    if (!upcoming.some((u) => u.period === period)) {
      throw invalid(`Only the next ${RECURRING_LIMITS.UPCOMING} months can be skipped`, 'RECURRING_PERIOD_INVALID')
    }
    if (rule.skippedPeriods.includes(period) === skipped) {
      return { id: rule.id, rule: toDto(rule, viewer, lastClosed, now), changed: false }
    }
    const skippedPeriods = skipped
      ? [...rule.skippedPeriods, period].sort()
      : rule.skippedPeriods.filter((p) => p !== period)
    const updated = await prisma.recurringExpense.update({
      where: { id: rule.id, updatedAt: rule.updatedAt },
      data: { skippedPeriods },
    })
    return { id: rule.id, rule: toDto(updated, viewer, lastClosed, now), changed: true }
  }

  /** Active members of the house, in membership order — the order of the ALL split. */
  private async activeMemberIds(groupId: number): Promise<number[]> {
    const members = await prisma.groupMember.findMany({
      where: { groupId, leftAt: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { userId: true },
    })
    return members.map((m) => m.userId)
  }

  private async assertActiveMembers(groupId: number, userIds: number[]): Promise<void> {
    const distinct = [...new Set(userIds)]
    if (distinct.length === 0) return
    const count = await prisma.groupMember.count({ where: { groupId, userId: { in: distinct }, leftAt: null } })
    if (count !== distinct.length) {
      throw invalid('The payer and every participant must be active members of this house', 'RECURRING_MEMBER_INACTIVE')
    }
  }
}

export const recurringExpenseService = new RecurringExpenseService()
