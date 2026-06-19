import { NextResponse } from 'next/server'
import { authService } from '@/services/auth.service'
import { handleApiError } from '@/lib/api-helpers'
import { signSession, sessionCookieOptions, SESSION_COOKIE } from '@/lib/auth'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : ''
    const password = typeof body.password === 'string' ? body.password : ''

    if (!username) {
      return NextResponse.json({ error: 'Informe o usuário', code: 'MISSING_USERNAME' }, { status: 400 })
    }

    const result = await authService.login(username, password)

    if (result.status === 'requires_password_setup') {
      // Legacy user without password — frontend redirects to the set-password step.
      return NextResponse.json({ requiresPasswordSetup: true })
    }

    if (result.status === 'invalid') {
      return NextResponse.json({ error: 'Usuário ou senha incorretos', code: 'INVALID_CREDENTIALS' }, { status: 401 })
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
    return handleApiError(error, 'Erro ao entrar')
  }
}
