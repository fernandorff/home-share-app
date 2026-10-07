import { NextResponse } from 'next/server'
import { notificationService } from '@/services/notification.service'
import { handleApiError, requireActiveGroup } from '@/lib/api-helpers'

/** "Mark all read" (spec 009, criterion 12): only the member's notices in the active house. */
export async function POST() {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    await notificationService.markAllRead(check.session.userId, check.groupId)
    return NextResponse.json({ unreadCount: 0 })
  } catch (error) {
    return handleApiError(error, 'Failed to mark notices read')
  }
}
