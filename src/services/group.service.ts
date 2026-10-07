import { prisma } from '@/lib/prisma'
import { uuidv7 } from '@/lib/uuid'
import { generateJoinCode, normalizeJoinCode } from '@/lib/join-code'
import { ApiError } from '@/lib/errors'

// Member color is just an index into the front-end palette (12 colors).
// The backend only needs the count to assign colorIndex round-robin.
const MEMBER_COLORS_COUNT = 12

class GroupService {
  async listForUser(userId: number) {
    // leftAt: null — a house you left/were kicked from (BL-16) must disappear from your own
    // house-switcher and "your houses" list, not just refuse access server-side.
    const memberships = await prisma.groupMember.findMany({
      where: { userId, leftAt: null },
      orderBy: { createdAt: 'asc' },
      select: {
        role: true,
        colorIndex: true,
        group: { select: { id: true, publicId: true, name: true, currency: true } },
      },
    })
    return memberships.map(m => ({
      id: m.group.id,
      publicId: m.group.publicId,
      name: m.group.name,
      currency: m.group.currency,
      role: m.role,
      colorIndex: m.colorIndex,
    }))
  }

  /**
   * Returns the group alongside the currency it replaced, so callers can log the {from, to}.
   * Picking the already-active currency is a no-op (R2-08): nothing is written — so neither a Group
   * revision nor an activity entry follows — and `changed` is false.
   */
  async updateCurrency(groupId: number, currency: string) {
    const current = await prisma.group.findUniqueOrThrow({ where: { id: groupId } })
    if (current.currency === currency) {
      return { group: current, previousCurrency: current.currency, changed: false }
    }
    const group = await prisma.group.update({ where: { id: groupId }, data: { currency } })
    return { group, previousCurrency: current.currency, changed: true }
  }

  async create(userId: number, name: string) {
    return prisma.$transaction(async tx => {
      const group = await tx.group.create({
        data: {
          publicId: uuidv7(),
          name: name.trim(),
          joinCode: generateJoinCode(),
        },
      })
      await tx.groupMember.create({
        data: { userId, groupId: group.id, role: 'ADMIN', colorIndex: 0 },
      })
      return group
    })
  }

  /** Role for someone joining or rejoining: MEMBER, except a house with no active admin must never
   *  stay that way (every admin left; the join code stays valid), so the joiner becomes its admin. */
  private async roleForJoiner(groupId: number): Promise<'ADMIN' | 'MEMBER'> {
    const activeAdmins = await prisma.groupMember.count({ where: { groupId, role: 'ADMIN', leftAt: null } })
    return activeAdmins > 0 ? 'MEMBER' : 'ADMIN'
  }

  /**
   * Join by code. Idempotent: joining a house you're already in just returns it.
   * Rejoining a house you previously left/were removed from (BL-16) reactivates the SAME
   * membership row instead of creating a new one — expenses/settlements always pointed at
   * User.id directly (never at GroupMember), so nothing needs "reconnecting"; just clearing
   * `leftAt` makes them show up as active again with all their history intact. The role is reset
   * to MEMBER on rejoin, and a brand-new member also starts as MEMBER, unless the house has no
   * active admin (then the joiner becomes ADMIN).
   */
  async joinByCode(userId: number, rawCode: string) {
    const code = normalizeJoinCode(rawCode)
    const group = await prisma.group.findUnique({ where: { joinCode: code } })
    if (!group) return { error: 'Invalid code — check with whoever invited you' }

    const existing = await prisma.groupMember.findUnique({
      where: { userId_groupId: { userId, groupId: group.id } },
    })
    if (existing) {
      if (existing.leftAt !== null) {
        // The old role does not survive a rejoin (spec 006): an admin who was kicked must not get
        // ADMIN back just by using the join code. Exception: a house with no active admin must
        // never stay that way, so the rejoining person becomes its admin.
        await prisma.groupMember.update({
          where: { id: existing.id },
          data: { leftAt: null, role: await this.roleForJoiner(group.id) },
        })
      }
      return { group }
    }

    // Counts every row ever created (active or ex) so a returning ex-member's old color slot
    // isn't handed out again to someone new while their historical expenses still show it.
    const memberCount = await prisma.groupMember.count({ where: { groupId: group.id } })
    try {
      await prisma.groupMember.create({
        data: {
          userId,
          groupId: group.id,
          role: await this.roleForJoiner(group.id),
          colorIndex: memberCount % MEMBER_COLORS_COUNT,
        },
      })
    } catch (e) {
      // Concurrent double-tap can violate @@unique([userId, groupId]); the user is
      // already a member, so joining stays idempotent instead of surfacing a 500.
      const code = e && typeof e === 'object' && 'code' in e ? (e as { code?: string }).code : undefined
      if (code !== 'P2002') throw e
    }
    return { group }
  }

