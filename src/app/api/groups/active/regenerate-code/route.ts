import { NextResponse } from 'next/server'
import { groupService } from '@/services/group.service'
import { handleApiError, requireActiveGroup } from '@/lib/api-helpers'

export async function POST() {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    if (check.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Apenas o admin da casa pode regenerar o código' },
        { status: 403 }
      )
    }

    const joinCode = await groupService.regenerateJoinCode(check.groupId)
    return NextResponse.json({ joinCode })
  } catch (error) {
    return handleApiError(error, 'Erro ao regenerar código')
  }
}
