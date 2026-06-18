import { NextResponse } from 'next/server'
import { authService } from '@/services/auth.service'
import { handleApiError } from '@/lib/api-helpers'
import { signSession } from '@/lib/auth'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : ''
    const password = typeof body.password === 'string' ? body.password : ''

    if (!name || name.length > 80) {
      return NextResponse.json({ error: 'Nome é obrigatório (máx. 80 caracteres)' }, { status: 400 })
    }
    const usernameError = authService.validateUsername(username)
    if (usernameError) {
      return NextResponse.json({ error: usernameError }, { status: 400 })
    }
    const passwordError = authService.validatePassword(password)
    if (passwordError) {
      return NextResponse.json({ error: passwordError }, { status: 400 })
    }

    const result = await authService.register(name, username, password)
    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: 409 })
    }

    const token = await signSession({
      userId: result.user.id,
      publicId: result.user.publicId,
      name: result.user.name,
    })

    return NextResponse.json({ token, user: result.user }, { status: 201 })
  } catch (error) {
    return handleApiError(error, 'Erro ao criar conta')
  }
}
