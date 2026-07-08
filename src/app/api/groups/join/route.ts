import { NextResponse } from 'next/server'
import { groupService } from '@/services/group.service'
import { handleApiError, requireSession } from '@/lib/api-helpers'
import { GROUP_COOKIE, groupCookieOptions } from '@/lib/auth'
import { isValidJoinCodeFormat, normalizeJoinCode } from '@/lib/join-code'
import { rateLimit } from '@/lib/rate-limit'

export async function POST(request: Request) {
  try {
    const check = await requireSession()
    if (!check.ok) return check.response

    // Join codes are only 6 chars (~30 bits) and never expire — without a limit here, any
    // authenticated user could script unlimited guesses to land in a house they were never
    // invited to. Per-user (not per-IP): the caller is always authenticated at this point.
    if (!rateLimit(`join:user:${check.session.userId}`, 20, 60_000)) {
      return NextResponse.json({ error: 'Muitas tentativas. Tente novamente em instantes.', code: 'RATE_LIMITED' }, { status: 429 })
    }

    const body = await request.json()
    const code = typeof body.code === 'string' ? normalizeJoinCode(body.code) : ''
    if (!isValidJoinCodeFormat(code)) {
      return NextResponse.json({ error: 'Código inválido — deve ter 6 caracteres', code: 'INVALID_CODE_FORMAT' }, { status: 400 })
    }

    const result = await groupService.joinByCode(check.session.userId, code)
    if ('error' in result) {
      return NextResponse.json({ error: result.error, code: 'INVALID_CODE' }, { status: 404 })
    }

    const response = NextResponse.json({
      group: { id: result.group.id, publicId: result.group.publicId, name: result.group.name },
    })
    response.cookies.set(GROUP_COOKIE, String(result.group.id), groupCookieOptions())
    return response
  } catch (error) {
    return handleApiError(error, 'Erro ao entrar na casa')
  }
}
