import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { SESSION_COOKIE, GROUP_COOKIE, verifySession } from '@/lib/auth'
import { authService } from '@/services/auth.service'
import { logger } from '@/lib/logger'

export async function POST() {
  // Bumping sessionVersion here is what actually revokes the token — clearing the cookie alone
  // only logs out THIS browser; the JWT itself would otherwise stay valid (stateless) for anyone
  // who copied it before logout. Read the session directly (not requireSession()) since a token
  // that's already revoked from elsewhere must still be able to log this browser out too.
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE)?.value
  const session = token ? await verifySession(token) : null
  if (session) {
    // This browser is logged out either way; a failed revocation leaves the token (and the member's push
    // subscriptions) alive elsewhere, so it must leave a trace (no fields: nothing about the member is logged).
    await authService.bumpSessionVersion(session.userId).catch((e) => {
      logger.error('logout: session revocation failed', {}, e)
    })
  }

  const response = NextResponse.json({ ok: true })
  response.cookies.delete(SESSION_COOKIE)
  response.cookies.delete(GROUP_COOKIE)
  return response
}
