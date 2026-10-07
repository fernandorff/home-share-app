import { prisma } from '@/lib/prisma'
import { uuidv7, isValidUUID } from '@/lib/uuid'
import { ApiError } from '@/lib/errors'
import { fromCents, toCents } from '@/lib/currency'
import { applySettlements } from '@/lib/balance'
import { isoWeek, NOTIFICATION_LIST_LIMIT, NOTIFICATION_TYPES, type NotificationType } from '@/lib/notifications'
import { localToday, upcomingPeriods, type UpcomingPeriod } from '@/lib/recurrence'
import { logger } from '@/lib/logger'
import { schedulePush } from '@/lib/push/schedule'
import { balanceService } from '@/services/balance.service'
import { settlementService } from '@/services/settlement.service'
import { lastClosedPeriods } from '@/services/recurring-ledger'
import type { Notification } from '@/generated/prisma/client'

// Notification center (spec 009, ADR 0011): one personal notice per recipient and house, stored with
// structured `params` the reader's client renders through i18n. Framework-agnostic like every service.
// Scheduled producers (ADR 0010) take `now`, run as the system (`actorId` null on the row) and dedupe on
// (userId, dedupeKey). They need no `runWithAuditContext({ system: true })`: their only writes are
// notices, which the audit extension skips (SKIP_MODELS) — nothing they write reaches EntityRevision.

/** Bounds (design › Security & tenant isolation). */
export const NOTIFICATION_LIMITS = {
  /** Notices one list returns, newest first. */
  LIST: NOTIFICATION_LIST_LIMIT,
  /** Older notices are deleted by the daily job. */
  RETENTION_DAYS: 90,
} as const

const DAY_MS = 86_400_000

export function isNotificationType(value: unknown): value is NotificationType {
  return (NOTIFICATION_TYPES as readonly unknown[]).includes(value)
}

/** Render parameters (design › Producers and recipients): ids, a description snapshot, 2-decimal amounts. */
export type NotificationParams = {
  expensePublicId?: string
  settlementPublicId?: string
  recurringExpensePublicId?: string
  /** PAYMENT_RECEIVED: who paid — not always the actor, any member may record a payment between two others. */
  fromUserId?: number
  description?: string
  amount: string
  recurring?: boolean
  dueOn?: string
}

/** One would-be notice: its recipient, render parameters and (scheduled producers only) dedupe key. */
export interface NoticeDraft {
  userId: number
  params: NotificationParams
  dedupeKey?: string
}

export interface NewNotices {
  groupId: number
  type: NotificationType
  /** Who caused it — never notified about it; null = automatic (daily job, recurring rule). */
  actorId: number | null
  notices: NoticeDraft[]
}

export type NotificationPreferences = Record<NotificationType, boolean>

/** A notice as the center returns it (design › API contract, `AppNotification`). */
export interface NotificationDto {
  publicId: string
  type: NotificationType
  /** Resolved to a name client-side with the house's members (ex-members included); null = automatic. */
  actorId: number | null
  params: NotificationParams
  read: boolean
  /** ISO timestamp. */
  createdAt: string
}

export interface NotificationList {
  notifications: NotificationDto[]
  unreadCount: number
}

/** What one scheduled producer did in a run — the daily job reports these counts (ADR 0010). */
export interface ScheduledRun {
  /** Notices inserted. */
  created: number
  /** Units (rules, houses) that threw: logged with ids only; the others still ran. */
  failed: number
  /** Units not started because the deadline passed. */
  remaining: number
}

export interface ScheduledRunOptions {
  /** No unit (rule, house) starts after this instant; the ones left count in `remaining` (like `postDue`). */
  deadline?: Date
}

const pastDeadline = (deadline?: Date) => deadline !== undefined && Date.now() >= deadline.getTime()

/** A money column as Prisma returns it (Decimal), or a plain number/string. */
type MoneyValue = number | string | { toString(): string }

/** What the EXPENSE_NEW producer reads of a created expense (the shape `expenseService.create` returns). */
export interface ExpenseForNotice {
  groupId: number
  publicId: string
  description: string
  amount: MoneyValue
  payerId: number
  participants: readonly { userId: number; amount: MoneyValue }[]
}

/** What the PAYMENT_RECEIVED producer reads of a recorded settlement. */
export interface SettlementForNotice {
  groupId: number
  publicId: string
  fromUserId: number
  toUserId: number
  amount: MoneyValue
}

/** A 2-decimal string of an amount, through integer cents (ADR 0003). */
const amountString = (value: MoneyValue) => fromCents(toCents(value)).toFixed(2)

