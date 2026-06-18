import { NextResponse } from 'next/server'
import { authService } from '@/services/auth.service'
import { handleApiError } from '@/lib/api-helpers'
import { signSession } from '@/lib/auth'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : ''
    const password = typeof body.password === 'string' ? body.password : ''

    if (!username) {
      return NextResponse.json({ error: 'Informe o usuário' }, { status: 400 })
    }

    const result = await authService.login(username, password)

    if (result.status === 'requires_password_setup') {
      // Legacy user without password — client redirects to the set-password step.
      return NextResponse.json({ requiresPasswordSetup: true })
    }

    if (result.status === 'invalid') {
      return NextResponse.json({ error: 'Usuário ou senha incorretos' }, { status: 401 })
    }

    const token = await signSession({
      userId: result.user.id,
      publicId: result.user.publicId,
      name: result.user.name,
    })

    return NextResponse.json({ token, user: result.user })
  } catch (error) {
    return handleApiError(error, 'Erro ao entrar')
  }
}
