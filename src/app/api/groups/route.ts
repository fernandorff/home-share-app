import { NextResponse } from 'next/server'
import { groupService } from '@/services/group.service'
import { handleApiError, requireSession } from '@/lib/api-helpers'
import { GROUP_COOKIE, groupCookieOptions } from '@/lib/auth'

export async function GET() {
  try {
    const check = await requireSession()
    if (!check.ok) return check.response

    const groups = await groupService.listForUser(check.session.userId)
    return NextResponse.json({ groups })
  } catch (error) {
    return handleApiError(error, 'Failed to list houses')
  }
}

export async function POST(request: Request) {
  try {
    const check = await requireSession()
    if (!check.ok) return check.response

    const body = await request.json()
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) {
      return NextResponse.json({ error: 'House name is required', code: 'NAME_REQUIRED' }, { status: 400 })
    }
    if (name.length > 80) {
      return NextResponse.json({ error: 'House name too long (max 80 characters)', code: 'NAME_TOO_LONG' }, { status: 400 })
    }

    const group = await groupService.create(check.session.userId, name)

    const response = NextResponse.json(
      { group: { id: group.id, publicId: group.publicId, name: group.name, joinCode: group.joinCode } },
      { status: 201 }
    )
    response.cookies.set(GROUP_COOKIE, String(group.id), groupCookieOptions())
    return response
  } catch (error) {
    return handleApiError(error, 'Failed to create house')
  }
}