  /**
   * Everyone who ever belonged to the house, active or not (`active: false` = ex-member, BL-16).
   * Callers that offer NEW selections (expense payer/participant) must filter to `active`
   * themselves; callers that just display history (balances, activity log, expense detail) want
   * the full list so an ex-member's real name/color still resolve correctly.
   */
  async listMembers(groupId: number) {
    const members = await prisma.groupMember.findMany({
      where: { groupId },
      orderBy: { createdAt: 'asc' },
      select: {
        role: true,
        colorIndex: true,
        leftAt: true,
        user: { select: { id: true, publicId: true, name: true, username: true, deletedAt: true } },
      },
    })
    return members.map(m => ({
      id: m.user.id,
      publicId: m.user.publicId,
      // A deleted account's own name/username were already scrubbed in place at deletion time
      // (BL-23) — nothing extra to do here, the generic values just flow through like any other.
      name: m.user.name,
      username: m.user.username,
      role: m.role,
      colorIndex: m.colorIndex,
      active: m.leftAt === null,
      deleted: m.user.deletedAt !== null,
    }))
  }

  async regenerateJoinCode(groupId: number) {
    const joinCode = generateJoinCode()
    await prisma.group.update({ where: { id: groupId }, data: { joinCode } })
    return joinCode
  }

  /**
   * Throws ApiError(409, LAST_ADMIN) if removing `userId` from `groupId` would leave the house
   * with zero active admins while other active members remain. Shared by leave, kick, and
   * account deletion (checked once per house the account belongs to).
   */
  private async assertCanLeave(groupId: number, userId: number): Promise<void> {
    const target = await prisma.groupMember.findUnique({ where: { userId_groupId: { userId, groupId } } })
    if (!target || target.leftAt !== null) {
      throw new ApiError('This person is no longer a member of this house', 404, 'MEMBER_NOT_FOUND')
    }
    if (target.role !== 'ADMIN') return

    const otherActiveAdmins = await prisma.groupMember.count({
      where: { groupId, role: 'ADMIN', leftAt: null, userId: { not: userId } },
    })
    if (otherActiveAdmins > 0) return

    const otherActiveMembers = await prisma.groupMember.count({
      where: { groupId, leftAt: null, userId: { not: userId } },
    })
    if (otherActiveMembers > 0) {
      throw new ApiError('This house would be left without an admin — promote another member first', 409, 'LAST_ADMIN')
    }
  }

  /**
   * Self-leave or admin-kick (BL-16): soft-removes the membership, never deletes the row —
   * expenses/settlements this person was ever part of keep their real name in the history.
   *
   * The pre-check + write is check-then-act, not atomic — two concurrent removals of the last
   * two admins could both pass the pre-check before either write commits (found in adversarial
   * review). Re-verifying the invariant AFTER the write and self-healing (reverting) if it was
   * violated closes that window without needing an interactive transaction (which would risk a
   * deadlock against the single-connection pglite test socket — see prisma-audit.ts's own note on
   * why tx-wrapped paths aren't exercised there).
   */
  async removeMember(groupId: number, userId: number): Promise<void> {
    await this.assertCanLeave(groupId, userId)
    // Notices are personal and belong to the membership (spec 009): they go with it, atomically, so a rejoin never
    // brings the old ones back. A batch transaction (not an interactive one — see above). The self-heal below
    // restores the membership only; notices lost in that rare race are an accepted, harmless loss.
    await prisma.$transaction([
      prisma.groupMember.update({
        where: { userId_groupId: { userId, groupId } },
        data: { leftAt: new Date() },
      }),
      prisma.notification.deleteMany({ where: { userId, groupId } }),
    ])
    try {
      await this.assertHasAdminIfNeeded(groupId)
    } catch (e) {
      // Self-heal: the pre-check race let this slip through — undo and surface the same error.
      await prisma.groupMember.update({ where: { userId_groupId: { userId, groupId } }, data: { leftAt: null } })
      throw e
    }
  }

