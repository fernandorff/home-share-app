import { NextResponse } from 'next/server'
import { pushService } from '@/services/push.service'
import { handleApiError, isJsonRequest, notJson, requireSession } from '@/lib/api-helpers'
import { SESSION_COOKIE } from '@/lib/auth'
import { ApiError } from '@/lib/errors'
import { pushConfig } from '@/lib/push/config'
import { isAllowedPushEndpoint, parsePushSubscription } from '@/lib/push/endpoint'

// This device's push subscription (spec 010, criteria 1, 3–5). User-scoped: a session is enough, no active house —
// a subscription belongs to a person and every push names its own house. The owner always comes from the session;
// the answer never echoes the endpoint or the keys (criterion 13).

const invalid = () =>
  NextResponse.json({ error: 'Invalid push subscription', code: 'PUSH_SUBSCRIPTION_INVALID' }, { status: 400 })

// CSRF (isJsonRequest, lib/api-helpers): the session cookie is SameSite=Lax, so a sibling subdomain still sends it —
// and a write here would register someone else's push endpoint under the victim (a lasting read channel).

/** `{ endpoint, keys: { p256dh, auth }, locale? }` → upsert by endpoint (owner, keys and locale refreshed), cap 10. */
export async function POST(request: Request) {
  try {
    const check = await requireSession()
    if (!check.ok) return check.response

    // Checked before the body: while unconfigured no subscription is accepted at all (criterion 1). Answered here,
    // not thrown: push being off is a deployment state, not a server failure — no error log, no Sentry event.
    if (!pushConfig()) {
      return NextResponse.json({ error: 'Push notifications are not configured', code: 'PUSH_NOT_CONFIGURED' }, { status: 503 })
    }

    if (!isJsonRequest(request)) return notJson()
    const input = parsePushSubscription(await request.json().catch(() => null))
    if (!input) return invalid()

    // The session version is re-checked under a row lock: a logout committing meanwhile wins (no orphan row).
    await pushService.register(check.session.userId, check.session.sessionVersion, input)
    return NextResponse.json({ ok: true }, { status: 201 })
  } catch (error) {
    const response = await handleApiError(error, 'Failed to save push subscription')
    // A logout committed during this request: drop the revoked cookie here, as requireSession does, so the
    // client's redirect to /auth/login is not bounced back by the middleware.
    if (error instanceof ApiError && error.code === 'SESSION_REVOKED') response.cookies.delete(SESSION_COOKIE)
    return response
  }
}

/**
 * `{ endpoint }` → deletes the caller's row for it, if any (idempotent; another member's row is never touched).
 * Works while push is unconfigured: a device must always be able to clean up.
 */
export async function DELETE(request: Request) {
  try {
    const check = await requireSession()
    if (!check.ok) return check.response

    if (!isJsonRequest(request)) return notJson()
    const body: unknown = await request.json().catch(() => null)
    const endpoint = body && typeof body === 'object' ? (body as { endpoint?: unknown }).endpoint : undefined
    if (!isAllowedPushEndpoint(endpoint)) return invalid()

    await pushService.unregister(check.session.userId, endpoint)
    return NextResponse.json({ ok: true })
  } catch (error) {
    return handleApiError(error, 'Failed to remove push subscription')
  }
}
