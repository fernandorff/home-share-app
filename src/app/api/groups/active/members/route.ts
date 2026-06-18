import { NextResponse } from 'next/server'
import { groupService } from '@/services/group.service'
import { handleApiError, requireActiveGroup } from '@/lib/api-helpers'

export async function GET() {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const members = await groupService.listMembers(check.groupId)
    return NextResponse.json({ members, groupId: check.groupId })
  } catch (error) {
    return handleApiError(error, 'Erro ao listar membros')
  }
}
