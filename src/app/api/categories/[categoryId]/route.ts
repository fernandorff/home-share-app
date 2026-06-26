import { NextResponse } from 'next/server'
import { isValidUUID } from '@/lib/uuid'
import { categoryService } from '@/services/category.service'
import { handleApiError, requireActiveGroup } from '@/lib/api-helpers'

interface RouteParams {
  params: Promise<{ categoryId: string }>
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const { categoryId } = await params
    if (!isValidUUID(categoryId)) {
      return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
    }

    await categoryService.delete(check.groupId, categoryId)
    return NextResponse.json({ message: 'Categoria excluída com sucesso' })
  } catch (error) {
    return handleApiError(error, 'Erro ao excluir categoria')
  }
}