const notFound = () => new ApiError('Notice not found', 404, 'NOTIFICATION_NOT_FOUND')

/**
 * The compound lookup of one notice (design › Security): another member's or house's notice is a 404,
 * indistinguishable from a missing one. The column is a Postgres uuid: anything else would crash the
 * query instead of being a 404.
 */
function noticeScope(userId: number, groupId: number, publicId: string) {
  if (!isValidUUID(publicId)) throw notFound()
  return { publicId, userId, groupId }
}

const DTO_SELECT = { publicId: true, type: true, actorId: true, params: true, readAt: true, createdAt: true } as const

function toDto(row: Pick<Notification, keyof typeof DTO_SELECT>): NotificationDto {
  return {
    publicId: row.publicId,
    type: row.type,
    actorId: row.actorId,
    params: row.params as NotificationParams,
    read: row.readAt !== null,
    createdAt: row.createdAt.toISOString(),
  }
}

/** What a due-date reminder reads of a recurring rule. */
export interface RuleForReminder {
  dayOfMonth: number
  /** IANA zone that defines the rule's "today". */
  timezone: string
  skippedPeriods: readonly string[]
}

/** `YYYY-MM-DD` of the calendar day after `day`. */
function nextDay(day: string): string {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, date + 1)).toISOString().slice(0, 10)
}

/**
 * The period a due-date reminder goes out for at `now` (criterion 7): the rule's first unskipped upcoming
 * period (after `lastClosedPeriod`, its highest ledger period), when it is due tomorrow in the rule's
 * timezone; null otherwise. For an unpaused rule — the caller loads only those.
 */
export function reminderPeriod(rule: RuleForReminder, lastClosedPeriod: string | null, now: Date): UpcomingPeriod | null {
  const today = localToday(rule.timezone, now)
  // Due dates are a month apart, so only the first upcoming period can be due tomorrow; when it is
  // skipped, the first unskipped one is at least a month away.
  const [next] = upcomingPeriods(
    { dayOfMonth: rule.dayOfMonth, paused: false, skippedPeriods: rule.skippedPeriods },
    today,
    lastClosedPeriod,
    1
  )
  return next && !next.skipped && next.dueOn === nextDay(today) ? next : null
}

const invalidPreference = () => new ApiError('Invalid notice preference', 400, 'NOTIFICATION_PREF_INVALID')

/** `{ type, enabled }` of a preference change: a known type and a boolean, else 400. */
export function parsePreferenceInput(raw: unknown): { type: NotificationType; enabled: boolean } {
  if (raw === null || typeof raw !== 'object') throw invalidPreference()
  const { type, enabled } = raw as Record<string, unknown>
  if (!isNotificationType(type) || typeof enabled !== 'boolean') throw invalidPreference()
  return { type, enabled }
}

export class NotificationService {
  /**
   * The common filter of every producer, then one insert: drop the actor, keep one draft per recipient,
   * keep only active members of the event's house (not left, account not deleted) who did not turn the
   * type off. `skipDuplicates`: a scheduled notice already sent to that recipient (same dedupeKey) is
   * skipped, so the returned rows are exactly the inserted ones — and only those get a push (spec 010,
   * sent after the response; a no-op while push is not configured).
   */
  async create({ groupId, type, actorId, notices }: NewNotices): Promise<Notification[]> {
    const drafts = new Map<number, NoticeDraft>()
    for (const notice of notices) {
      if (notice.userId !== actorId && !drafts.has(notice.userId)) drafts.set(notice.userId, notice)
    }
    if (drafts.size === 0) return []

    const recipients = await prisma.groupMember.findMany({
      where: {
        groupId,
        leftAt: null,
        userId: { in: [...drafts.keys()] },
        user: { deletedAt: null, notificationPreferences: { none: { type, enabled: false } } },
      },
      select: { userId: true },
    })
    const recipientIds = new Set(recipients.map((r) => r.userId))
    const data = [...drafts.values()]
      .filter((draft) => recipientIds.has(draft.userId))
      .map(({ userId, params, dedupeKey }) => ({
        publicId: uuidv7(),
        userId,
        groupId,
        type,
        actorId,
        params,
        // `||`: an empty key would collide for every event notice of the recipient.
        dedupeKey: dedupeKey || null,
      }))
    if (data.length === 0) return []
    const inserted = await prisma.notification.createManyAndReturn({ data, skipDuplicates: true })
    schedulePush(inserted)
    return inserted
  }

