import { NextResponse } from 'next/server'
import { notificationService } from '@/services/notification.service'
import { handleApiError, requireActiveGroup } from '@/lib/api-helpers'

/**
 * The member's notices in the active house (spec 009, criterion 11): at most 50, newest first, plus the
 * unread count. `?filter=unread` lists unread ones only; any other value lists all (a stale filter never
 * breaks the screen). The member and the house come from the session, never from the request. `groupId` names the
 * house it answered for: a tab still showing another house (switched in another tab) drops the answer.
 */
export async function GET(request: Request) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const unreadOnly = new URL(request.url).searchParams.get('filter') === 'unread'
    const result = await notificationService.list(check.session.userId, check.groupId, { unreadOnly })
    return NextResponse.json({ ...result, groupId: check.groupId })
  } catch (error) {
    return handleApiError(error, 'Failed to list notices')
  }
}
