import { prisma } from '@/lib/prisma'
import { uuidv7 } from '@/lib/uuid'
import { generateJoinCode, normalizeJoinCode } from '@/lib/join-code'

// Member color is just an index into the front-end palette (12 colors).
// The backend only needs the count to assign colorIndex round-robin.
const MEMBER_COLORS_COUNT = 12

class GroupService {
  async listForUser(userId: number) {
    const memberships = await prisma.groupMember.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: {
        role: true,
        colorIndex: true,
        group: { select: { id: true, publicId: true, name: true } },
      },
    })
    return memberships.map(m => ({
      id: m.group.id,
      publicId: m.group.publicId,
      name: m.group.name,
      role: m.role,
      colorIndex: m.colorIndex,
    }))
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

  /** Join by code. Idempotent: joining a house you're already in just returns it. */
  async joinByCode(userId: number, rawCode: string) {
    const code = normalizeJoinCode(rawCode)
    const group = await prisma.group.findUnique({ where: { joinCode: code } })
    if (!group) return { error: 'Código inválido — confira com quem te convidou' }

    const existing = await prisma.groupMember.findUnique({
      where: { userId_groupId: { userId, groupId: group.id } },
    })
    if (existing) return { group }

    const memberCount = await prisma.groupMember.count({ where: { groupId: group.id } })
    await prisma.groupMember.create({
      data: {
        userId,
        groupId: group.id,
        role: 'MEMBER',
        colorIndex: memberCount % MEMBER_COLORS_COUNT,
      },
    })
    return { group }
  }

  async listMembers(groupId: number) {
    const members = await prisma.groupMember.findMany({
      where: { groupId },
      orderBy: { createdAt: 'asc' },
      select: {
        role: true,
        colorIndex: true,
        user: { select: { id: true, publicId: true, name: true, username: true } },
      },
    })
    return members.map(m => ({
      id: m.user.id,
      publicId: m.user.publicId,
      name: m.user.name,
      username: m.user.username,
      role: m.role,
      colorIndex: m.colorIndex,
    }))
  }

  async regenerateJoinCode(groupId: number) {
    const joinCode = generateJoinCode()
    await prisma.group.update({ where: { id: groupId }, data: { joinCode } })
    return joinCode
  }
}

export const groupService = new GroupService()
