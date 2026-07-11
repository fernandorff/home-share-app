import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { authService } from '@/services/auth.service'
import { handleApiError, requireSession } from '@/lib/api-helpers'
import { GROUP_COOKIE, SESSION_COOKIE } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'

export async function GET() {
  try {
    const check = await requireSession()
    if (!check.ok) return check.response

    const user = await authService.getUserWithGroups(check.session.userId)
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const cookieStore = await cookies()
    const preferredGroupId = Number(cookieStore.get(GROUP_COOKIE)?.value) || null
    const activeGroup =
      user.groups.find(g => g.id === preferredGroupId) ?? user.groups[0] ?? null

    return NextResponse.json({ user, activeGroupId: activeGroup?.id ?? null })
  } catch (error) {
    return handleApiError(error, 'Failed to load session')
  }
}

export async function PATCH(request: Request) {
  try {
    const check = await requireSession()
    if (!check.ok) return check.response

    const body = await request.json()
    const name = typeof body.name === 'string' ? body.name.trim() : undefined
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : undefined
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : undefined
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : undefined

    if (name === undefined && email === undefined && username === undefined) {
      return NextResponse.json({ error: 'Provide at least one field to update', code: 'NO_FIELDS' }, { status: 400 })
    }
    if (name !== undefined && (!name || name.length > 80)) {
      return NextResponse.json({ error: 'Name is required (max 80 characters)', code: 'INVALID_NAME' }, { status: 400 })
    }
    if (email !== undefined) {
      const emailError = authService.validateEmail(email)
      if (emailError) {
        return NextResponse.json({ error: emailError, code: 'INVALID_EMAIL' }, { status: 400 })
      }
    }
    if (username !== undefined) {
      const usernameError = authService.validateUsername(username)
      if (usernameError) {
        return NextResponse.json({ error: usernameError, code: 'INVALID_USERNAME' }, { status: 400 })
      }
    }

    // Brute-forcing the current-password confirmation is only reachable through email/username
    // changes — gate those attempts per authenticated user (shared bucket with /api/auth/password).
    if (email !== undefined || username !== undefined) {
      if (!rateLimit(`account:pw:${check.session.userId}`, 10, 60_000)) {
        return NextResponse.json({ error: 'Too many attempts. Try again shortly.', code: 'RATE_LIMITED' }, { status: 429 })
      }
    }

    const result = await authService.updateProfile(check.session.userId, { name, email, username, currentPassword })
    if ('error' in result) {
      const status =
        result.code === 'CURRENT_PASSWORD_REQUIRED' || result.code === 'CURRENT_PASSWORD_INVALID' ? 401
        : result.code === 'EMAIL_TAKEN' || result.code === 'USERNAME_TAKEN' ? 409
        : result.code === 'NOT_FOUND' ? 404
        : 400
      return NextResponse.json({ error: result.error, code: result.code }, { status })
    }

    return NextResponse.json({ user: result.user })
  } catch (error) {
    return handleApiError(error, 'Failed to update account')
  }
}

/**
 * Delete (anonymize) the caller's own account (BL-23). Requires the current password when one is
 * set (same confirmation as changing email/username). Refused if the account is the sole admin of
 * a house with other active members (409 LAST_ADMIN — promote someone else, or leave that house,
 * first).
 */
export async function DELETE(request: Request) {
  try {
    const check = await requireSession()
    if (!check.ok) return check.response

    const body = await request.json().catch(() => ({}))
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : undefined

    if (!rateLimit(`account:pw:${check.session.userId}`, 10, 60_000)) {
      return NextResponse.json({ error: 'Too many attempts. Try again shortly.', code: 'RATE_LIMITED' }, { status: 429 })
    }

    const result = await authService.deleteAccount(check.session.userId, currentPassword)
    if ('error' in result) {
      const status =
        result.code === 'CURRENT_PASSWORD_REQUIRED' || result.code === 'CURRENT_PASSWORD_INVALID' ? 401
        : result.code === 'LAST_ADMIN' ? 409
        : result.code === 'NOT_FOUND' ? 404
        : 400
      return NextResponse.json({ error: result.error, code: result.code }, { status })
    }

    const response = NextResponse.json({ ok: true })
    response.cookies.delete(SESSION_COOKIE)
    response.cookies.delete(GROUP_COOKIE)
    return response
  } catch (error) {
    return handleApiError(error, 'Failed to delete account')
  }
}
