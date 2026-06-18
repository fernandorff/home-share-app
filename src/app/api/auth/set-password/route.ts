import { NextResponse } from 'next/server'
import { authService } from '@/services/auth.service'
import { handleApiError } from '@/lib/api-helpers'
import { signSession, sessionCookieOptions, SESSION_COOKIE } from '@/lib/auth'

/** First-access flow: legacy users (password NULL) define their password here. */
export async function POST(request: Request) {
  try {
    const body = await request.json()
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : ''
    const password = typeof body.password === 'string' ? body.password : ''

    const passwordError = authService.validatePassword(password)
    if (passwordError) {
      return NextResponse.json({ error: passwordError }, { status: 400 })
    }

    const result = await authService.setInitialPassword(username, password)
    if (result.status !== 'ok') {
      return NextResponse.json(
        { error: 'Não foi possível definir a senha para este usuário' },
        { status: 400 }
      )
    }

    const token = await signSession({
      userId: result.user.id,
      publicId: result.user.publicId,
      name: result.user.name,
    })

    const response = NextResponse.json({ user: result.user })
    response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions())
    return response
  } catch (error) {
    return handleApiError(error, 'Erro ao definir senha')
  }
}
