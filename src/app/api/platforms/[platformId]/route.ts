import { NextResponse } from 'next/server'
import { isValidUUID } from '@/lib/uuid'
import { platformService } from '@/services/platform.service'
import { handleApiError, requireActiveGroup } from '@/lib/api-helpers'

interface RouteParams {
  params: Promise<{ platformId: string }>
}

export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const { platformId } = await params
    if (!isValidUUID(platformId)) {
      return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
    }

    const body = await request.json()
    const { name } = body

    if (!name || !name.trim()) {
      return NextResponse.json({ error: 'Nome é obrigatório' }, { status: 400 })
    }

    const platform = await platformService.update(check.groupId, platformId, name)
    return NextResponse.json({ platform })
  } catch (error) {
    return handleApiError(error, 'Erro ao atualizar plataforma')
  }
}

export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const { platformId } = await params
    if (!isValidUUID(platformId)) {
      return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
    }

    const body = await request.json()
    const { replacementId } = body

    if (!replacementId || !isValidUUID(replacementId)) {
      return NextResponse.json({ error: 'Plataforma substituta é obrigatória' }, { status: 400 })
    }

    await platformService.delete(check.groupId, platformId, replacementId)
    return NextResponse.json({ message: 'Plataforma excluída com sucesso' })
  } catch (error) {
    return handleApiError(error, 'Erro ao excluir plataforma')
  }
}
