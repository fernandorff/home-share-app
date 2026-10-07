import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { isValidUUID } from '@/lib/uuid'
import { groupService } from '@/services/group.service'
import { handleApiError, requireActiveGroup } from '@/lib/api-helpers'

interface RouteParams {
  params: Promise<{ userId: string }>
}

/**
 * Admin removes another member from the active house (BL-16, "kick"). Soft-removes the
 * membership (never deletes it) — past expenses/settlements keep the real name in the history.
 * Refused if it would leave the house with zero active admins while other active members remain
 * (409 LAST_ADMIN). `userId` here is the target's publicId (UUID), not their internal id.
 */
export async function DELETE(_request: Request, { params }: RouteParams) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    if (check.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Only the house admin can remove members', code: 'NOT_ADMIN' },
        { status: 403 }
      )
    }

    const { userId: targetPublicId } = await params
    if (!isValidUUID(targetPublicId)) {
      return NextResponse.json({ error: 'Invalid ID' }, { status: 400 })
    }

    const target = await prisma.user.findUnique({ where: { publicId: targetPublicId }, select: { id: true } })
    if (!target) {
      return NextResponse.json({ error: 'Person not found', code: 'MEMBER_NOT_FOUND' }, { status: 404 })
    }
    if (target.id === check.session.userId) {
      return NextResponse.json(
        { error: 'Use "Leave house" to remove yourself', code: 'CANNOT_REMOVE_SELF' },
        { status: 400 }
      )
    }

    await groupService.removeMember(check.groupId, target.id)

    return NextResponse.json({ ok: true })
  } catch (error) {
    return handleApiError(error, 'Failed to remove member')
  }
}

/**
 * Admin makes another active member of the active house an admin (spec 006 — "Make admin").
 * Only `{ role: "ADMIN" }` is accepted (no demotion). The service re-checks that the caller is an
 * admin and resolves the target inside the active house only (404 otherwise); the role change is
 * audited by the Prisma extension. `userId` is the target's publicId (UUID).
 */
export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const { userId: targetPublicId } = await params
    if (!isValidUUID(targetPublicId)) {
      return NextResponse.json({ error: 'Invalid ID' }, { status: 400 })
    }
    const body = await request.json().catch(() => null)
    if (!body || body.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Only promotion to ADMIN is supported', code: 'INVALID_ROLE' }, { status: 400 })
    }

    await groupService.promoteToAdmin(check.groupId, check.session.userId, targetPublicId)
    return NextResponse.json({ ok: true })
  } catch (error) {
    return handleApiError(error, 'Failed to change member role')
  }
}
