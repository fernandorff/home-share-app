import { NextResponse } from 'next/server'
import { pushService } from '@/services/push.service'
import { handleApiError, isJsonRequest, notJson, requireSession } from '@/lib/api-helpers'
import { pushConfig } from '@/lib/push/config'
import { rateLimit } from '@/lib/rate-limit'

// "Send test notice" (spec 010, criterion 10): a test push to every subscription of the session user, each in its
// own locale. Per person (no active house). Reads no body: nothing a client sends picks the recipient.

const TEST_LIMIT = 1
const TEST_WINDOW_MS = 10_000

export async function POST(request: Request) {
  try {
    const check = await requireSession()
    if (!check.ok) return check.response

    // Before the rate limit, so a deployment without push never spends the member's bucket. Answered here, not
    // thrown: push being off is a deployment state, not a server failure — no error log, no Sentry event.
    if (!pushConfig()) {
      return NextResponse.json({ error: 'Push notifications are not configured', code: 'PUSH_NOT_CONFIGURED' }, { status: 503 })
    }

    // CSRF (as on /api/push-subscriptions): a same-site form must not fire real pushes at the member's devices. Before
    // the rate limit, so a refused form never spends the member's bucket either.
    if (!isJsonRequest(request)) return notJson()

    // Each test is one real push per device through the browsers' push services: 1 per 10 s per user.
    if (!rateLimit(`push:test:${check.session.userId}`, TEST_LIMIT, TEST_WINDOW_MS)) {
      return NextResponse.json({ error: 'Too many test notices. Try again shortly.', code: 'RATE_LIMITED' }, { status: 429 })
    }

    // 409 NO_PUSH_SUBSCRIPTION comes from the service as an expected ApiError.
    const { sent, failed } = await pushService.sendTest(check.session.userId)
    return NextResponse.json({ sent, failed })
  } catch (error) {
    return handleApiError(error, 'Failed to send the test notice')
  }
}
