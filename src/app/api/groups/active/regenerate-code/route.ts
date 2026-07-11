import { NextResponse } from 'next/server'
import { groupService } from '@/services/group.service'
import { handleApiError, requireActiveGroup } from '@/lib/api-helpers'

export async function POST() {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    if (check.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Only the house admin can regenerate the code' },
        { status: 403 }
      )
    }

    const joinCode = await groupService.regenerateJoinCode(check.groupId)
    return NextResponse.json({ joinCode })
  } catch (error) {
    return handleApiError(error, 'Failed to regenerate code')
  }
}
