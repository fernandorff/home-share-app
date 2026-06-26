import { NextResponse } from 'next/server'
import { categoryService } from '@/services/category.service'
import { handleApiError, requireActiveGroup } from '@/lib/api-helpers'
import { LIMITS } from '@/lib/constants'

export async function GET(request: Request) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const { searchParams } = new URL(request.url)
    const withCounts = searchParams.get('counts') === 'true'

    const categories = withCounts
      ? await categoryService.listWithCounts(check.groupId)
      : await categoryService.list(check.groupId)

    return NextResponse.json({ categories })
  } catch (error) {
    return handleApiError(error, 'Erro ao listar categorias')
  }
}

export async function POST(request: Request) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const body = await request.json()
    const name = typeof body?.name === 'string' ? body.name.trim() : ''

    if (!name) {
      return NextResponse.json({ error: 'Nome é obrigatório', code: 'NAME_REQUIRED' }, { status: 400 })
    }
    if (name.length > LIMITS.CATEGORY_NAME) {
      return NextResponse.json(
        { error: `Nome muito longo (máx. ${LIMITS.CATEGORY_NAME} caracteres)`, code: 'NAME_TOO_LONG' },
        { status: 400 }
      )
    }

    const category = await categoryService.create(check.groupId, name)
    return NextResponse.json({ category }, { status: 201 })
  } catch (error) {
    return handleApiError(error, 'Erro ao criar categoria')
  }
}
