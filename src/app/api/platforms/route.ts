import { NextResponse } from 'next/server'
import { platformService } from '@/services/platform.service'
import { handleApiError, requireActiveGroup } from '@/lib/api-helpers'
import { LIMITS } from '@/lib/constants'

export async function GET(request: Request) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const { searchParams } = new URL(request.url)
    const withCounts = searchParams.get('counts') === 'true'

    const platforms = withCounts
      ? await platformService.listWithCounts(check.groupId)
      : await platformService.list(check.groupId)

    return NextResponse.json({ platforms })
  } catch (error) {
    return handleApiError(error, 'Failed to list platforms')
  }
}

export async function POST(request: Request) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const body = await request.json()
    const { name } = body

    if (typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ error: 'Name is required', code: 'NAME_REQUIRED' }, { status: 400 })
    }
    if (name.trim().length > LIMITS.PLATFORM_NAME) {
      return NextResponse.json({ error: `Name too long (max ${LIMITS.PLATFORM_NAME} characters)`, code: 'NAME_TOO_LONG' }, { status: 400 })
    }

    const platform = await platformService.create(check.groupId, name)
    return NextResponse.json({ platform }, { status: 201 })
  } catch (error) {
    return handleApiError(error, 'Failed to create platform')
  }
}
