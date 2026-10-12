import { NextResponse } from 'next/server'
import { SESSION_COOKIE, GROUP_COOKIE } from '@/lib/auth'
import { handleApiError, requireSession } from '@/lib/api-helpers'
import { authService } from '@/services/auth.service'

/**
 * "Log out of all devices" (ADR 0013): bumping sessionVersion revokes every token at once — a forgotten or copied
 * cookie included — and deletes every push subscription in the same transaction (spec 010). This browser too.
 */
export async function POST() {
  try {
    const check = await requireSession()
    if (!check.ok) return check.response

    await authService.bumpSessionVersion(check.session.userId)
    const response = NextResponse.json({ ok: true })
    response.cookies.delete(SESSION_COOKIE)
    response.cookies.delete(GROUP_COOKIE)
    return response
  } catch (error) {
    return handleApiError(error, 'Failed to log out of all devices')
  }
}
