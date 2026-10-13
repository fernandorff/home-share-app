import webpush from 'web-push'
import { prisma } from '@/lib/prisma'
import { ApiError } from '@/lib/errors'
import { logger } from '@/lib/logger'
import { pushConfig, type PushConfig } from '@/lib/push/config'
import { isAllowedPushEndpoint, type PushSubscriptionInput } from '@/lib/push/endpoint'
import { buildPushPayload, buildTestPushPayload, type PushPayload } from '@/lib/push/payload'
import type { TransactionClient } from '@/services/expense.service'
import type { Notification } from '@/generated/prisma/client'

// Web Push (spec 010, ADR 0011): a best-effort, privacy-reduced copy of each spec 009 notice, sent to the
// recipient's devices. Subscriptions belong to a person (no house): each payload names its own house. Node runtime
// only (web-push signs with node:crypto). Framework-agnostic like every service: scheduling after the response is
// src/lib/push/schedule.ts's job.

/** Bounds (design › Security: abuse). */
const MAX_SUBSCRIPTIONS = 10
const CONCURRENCY = 10
/** Send options (design › Payload): a notice older than a day is not worth a banner; the center still has it. */
const TTL_SECONDS = 86_400
const TIMEOUT_MS = 10_000

export interface PushResult {
  sent: number
  failed: number
}

/** What dispatch reads of an inserted notice row. */
export type PushNoticeRow = Pick<Notification, 'userId' | 'groupId' | 'type' | 'actorId' | 'params'>

const SUBSCRIPTION_SELECT = { id: true, userId: true, endpoint: true, p256dh: true, auth: true, locale: true } as const

interface Delivery {
  subscription: { id: number; endpoint: string; p256dh: string; auth: string }
  payload: PushPayload
}

const notConfigured = () => new ApiError('Push notifications are not configured', 503, 'PUSH_NOT_CONFIGURED')
const noSubscription = () => new ApiError('No push subscription for this account', 409, 'NO_PUSH_SUBSCRIPTION')
// Same answer as requireSession's for a revoked token: the client signs out.
const sessionRevoked = () => new ApiError('Session expired, please log in again', 401, 'SESSION_REVOKED')

const unique = <T>(values: T[]) => [...new Set(values)]

/** The HTTP status of a push-service rejection (web-push's WebPushError.statusCode); undefined for network errors. */
function statusOf(error: unknown): number | undefined {
  const status = (error as { statusCode?: unknown } | null)?.statusCode
  return typeof status === 'number' ? status : undefined
}

// Node's error codes (ECONNRESET, ETIMEDOUT, ERR_TLS_CERT_ALTNAME_INVALID, CERT_HAS_EXPIRED…) are fixed identifiers.
const NODE_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/

/**
 * Why a send failed without an HTTP status: Node's error code, else a fixed reason — web-push's own errors (a malformed
 * VAPID key or subject, its socket timeout) have no code, and their messages quote the endpoint or the subject.
 */
function failureReason(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && NODE_ERROR_CODE.test(code) ? code : 'request_failed'
}

/** Runs `task` over `items` with at most `limit` in flight; `task` must not throw. */
async function forEachBounded<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) await task(items[next++])
  }
  await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, worker))
}

/**
 * Sends every delivery, never retried (criterion 7). The endpoint is re-validated before each send: rows outlive
 * validator changes, and the server must never POST to a URL the current allow-list rejects (SSRF) — such a row is
 * deleted like an expired one (404/410), and counted in one warning. Other failures are logged with the push service's
 * host and status — or, without a status, Node's error code / a fixed reason — only: web-push's error carries the full
 * endpoint (the device token) and the response body (criterion 13).
 */
async function deliver(deliveries: readonly Delivery[], config: PushConfig): Promise<PushResult> {
  const vapidDetails = { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey }
  const dead: number[] = []
  const rejected = new Set<number>()
  let sent = 0
  await forEachBounded(deliveries, CONCURRENCY, async ({ subscription, payload }) => {
    if (!isAllowedPushEndpoint(subscription.endpoint)) {
      rejected.add(subscription.id)
      dead.push(subscription.id)
      return
    }
    try {
      await webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        JSON.stringify(payload),
        { TTL: TTL_SECONDS, urgency: 'normal', timeout: TIMEOUT_MS, vapidDetails }
      )
      sent++
    } catch (error) {
      const statusCode = statusOf(error)
      if (statusCode === 404 || statusCode === 410) dead.push(subscription.id)
      else {
        const reason = statusCode === undefined ? failureReason(error) : undefined
        logger.warn('push delivery failed', { host: new URL(subscription.endpoint).hostname, statusCode, reason })
      }
    }
  })
  if (rejected.size > 0) logger.warn('push endpoint rejected', { count: rejected.size })
  if (dead.length > 0) {
    try {
      await prisma.pushSubscription.deleteMany({ where: { id: { in: dead } } })
    } catch (e) {
      logger.error('push: removing expired subscriptions failed', { count: dead.length }, e)
    }
  }
  return { sent, failed: deliveries.length - sent }
}

