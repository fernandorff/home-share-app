import { NextResponse } from 'next/server'
import { handleApiError, requireSession } from '@/lib/api-helpers'
import { prisma } from '@/lib/prisma'
import { GROUP_COOKIE, groupCookieOptions } from '@/lib/auth'

/** Switch the active house. Validates membership before setting the cookie. */
export async function POST(request: Request) {
  try {
    const check = await requireSession()
    if (!check.ok) return check.response

    const body = await request.json()
    const groupId = Number(body.groupId)
    if (!Number.isInteger(groupId) || groupId <= 0) {
      return NextResponse.json({ error: 'Casa inválida' }, { status: 400 })
    }

    const membership = await prisma.groupMember.findUnique({
      where: { userId_groupId: { userId: check.session.userId, groupId } },
    })
    // leftAt: not-active check done explicitly (not in the query) so a left/kicked user (BL-16)
    // gets the same clear "not a member" message instead of a Prisma null falling through.
    if (!membership || membership.leftAt !== null) {
      return NextResponse.json({ error: 'Você não participa desta casa' }, { status: 403 })
    }

    const response = NextResponse.json({ ok: true, groupId })
    response.cookies.set(GROUP_COOKIE, String(groupId), groupCookieOptions())
    return response
  } catch (error) {
    return handleApiError(error, 'Erro ao trocar de casa')
  }
}
