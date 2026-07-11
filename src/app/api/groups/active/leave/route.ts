import { NextResponse } from 'next/server'
import { groupService } from '@/services/group.service'
import { handleApiError, requireActiveGroup } from '@/lib/api-helpers'

/**
 * Self-leave the active house (BL-16). Soft-removes the membership (never deletes it) — past
 * expenses/settlements keep the real name in the history, and rejoining later reactivates the
 * same row instead of starting over. Refused if the caller is the house's only admin with other
 * active members still around (409 LAST_ADMIN — promote someone else first).
 */
export async function POST() {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    await groupService.removeMember(check.groupId, check.session.userId)

    return NextResponse.json({ ok: true })
  } catch (error) {
    return handleApiError(error, 'Failed to leave house')
  }
}