export class PushService {
  /**
   * Stores the caller's subscription (criteria 3, 5): one row per endpoint, moved to whoever registers it last,
   * with fresh keys and locale. Without a locale (the worker's `pushsubscriptionchange` re-POST cannot know it) a
   * new row takes the schema default and a known one keeps its own. Then the cap: past 10 the least recently
   * (re)registered rows go — every app load re-registers, so that is the device unused the longest — never the row
   * just registered. 503 while push is not configured (criterion 1).
   *
   * `sessionVersion` is the caller's session's (criterion 9): a register that passed requireSession just before a
   * logout or password change committed must not store a row after that bump deleted them all. The bump updates the
   * member's row before it deletes (auth.service), and this locks that row and re-reads the version before it writes:
   * whichever runs second sees the other's commit. A stale session stores nothing → 401 SESSION_REVOKED, thrown after
   * the transaction (which wrote nothing) committed.
   */
  async register(userId: number, sessionVersion: number, input: PushSubscriptionInput): Promise<void> {
    if (!pushConfig()) throw notConfigured()
    const { endpoint, p256dh, auth, locale } = input
    const fields = { userId, p256dh, auth, ...(locale !== undefined && { locale }) }
    const stored = await prisma.$transaction(async (tx) => {
      const [user] = await tx.$queryRaw<{ sessionVersion: number }[]>`SELECT "sessionVersion" FROM "User" WHERE id = ${userId} FOR UPDATE`
      if (!user || user.sessionVersion !== sessionVersion) return false
      const saved = await tx.pushSubscription.upsert({
        where: { endpoint },
        create: { ...fields, endpoint },
        update: fields,
        select: { id: true },
      })
      const surplus = await tx.pushSubscription.findMany({
        where: { userId, id: { not: saved.id } },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: MAX_SUBSCRIPTIONS - 1,
        select: { id: true },
      })
      if (surplus.length > 0) {
        await tx.pushSubscription.deleteMany({ where: { userId, id: { in: surplus.map((s) => s.id) } } })
      }
      return true
    })
    if (!stored) throw sessionRevoked()
  }

  /** Deletes the caller's row for that endpoint, if any (idempotent; another member's row is never touched). */
  async unregister(userId: number, endpoint: string): Promise<void> {
    await prisma.pushSubscription.deleteMany({ where: { userId, endpoint } })
  }

  /**
   * Every subscription of the member (criterion 9: on each sessionVersion bump). Returns Prisma's promise un-awaited,
   * so it can join a batch `$transaction([...])` or run on an interactive one's `tx`.
   */
  deleteAllForUser(userId: number, db: TransactionClient = prisma) {
    return db.pushSubscription.deleteMany({ where: { userId } })
  }

  /**
   * One push per subscription of each notice's recipient (criterion 6), in that subscription's locale. Recipients'
   * subscriptions, house names and actor names are each read in one query. Runs after the response, so it never
   * throws: a failure is logged (counts only) and only costs the push — the center already holds the notice.
   */
  async dispatch(rows: readonly PushNoticeRow[]): Promise<void> {
    try {
      const config = pushConfig()
      if (!config || rows.length === 0) return
      const subscriptions = await prisma.pushSubscription.findMany({
        where: { userId: { in: unique(rows.map((r) => r.userId)) } },
        select: SUBSCRIPTION_SELECT,
        orderBy: { id: 'asc' },
      })
      if (subscriptions.length === 0) return

      const byUser = new Map<number, typeof subscriptions>()
      for (const s of subscriptions) byUser.set(s.userId, [...(byUser.get(s.userId) ?? []), s])
      const pushed = rows.filter((r) => byUser.has(r.userId))
      const actorIds = unique(pushed.flatMap((r) => (r.actorId === null ? [] : [r.actorId])))
      const [houses, actors] = await Promise.all([
        prisma.group.findMany({
          where: { id: { in: unique(pushed.map((r) => r.groupId)) } },
          select: { id: true, publicId: true, name: true },
        }),
        actorIds.length > 0 ? prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } }) : [],
      ])
      const houseById = new Map(houses.map((h) => [h.id, h]))
      const actorName = new Map(actors.map((a) => [a.id, a.name]))

      const deliveries = pushed.flatMap((row) => {
        const house = houseById.get(row.groupId)
        if (!house) return [] // the house was deleted after the insert: nothing to open
        return byUser.get(row.userId)!.map((subscription) => ({
          subscription,
          payload: buildPushPayload({
            notification: row,
            locale: subscription.locale,
            houseName: house.name,
            housePublicId: house.publicId,
            actorName: row.actorId === null ? null : actorName.get(row.actorId) ?? null,
          }),
        }))
      })
      await deliver(deliveries, config)
    } catch (e) {
      logger.error('push dispatch failed', { notices: rows.length }, e)
    }
  }

  /**
   * "Send test notice" (criterion 10): to every subscription of the member, each in its locale. 503 when push is not
   * configured, 409 without a subscription; the route adds the rate limit.
   */
  async sendTest(userId: number): Promise<PushResult> {
    const config = pushConfig()
    if (!config) throw notConfigured()
    const subscriptions = await prisma.pushSubscription.findMany({
      where: { userId },
      select: SUBSCRIPTION_SELECT,
      orderBy: { id: 'asc' },
    })
    if (subscriptions.length === 0) throw noSubscription()
    return deliver(
      subscriptions.map((subscription) => ({ subscription, payload: buildTestPushPayload(subscription.locale) })),
      config
    )
  }
}

export const pushService = new PushService()