  /**
   * EXPENSE_NEW for the payer and every participant with a share > 0, minus the actor (criterion 4).
   * `actorId` null = posted by a recurring rule: nobody to exclude, marked `recurring` (criterion 5).
   */
  async expenseCreated(expense: ExpenseForNotice, actorId: number | null): Promise<Notification[]> {
    const params: NotificationParams = {
      expensePublicId: expense.publicId,
      description: expense.description,
      amount: amountString(expense.amount),
      recurring: actorId === null,
    }
    const userIds = [expense.payerId, ...expense.participants.filter((p) => toCents(p.amount) > 0).map((p) => p.userId)]
    return this.create({
      groupId: expense.groupId,
      type: 'EXPENSE_NEW',
      actorId,
      notices: userIds.map((userId) => ({ userId, params })),
    })
  }

  /**
   * PAYMENT_RECEIVED for the recipient, unless they recorded it themselves (criterion 6). `actorId` is the
   * recorder; the params name the payer ("{payer} paid you"), who may be someone else.
   */
  async settlementCreated(settlement: SettlementForNotice, actorId: number): Promise<Notification[]> {
    return this.create({
      groupId: settlement.groupId,
      type: 'PAYMENT_RECEIVED',
      actorId,
      notices: [
        {
          userId: settlement.toUserId,
          params: {
            settlementPublicId: settlement.publicId,
            fromUserId: settlement.fromUserId,
            amount: amountString(settlement.amount),
          },
        },
      ],
    })
  }

  // ── Scheduled producers (daily job, ADR 0010) ────────────────────────────────────────────────────

  /**
   * RECURRING_DUE for the payer of every unpaused rule whose first unskipped upcoming period is due
   * tomorrow in the rule's timezone (criterion 7), at most once per (rule, period) through the dedupe key.
   * A missed day is not caught up (a reminder for a passed date is noise); one failing rule is logged and
   * never costs the other rules their reminder. Which rules are due is computed first (pure, cheap), so the
   * deadline bounds only the inserts.
   */
  async sendRecurringDueReminders(now: Date, options: ScheduledRunOptions = {}): Promise<ScheduledRun> {
    const result: ScheduledRun = { created: 0, failed: 0, remaining: 0 }
    const rules = await prisma.recurringExpense.findMany({
      where: { pausedAt: null },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        publicId: true,
        groupId: true,
        payerId: true,
        description: true,
        amount: true,
        dayOfMonth: true,
        timezone: true,
        skippedPeriods: true,
      },
    })
    if (rules.length === 0) return result
    const lastClosed = await lastClosedPeriods(rules.map((r) => r.id))
    const fail = (rule: (typeof rules)[number], e: unknown) => {
      result.failed++
      logger.error('recurring due reminder failed', { recurringExpenseId: rule.id }, e)
    }

    const dueRules: { rule: (typeof rules)[number]; due: UpcomingPeriod }[] = []
    for (const rule of rules) {
      try {
        const due = reminderPeriod(rule, lastClosed.get(rule.id) ?? null, now)
        if (due) dueRules.push({ rule, due })
      } catch (e) {
        fail(rule, e)
      }
    }

