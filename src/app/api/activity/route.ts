import { NextResponse } from 'next/server'
import { auditService } from '@/services/audit.service'
import { handleApiError, requireActiveGroup } from '@/lib/api-helpers'
import { ACTIVITY_SUMMARY_LIMIT } from '@/lib/constants'

export async function GET() {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    // Fetch one extra row: if it comes back, there are more entries than the page shows, so the
    // "showing the N most recent" notice must appear. Without the +1, a house with EXACTLY
    // ACTIVITY_SUMMARY_LIMIT entries would show the notice despite nothing being hidden.
    const rows = await auditService.list(check.groupId, ACTIVITY_SUMMARY_LIMIT + 1)
    const hasMore = rows.length > ACTIVITY_SUMMARY_LIMIT
    const entries = hasMore ? rows.slice(0, ACTIVITY_SUMMARY_LIMIT) : rows
    return NextResponse.json({ entries, hasMore })
  } catch (error) {
    return handleApiError(error, 'Failed to load history')
  }
}
