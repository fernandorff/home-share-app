import { NextResponse } from 'next/server'
import { requireCron } from '@/lib/cron'
import { handleApiError } from '@/lib/api-helpers'
import { logger } from '@/lib/logger'
import { notificationService } from '@/services/notification.service'

export const dynamic = 'force-dynamic'
// Vercel limit for this function; the producers stop at DEADLINE_MS so the response and logs still go out.
export const maxDuration = 60

// No rule's reminder and no house's debt scan starts after DEADLINE_MS (same budget as the posting job). The
// unit in flight is a few plain queries (no transaction), and prune is one statement: the run answers well
// under maxDuration. Leftovers are reported as `remaining`; reminders for a passed day are not caught up.
const DEADLINE_MS = 30_000

/**
 * Daily Vercel Cron (spec 009, ADR 0010): recurring due-date reminders, Monday debt reminders, then prune of
 * notices older than 90 days. Idempotent — a duplicate delivery inserts nothing twice (dedupe keys). Guarded
 * by `Authorization: Bearer $CRON_SECRET`; responses and logs carry counts only (no ids, names, amounts).
 */
export async function GET(request: Request) {
  try {
    const check = requireCron(request)
    if (!check.ok) return check.response

    const startedAt = Date.now()
    const now = new Date(startedAt)
    const deadline = new Date(startedAt + DEADLINE_MS)
    const due = await notificationService.sendRecurringDueReminders(now, { deadline })
    const debt = await notificationService.sendDebtReminders(now, { deadline })
    const pruned = await notificationService.prune(now)
    const counts = {
      dueReminders: due.created,
      debtReminders: debt.created,
      pruned,
      failed: due.failed + debt.failed,
      remaining: due.remaining + debt.remaining,
    }

    logger.info('notifications cron finished', {
      route: '/api/cron/notifications',
      durationMs: Date.now() - startedAt,
      ...counts,
    })
    return NextResponse.json({ ok: true, ...counts })
  } catch (error) {
    return handleApiError(error, 'Failed to run the notices job')
  }
}
