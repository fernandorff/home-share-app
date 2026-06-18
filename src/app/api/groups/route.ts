import { NextResponse } from 'next/server'
import { groupService } from '@/services/group.service'
import { handleApiError, requireSession } from '@/lib/api-helpers'

export async function GET() {
  try {
    const check = await requireSession()
    if (!check.ok) return check.response

    const groups = await groupService.listForUser(check.session.userId)
    return NextResponse.json({ groups })
  } catch (error) {
    return handleApiError(error, 'Erro ao listar casas')
  }
}

export async function POST(request: Request) {
  try {
    const check = await requireSession()
    if (!check.ok) return check.response

    const body = await request.json()
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name || name.length > 80) {
      return NextResponse.json({ error: 'Nome da casa é obrigatório (máx. 80 caracteres)' }, { status: 400 })
    }

    const group = await groupService.create(check.session.userId, name)

    // Client stores the new group id and sends it as X-Group-Id on subsequent requests.
    return NextResponse.json(
      { group: { id: group.id, publicId: group.publicId, name: group.name, joinCode: group.joinCode } },
      { status: 201 }
    )
  } catch (error) {
    return handleApiError(error, 'Erro ao criar casa')
  }
}
