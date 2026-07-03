import { prisma } from '@/lib/prisma'
import { uuidv7 } from '@/lib/uuid'
import { ApiError } from '@/lib/errors'

// A house's custom platforms (system defaults from lib/platforms are i18n keys, not stored).
// Mirrors CategoryService: Expense.platforms[] holds the custom name or a default key.
export class PlatformService {
  async list(groupId: number) {
    return prisma.platform.findMany({ where: { groupId }, orderBy: { name: 'asc' } })
  }

  async listWithCounts(groupId: number) {
    const platforms = await prisma.platform.findMany({ where: { groupId }, orderBy: { name: 'asc' } })
    if (platforms.length === 0) return []
    // One aggregate instead of one count per platform (see CategoryService.listWithCounts).
    const rows = await prisma.$queryRaw<{ tag: string; count: bigint }[]>`
      SELECT tag, COUNT(*)::bigint AS count
      FROM "Expense", unnest(plataformas) AS tag
      WHERE "groupId" = ${groupId}
      GROUP BY tag
    `
    const byTag = new Map(rows.map((r) => [r.tag, Number(r.count)]))
    return platforms.map((p) => ({ ...p, _count: { expenses: byTag.get(p.name) ?? 0 } }))
  }

  /** Group-scoped — never resolves another house's platform. */
  async findByPublicId(groupId: number, publicId: string) {
    return prisma.platform.findFirst({ where: { publicId, groupId } })
  }

  async create(groupId: number, name: string) {
    const trimmed = name.trim()
    const existing = await prisma.platform.findFirst({ where: { groupId, name: trimmed } })
    if (existing) throw new ApiError('Já existe uma plataforma com esse nome', 409)
    try {
      return await prisma.platform.create({ data: { publicId: uuidv7(), groupId, name: trimmed } })
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'P2002') {
        throw new ApiError('Já existe uma plataforma com esse nome', 409)
      }
      throw e
    }
  }

  async delete(groupId: number, publicId: string) {
    const platform = await this.findByPublicId(groupId, publicId)
    if (!platform) throw new ApiError('Plataforma não encontrada', 404)
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "Expense" SET plataformas = array_remove(plataformas, ${platform.name}) WHERE "groupId" = ${groupId}`
      return tx.platform.delete({ where: { id: platform.id } })
    })
  }

  /** True if `name` is one of the group's custom platforms (used to validate expense input). */
  async existsInGroup(groupId: number, name: string): Promise<boolean> {
    const p = await prisma.platform.findFirst({ where: { groupId, name }, select: { id: true } })
    return p !== null
  }
}

export const platformService = new PlatformService()
