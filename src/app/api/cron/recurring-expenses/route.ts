import { NextResponse } from 'next/server'
import { requireCron } from '@/lib/cron'
import { handleApiError } from '@/lib/api-helpers'
import { logger } from '@/lib/logger'
import { recurringExpenseService } from '@/services/recurring-expense.service'

export const dynamic = 'force-dynamic'
// Vercel limit for this function; postDue stops at DEADLINE_MS so the response and logs still go out.
export const maxDuration = 60

// No new rule, and no further month of a started rule, begins after DEADLINE_MS; the month in flight may still
// wait for a connection (maxWait 10 s) and run its transaction (timeout 15 s): ~55 s with a healthy database,
// under maxDuration. A degraded database can still overrun — Vercel then kills the run, the open transaction
// rolls back and the next run retries (only this run's log line is lost).
const DEADLINE_MS = 30_000

/**
 * Daily Vercel Cron (spec 008, ADR 0010): posts every recurring expense that is due, catching up
 * missed days. Idempotent — a duplicate delivery or a manual re-run posts nothing twice. Guarded by
 * `Authorization: Bearer $CRON_SECRET`; responses and logs carry counts only (no ids, names, amounts).
 */
export async function GET(request: Request) {
  try {
    const check = requireCron(request)
    if (!check.ok) return check.response

    const startedAt = Date.now()
    const now = new Date(startedAt)
    const { posted, skipped, paused, duplicates, failed, remaining } = await recurringExpenseService.postDue(now, {
      deadline: new Date(startedAt + DEADLINE_MS),
    })
    const counts = { posted, skipped, paused, duplicates, failed, remaining }

    logger.info('recurring expenses cron finished', {
      route: '/api/cron/recurring-expenses',
      durationMs: Date.now() - startedAt,
      ...counts,
    })
    return NextResponse.json({ ok: true, ...counts })
  } catch (error) {
    return handleApiError(error, 'Failed to post recurring expenses')
  }
}
