import { NextResponse } from 'next/server'
import { revisionService } from '@/services/revision.service'
import { handleApiError, requireActiveGroup } from '@/lib/api-helpers'
import { ACTIVITY_DETAILED_LIMIT, REVISION_ENTITY_TYPES } from '@/lib/constants'

// Entity types the detailed feed can filter by — same list as the page's chips.
const FILTERABLE = new Set<string>(REVISION_ENTITY_TYPES)

// The detailed audit feed: recent revisions across all entities in the active house.
export async function GET(request: Request) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const { searchParams } = new URL(request.url)
    const typeParam = searchParams.get('entityType')
    const entityType = typeParam && FILTERABLE.has(typeParam) ? typeParam : undefined
    // R3-21: one extra row tells the page whether older revisions exist (its "most recent" notice).
    // 299 keeps limit + 1 within listForGroup's 300 cap.
    const limit = Math.min(Math.max(Math.trunc(Number(searchParams.get('limit'))) || ACTIVITY_DETAILED_LIMIT, 1), 299)
    const rows = await revisionService.listForGroup(check.groupId, { entityType, limit: limit + 1 })
    const hasMore = rows.length > limit
    return NextResponse.json({ revisions: hasMore ? rows.slice(0, limit) : rows, hasMore })
  } catch (error) {
    return handleApiError(error, 'Failed to load detailed history')
  }
}
