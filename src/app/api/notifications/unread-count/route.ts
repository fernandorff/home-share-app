import { NextResponse } from 'next/server'
import { notificationService } from '@/services/notification.service'
import { handleApiError, requireActiveGroup } from '@/lib/api-helpers'

/** The bell's badge (spec 009, criterion 14): the member's unread notices in the active house, and which house that is. */
export async function GET() {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const count = await notificationService.unreadCount(check.session.userId, check.groupId)
    return NextResponse.json({ count, groupId: check.groupId })
  } catch (error) {
    return handleApiError(error, 'Failed to count unread notices')
  }
}
