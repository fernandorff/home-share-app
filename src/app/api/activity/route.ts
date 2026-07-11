import { NextResponse } from 'next/server'
import { auditService } from '@/services/audit.service'
import { handleApiError, requireActiveGroup } from '@/lib/api-helpers'

export async function GET() {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const entries = await auditService.list(check.groupId)
    return NextResponse.json({ entries })
  } catch (error) {
    return handleApiError(error, 'Failed to load history')
  }
}
