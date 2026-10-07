import { NextResponse } from 'next/server'
import { notificationService } from '@/services/notification.service'
import { handleApiError, requireSession } from '@/lib/api-helpers'

// Notice switches (spec 009, criteria 9 and 13): per user, across every house — a session is enough, no
// active house. Every type defaults to on; only overrides are stored.

export async function GET() {
  try {
    const check = await requireSession()
    if (!check.ok) return check.response

    const preferences = await notificationService.getPreferences(check.session.userId)
    return NextResponse.json({ preferences })
  } catch (error) {
    return handleApiError(error, 'Failed to load notice preferences')
  }
}

/** `{ type, enabled }`; the service validates it (400 NOTIFICATION_PREF_INVALID) and returns the updated map. */
export async function PUT(request: Request) {
  try {
    const check = await requireSession()
    if (!check.ok) return check.response

    const body = await request.json().catch(() => null)
    const preferences = await notificationService.setPreference(check.session.userId, body)
    return NextResponse.json({ preferences })
  } catch (error) {
    return handleApiError(error, 'Failed to save notice preference')
  }
}
