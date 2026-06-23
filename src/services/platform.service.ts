import { prisma } from '@/lib/prisma'
import { uuidv7 } from '@/lib/uuid'
import { ApiError } from '@/lib/errors'

export class PlatformService {
  async list(groupId: number) {
    return prisma.platform.findMany({
      where: { groupId },
      orderBy: { name: 'asc' },
    })
  }

  async listWithCounts(groupId: number) {
    return prisma.platform.findMany({
      where: { groupId },
      orderBy: { name: 'asc' },
      include: { _count: { select: { expenses: true } } },
    })
  }

  /** Group-scoped — never resolves another house's platform. */
  async findByPublicId(groupId: number, publicId: string) {
    return prisma.platform.findFirst({ where: { publicId, groupId } })
  }

  /** Group-scoped lookup by internal id (used to validate CSV-import platformId). */
  async findInGroupById(groupId: number, id: number) {
    return prisma.platform.findFirst({ where: { id, groupId } })
  }

  async create(groupId: number, name: string) {
    return prisma.platform.create({
      data: {
        publicId: uuidv7(),
        groupId,
        name: name.trim(),
      },
    })
  }

  async update(groupId: number, publicId: string, name: string) {
    const platform = await this.findByPublicId(groupId, publicId)
    if (!platform) throw new ApiError('Plataforma não encontrada', 404)

    return prisma.platform.update({
      where: { id: platform.id },
      data: { name: name.trim() },
    })
  }

  async delete(groupId: number, publicId: string, replacementPublicId: string) {
    if (replacementPublicId === publicId) {
      throw new ApiError('A plataforma substituta deve ser diferente da que será excluída', 400)
    }

    const platform = await this.findByPublicId(groupId, publicId)
    if (!platform) throw new ApiError('Plataforma não encontrada', 404)

    const replacement = await this.findByPublicId(groupId, replacementPublicId)
    if (!replacement) throw new ApiError('Plataforma substituta não encontrada', 400)

    return prisma.$transaction(async (tx) => {
      await tx.expense.updateMany({
        where: { platformId: platform.id, groupId },
        data: { platformId: replacement.id },
      })

      return tx.platform.delete({ where: { id: platform.id } })
    })
  }

  async getExpenseCount(groupId: number, platformId: number): Promise<number> {
    return prisma.expense.count({ where: { platformId, groupId } })
  }
}

export const platformService = new PlatformService()
