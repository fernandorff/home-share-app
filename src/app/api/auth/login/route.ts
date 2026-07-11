import { NextResponse } from 'next/server'
import { authService } from '@/services/auth.service'
import { handleApiError } from '@/lib/api-helpers'
import { signSession, sessionCookieOptions, SESSION_COOKIE } from '@/lib/auth'
import { rateLimit, clientIp } from '@/lib/rate-limit'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : ''
    const password = typeof body.password === 'string' ? body.password : ''

    if (!username) {
      return NextResponse.json({ error: 'Username is required', code: 'MISSING_USERNAME' }, { status: 400 })
    }

    // Throttle floods per-IP only. A per-username limit is deliberately avoided: keyed on a
    // public/enumerable username it would let an attacker lock a victim out by hammering their
    // name. Skip when the IP is unknown (no proxy header) so we never collapse everyone into one bucket.
    const ip = clientIp(request)
    if (ip !== 'unknown' && !rateLimit(`login:ip:${ip}`, 30, 60_000)) {
      return NextResponse.json({ error: 'Too many attempts. Try again shortly.', code: 'RATE_LIMITED' }, { status: 429 })
    }

    const result = await authService.login(username, password)

    if (result.status === 'use_google') {
      return NextResponse.json({ error: 'This account signs in with Google', code: 'USE_GOOGLE' }, { status: 401 })
    }

    if (result.status === 'invalid') {
      return NextResponse.json({ error: 'Incorrect username or password', code: 'INVALID_CREDENTIALS' }, { status: 401 })
    }

    const token = await signSession({
      userId: result.user.id,
      publicId: result.user.publicId,
      name: result.user.name,
      sessionVersion: result.user.sessionVersion,
    })

    // sessionVersion is an internal revocation counter — only ever belongs in the signed JWT,
    // never in a response body the client can read.
    const { id, publicId, name } = result.user
    const response = NextResponse.json({ user: { id, publicId, name } })
    response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions())
    return response
  } catch (error) {
    return handleApiError(error, 'Failed to sign in')
  }
}
