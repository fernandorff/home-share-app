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

  async updateCurrency(groupId: number, currency: string) {
    return prisma.group.update({ where: { id: groupId }, data: { currency } })
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

  /**
   * Join by code. Idempotent: joining a house you're already in just returns it.
   * Rejoining a house you previously left/were removed from (BL-16) reactivates the SAME
   * membership row instead of creating a new one — expenses/settlements always pointed at
   * User.id directly (never at GroupMember), so nothing needs "reconnecting"; just clearing
   * `leftAt` makes them show up as active again with all their history intact.
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
        await prisma.groupMember.update({ where: { id: existing.id }, data: { leftAt: null } })
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
          role: 'MEMBER',
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
    await prisma.groupMember.update({
      where: { userId_groupId: { userId, groupId } },
      data: { leftAt: new Date() },
    })
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
}

export const groupService = new GroupService()