    for (const [index, { rule, due }] of dueRules.entries()) {
      if (pastDeadline(options.deadline)) {
        result.remaining = dueRules.length - index
        break
      }
      try {
        const created = await this.create({
          groupId: rule.groupId,
          type: 'RECURRING_DUE',
          actorId: null,
          notices: [
            {
              userId: rule.payerId,
              params: {
                recurringExpensePublicId: rule.publicId,
                description: rule.description,
                amount: amountString(rule.amount),
                dueOn: due.dueOn,
              },
              dedupeKey: `RECURRING_DUE:${rule.id}:${due.period}`,
            },
          ],
        })
        result.created += created.length
      } catch (e) {
        fail(rule, e)
      }
    }
    return result
  }

  /**
   * DEBT_REMINDER, on Mondays (UTC) only, for each active member whose balance in a house — expenses and
   * recorded payments, exactly like the Balances screen — is below zero, with the absolute amount
   * (criterion 8); at most once per member, house and ISO week through the dedupe key. One failing house is
   * logged and the others still run; past the deadline no house starts (`remaining`).
   */
  async sendDebtReminders(now: Date, options: ScheduledRunOptions = {}): Promise<ScheduledRun> {
    const result: ScheduledRun = { created: 0, failed: 0, remaining: 0 }
    if (now.getUTCDay() !== 1) return result
    const week = isoWeek(now)
    // A house nobody is active in has nobody to remind.
    const houses = await prisma.group.findMany({
      where: { members: { some: { leftAt: null } } },
      select: { id: true },
      orderBy: { id: 'asc' },
    })

    for (const [index, { id: groupId }] of houses.entries()) {
      if (pastDeadline(options.deadline)) {
        result.remaining = houses.length - index
        break
      }
      try {
        const [balances, settlements] = await Promise.all([
          balanceService.aggregate(groupId),
          settlementService.list(groupId),
        ])
        const debtors = applySettlements(balances, settlements).filter((b) => toCents(b.balance) < 0)
        if (debtors.length === 0) continue
        const created = await this.create({
          groupId,
          type: 'DEBT_REMINDER',
          actorId: null,
          notices: debtors.map((debtor) => ({
            userId: debtor.userId,
            params: { amount: amountString(-debtor.balance) }, // the absolute amount owed
            dedupeKey: `DEBT_REMINDER:${groupId}:${week}`,
          })),
        })
        result.created += created.length
      } catch (e) {
        result.failed++
        logger.error('debt reminder failed', { groupId }, e)
      }
    }
    return result
  }

  /** Deletes notices older than 90 days (criterion 18); returns how many. */
  async prune(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - NOTIFICATION_LIMITS.RETENTION_DAYS * DAY_MS)
    const { count } = await prisma.notification.deleteMany({ where: { createdAt: { lt: cutoff } } })
    return count
  }

  // ── Read side: every query filters by the member AND the server-resolved active house ──────────────

  /** At most 50 of the member's notices in the house, newest first, plus the unread count (criterion 11). */
  async list(userId: number, groupId: number, options: { unreadOnly?: boolean } = {}): Promise<NotificationList> {
    const [rows, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where: { userId, groupId, ...(options.unreadOnly && { readAt: null }) },
        // A batch insert stamps its rows with one createdAt: the id keeps the order stable.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: NOTIFICATION_LIMITS.LIST,
        select: DTO_SELECT,
      }),
      this.unreadCount(userId, groupId),
    ])
    return { notifications: rows.map(toDto), unreadCount }
  }

  async unreadCount(userId: number, groupId: number): Promise<number> {
    return prisma.notification.count({ where: { userId, groupId, readAt: null } })
  }

  /**
   * Marks one notice read and returns the unread count (criterion 12). Idempotent: an already-read notice
   * keeps its first `readAt`; only a notice outside the member's scope in the house is a 404.
   */
  async markRead(userId: number, groupId: number, publicId: string): Promise<number> {
    const scope = noticeScope(userId, groupId, publicId)
    const { count } = await prisma.notification.updateMany({ where: { ...scope, readAt: null }, data: { readAt: new Date() } })
    if (count === 0 && !(await prisma.notification.findFirst({ where: scope, select: { id: true } }))) throw notFound()
    return this.unreadCount(userId, groupId)
  }

  /** Marks every unread notice of the member in the house read (criterion 12). */
  async markAllRead(userId: number, groupId: number): Promise<void> {
    await prisma.notification.updateMany({ where: { userId, groupId, readAt: null }, data: { readAt: new Date() } })
  }

  /** Deletes one notice and returns the unread count; outside the member's scope in the house → 404. */
  async delete(userId: number, groupId: number, publicId: string): Promise<number> {
    const { count } = await prisma.notification.deleteMany({ where: noticeScope(userId, groupId, publicId) })
    if (count === 0) throw notFound()
    return this.unreadCount(userId, groupId)
  }

  // ── Preferences ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Every type with its effective value (criterion 13), in enum order. Per user, all houses. Only
   * overrides are stored: a type without a row is on (criterion 9).
   */
  async getPreferences(userId: number): Promise<NotificationPreferences> {
    const overrides = await prisma.notificationPreference.findMany({
      where: { userId },
      select: { type: true, enabled: true },
    })
    const stored = new Map(overrides.map((o) => [o.type, o.enabled]))
    return Object.fromEntries(NOTIFICATION_TYPES.map((type) => [type, stored.get(type) ?? true])) as NotificationPreferences
  }

  /** Stores one switch (`{ type, enabled }`, 400 `NOTIFICATION_PREF_INVALID` otherwise) and returns the map. */
  async setPreference(userId: number, raw: unknown): Promise<NotificationPreferences> {
    const { type, enabled } = parsePreferenceInput(raw)
    await prisma.notificationPreference.upsert({
      where: { userId_type: { userId, type } },
      create: { userId, type, enabled },
      update: { enabled },
    })
    return this.getPreferences(userId)
  }
}

export const notificationService = new NotificationService()
