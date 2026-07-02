import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { isValidUUID } from '@/lib/uuid'
import { expenseService } from '@/services/expense.service'
import { handleApiError, requireActiveGroup } from '@/lib/api-helpers'

export async function POST(request: Request) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const { publicIds } = await request.json()

    if (!publicIds || !Array.isArray(publicIds) || publicIds.length === 0) {
      return NextResponse.json({ error: 'Lista de IDs é obrigatória' }, { status: 400 })
    }
    if (publicIds.length > 1000) {
      return NextResponse.json({ error: 'Máximo de 1000 despesas por vez', code: 'TOO_MANY' }, { status: 400 })
    }

    for (const id of publicIds) {
      if (!isValidUUID(id)) {
        return NextResponse.json({ error: `ID inválido: ${id}` }, { status: 400 })
      }
    }

    const expenses = await prisma.expense.findMany({
      where: {
        publicId: { in: publicIds },
        groupId: check.groupId
      },
      select: { id: true }
    })

    if (expenses.length === 0) {
      return NextResponse.json({ error: 'Nenhuma despesa encontrada' }, { status: 404 })
    }

    const deletedCount = await expenseService.bulkDelete(check.groupId, expenses.map(e => e.id))

    return NextResponse.json({
      message: `${deletedCount} despesa(s) excluída(s) com sucesso`,
      deleted: deletedCount
    })
  } catch (error) {
    return handleApiError(error, 'Erro ao excluir despesas')
  }
}
