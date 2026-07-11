import { NextResponse } from 'next/server'
import { isValidUUID } from '@/lib/uuid'
import { platformService } from '@/services/platform.service'
import { handleApiError, requireActiveGroup } from '@/lib/api-helpers'

interface RouteParams {
  params: Promise<{ platformId: string }>
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const { platformId } = await params
    if (!isValidUUID(platformId)) {
      return NextResponse.json({ error: 'Invalid ID' }, { status: 400 })
    }

    await platformService.delete(check.groupId, platformId)
    return NextResponse.json({ message: 'Platform deleted successfully' })
  } catch (error) {
    return handleApiError(error, 'Failed to delete platform')
  }
}
