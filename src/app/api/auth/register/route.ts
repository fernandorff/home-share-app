import { NextResponse } from 'next/server'
import { authService } from '@/services/auth.service'
import { handleApiError } from '@/lib/api-helpers'
import { signSession, sessionCookieOptions, SESSION_COOKIE } from '@/lib/auth'
import { rateLimit, clientIp } from '@/lib/rate-limit'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : ''
    const password = typeof body.password === 'string' ? body.password : ''

    const ip = clientIp(request)
    if (ip !== 'unknown' && !rateLimit(`register:ip:${ip}`, 15, 60_000)) {
      return NextResponse.json({ error: 'Too many attempts. Try again shortly.', code: 'RATE_LIMITED' }, { status: 429 })
    }

    if (!name || name.length > 80) {
      return NextResponse.json({ error: 'Name is required (max 80 characters)', code: 'INVALID_NAME' }, { status: 400 })
    }
    const usernameError = authService.validateUsername(username)
    if (usernameError) {
      return NextResponse.json({ error: usernameError, code: 'INVALID_USERNAME' }, { status: 400 })
    }
    const passwordError = authService.validatePassword(password)
    if (passwordError) {
      return NextResponse.json({ error: passwordError.error, code: passwordError.code }, { status: 400 })
    }

    const result = await authService.register(name, username, password)
    if ('error' in result) {
      return NextResponse.json({ error: result.error, code: 'USERNAME_TAKEN' }, { status: 409 })
    }

    const token = await signSession({
      userId: result.user.id,
      publicId: result.user.publicId,
      name: result.user.name,
      sessionVersion: 0, // brand-new user row — always starts at the schema default
    })

    const response = NextResponse.json({ user: result.user }, { status: 201 })
    response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions())
    return response
  } catch (error) {
    return handleApiError(error, 'Failed to create account')
  }
}
