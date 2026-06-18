import { NextResponse } from 'next/server'
import { groupService } from '@/services/group.service'
import { handleApiError, requireSession } from '@/lib/api-helpers'
import { isValidJoinCodeFormat, normalizeJoinCode } from '@/lib/join-code'

export async function POST(request: Request) {
  try {
    const check = await requireSession()
    if (!check.ok) return check.response

    const body = await request.json()
    const code = typeof body.code === 'string' ? normalizeJoinCode(body.code) : ''
    if (!isValidJoinCodeFormat(code)) {
      return NextResponse.json({ error: 'Código inválido — deve ter 6 caracteres' }, { status: 400 })
    }

    const result = await groupService.joinByCode(check.session.userId, code)
    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: 404 })
    }

    return NextResponse.json({
      group: { id: result.group.id, publicId: result.group.publicId, name: result.group.name },
    })
  } catch (error) {
    return handleApiError(error, 'Erro ao entrar na casa')
  }
}
