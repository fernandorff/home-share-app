import { NextResponse } from 'next/server'
import { authService } from '@/services/auth.service'
import { handleApiError, requireSession } from '@/lib/api-helpers'
import { rateLimit } from '@/lib/rate-limit'

export async function POST(request: Request) {
  try {
    const check = await requireSession()
    if (!check.ok) return check.response

    // Same shared bucket as PATCH /api/auth/me — both gate on the same current-password secret.
    if (!rateLimit(`account:pw:${check.session.userId}`, 10, 60_000)) {
      return NextResponse.json({ error: 'Muitas tentativas. Tente novamente em instantes.', code: 'RATE_LIMITED' }, { status: 429 })
    }

    const body = await request.json()
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : undefined
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : ''

    const passwordError = authService.validatePassword(newPassword)
    if (passwordError) {
      return NextResponse.json({ error: passwordError.error, code: passwordError.code }, { status: 400 })
    }

    const result = await authService.changePassword(check.session.userId, currentPassword, newPassword, check.session.iat)
    if ('error' in result) {
      const status = result.code === 'NOT_FOUND' ? 404 : 401
      return NextResponse.json({ error: result.error, code: result.code }, { status })
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    return handleApiError(error, 'Erro ao atualizar a senha')
  }
}
