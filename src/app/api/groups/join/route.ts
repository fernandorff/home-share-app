import { NextResponse } from 'next/server'
import { groupService } from '@/services/group.service'
import { handleApiError, requireSession } from '@/lib/api-helpers'
import { GROUP_COOKIE, groupCookieOptions } from '@/lib/auth'
import { isValidJoinCodeFormat, normalizeJoinCode } from '@/lib/join-code'

export async function POST(request: Request) {
  try {
    const check = await requireSession()
    if (!check.ok) return check.response

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
