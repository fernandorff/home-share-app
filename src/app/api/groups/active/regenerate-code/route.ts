import { NextResponse } from 'next/server'
import { groupService } from '@/services/group.service'
import { handleApiError, recordActivity, requireActiveGroup } from '@/lib/api-helpers'

export async function POST() {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    if (check.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Only the house admin can regenerate the code', code: 'NOT_ADMIN' },
        { status: 403 }
      )
    }

    const joinCode = await groupService.regenerateJoinCode(check.groupId)
    // R3-19: Activity › Summary names the event ("regenerated the house code"). Only a marker goes
    // into the log — the code itself is admin-only, while the feed is readable by every member.
    await recordActivity({
      groupId: check.groupId,
      actorId: check.session.userId,
      entityType: 'GROUP',
      action: 'UPDATE',
      summary: '',
      changes: { joinCodeChanged: true },
    })
    return NextResponse.json({ joinCode })
  } catch (error) {
    return handleApiError(error, 'Failed to regenerate code')
  }
}
