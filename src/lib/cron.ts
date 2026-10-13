import { createHash, timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { logger } from '@/lib/logger'

// Scheduled-job guard (spec 008, ADR 0010). A cron invocation carries no session cookie — the only
// credential is `Authorization: Bearer $CRON_SECRET`, which Vercel sends when the variable is set.

export type CronCheck = { ok: true } | { ok: false; response: NextResponse }

function unauthorized(): CronCheck {
  return {
    ok: false,
    response: NextResponse.json({ error: 'Unauthorized', code: 'CRON_UNAUTHORIZED' }, { status: 401 }),
  }
}

// Digests have a fixed length, so timingSafeEqual never throws on a length mismatch and the
// comparison time does not reveal how long the secret is.
function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

/**
 * Fail closed: an unset or empty CRON_SECRET rejects every request (and warns once per request —
 * without it, "Bearer undefined" or a bare "Bearer " would otherwise be a valid credential).
 */
export function requireCron(request: Request): CronCheck {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    logger.warn('CRON_SECRET is not set; rejecting cron request')
    return unauthorized()
  }
  const presented = request.headers.get('authorization') ?? ''
  if (!timingSafeEqual(digest(presented), digest(`Bearer ${secret}`))) {
    return unauthorized()
  }
  return { ok: true }
}
