import { NextResponse } from 'next/server'
import { ApiError } from '@/lib/errors'
import { notificationService } from '@/services/notification.service'
import { handleApiError, requireActiveGroup } from '@/lib/api-helpers'

interface RouteParams {
  params: Promise<{ notificationId: string }>
}

// The `[notificationId]` segment is the notice's publicId. The service looks it up with the compound
// { publicId, userId, groupId } scope: another member's or house's notice is 404 NOTIFICATION_NOT_FOUND.

/** Marks one notice read (spec 009, criterion 12): `{ read: true }` only; idempotent. */
export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const body = await request.json().catch(() => null)
    if (body?.read !== true) {
      throw new ApiError('Send { "read": true }', 400, 'NOTIFICATION_PATCH_INVALID')
    }

    const { notificationId } = await params
    const unreadCount = await notificationService.markRead(check.session.userId, check.groupId, notificationId)
    return NextResponse.json({ unreadCount })
  } catch (error) {
    return handleApiError(error, 'Failed to update notice')
  }
}

/** Removes one notice (spec 009, criterion 12). */
export async function DELETE(_request: Request, { params }: RouteParams) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const { notificationId } = await params
    const unreadCount = await notificationService.delete(check.session.userId, check.groupId, notificationId)
    return NextResponse.json({ unreadCount })
  } catch (error) {
    return handleApiError(error, 'Failed to remove notice')
  }
}