  /** Post-write half of the race fix above: same invariant as assertCanLeave, re-checked after
   *  the write. `userId`'s own row already has leftAt set at this point, so a plain `leftAt: null`
   *  count already excludes it — no separate `userId: not` filter needed. */
  private async assertHasAdminIfNeeded(groupId: number): Promise<void> {
    const activeAdmins = await prisma.groupMember.count({ where: { groupId, role: 'ADMIN', leftAt: null } })
    if (activeAdmins > 0) return
    const activeMembers = await prisma.groupMember.count({ where: { groupId, leftAt: null } })
    if (activeMembers > 0) {
      throw new ApiError('This house would be left without an admin — promote another member first', 409, 'LAST_ADMIN')
    }
  }

  /** Account deletion (BL-23): same last-admin guard, applied once per active house. The actual
   *  soft-removal happens inside auth.service's deleteAccount transaction (atomic with the
   *  User row's own anonymization), not here. */
  async assertCanLeaveAllHouses(userId: number): Promise<void> {
    const memberships = await prisma.groupMember.findMany({ where: { userId, leftAt: null }, select: { groupId: true } })
    for (const m of memberships) {
      await this.assertCanLeave(m.groupId, userId)
    }
  }

  /**
   * Admin makes another active member of the same house an admin (spec 006). The actor is
   * re-checked here (403 NOT_ADMIN) and the target is resolved by publicId AND an active membership
   * in `groupId`, so another house's user or an ex-member is a 404 — tenant isolation by
   * construction. Idempotent for someone who is already an admin. The audit extension records the
   * GroupMember UPDATE revision (ADR 0005).
   */
  async promoteToAdmin(groupId: number, actorUserId: number, targetPublicId: string): Promise<void> {
    const actor = await prisma.groupMember.findUnique({
      where: { userId_groupId: { userId: actorUserId, groupId } },
      select: { role: true, leftAt: true },
    })
    if (!actor || actor.leftAt !== null || actor.role !== 'ADMIN') {
      throw new ApiError('Only the house admin can change roles', 403, 'NOT_ADMIN')
    }
    const target = await prisma.groupMember.findFirst({
      where: { groupId, leftAt: null, user: { publicId: targetPublicId } },
      select: { id: true, role: true },
    })
    if (!target) {
      throw new ApiError('This person is no longer a member of this house', 404, 'MEMBER_NOT_FOUND')
    }
    if (target.role === 'ADMIN') return
    await prisma.groupMember.update({ where: { id: target.id }, data: { role: 'ADMIN' } })
  }

  /** Houses where `userId` is the only active admin while other active members remain — exactly
   *  what assertCanLeave refuses with LAST_ADMIN. Drives the "make another member an admin first"
   *  warning in the leave-house and delete-account dialogs (spec 006). */
  async lastAdminGroupIds(userId: number): Promise<number[]> {
    const memberships = await prisma.groupMember.findMany({
      where: { userId, leftAt: null, role: 'ADMIN' },
      select: { groupId: true },
    })
    const blocked: number[] = []
    for (const m of memberships) {
      try {
        await this.assertCanLeave(m.groupId, userId)
      } catch (e) {
        if (e instanceof ApiError && e.code === 'LAST_ADMIN') blocked.push(m.groupId)
        else throw e
      }
    }
    return blocked
  }
}

export const groupService = new GroupService()
