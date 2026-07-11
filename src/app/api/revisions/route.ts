import { NextResponse } from 'next/server'
import { revisionService } from '@/services/revision.service'
import { handleApiError, requireActiveGroup } from '@/lib/api-helpers'

// Entity types the detailed feed can filter by (Prisma model names, as stored in the trail).
const FILTERABLE = new Set(['Expense', 'Settlement', 'ShoppingItem', 'Category', 'Platform', 'PaymentMethod'])

// The detailed audit feed: recent revisions across all entities in the active house.
export async function GET(request: Request) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const { searchParams } = new URL(request.url)
    const typeParam = searchParams.get('entityType')
    const entityType = typeParam && FILTERABLE.has(typeParam) ? typeParam : undefined
    const limit = Number(searchParams.get('limit')) || undefined

    const revisions = await revisionService.listForGroup(check.groupId, { entityType, limit })
    return NextResponse.json({ revisions })
  } catch (error) {
    return handleApiError(error, 'Failed to load detailed history')
  }
}
