import { prisma } from '@/lib/prisma'
import { uuidv7 } from '@/lib/uuid'

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
    if (!platform) throw new Error('Plataforma não encontrada')

    return prisma.platform.update({
      where: { id: platform.id },
      data: { name: name.trim() },
    })
  }

  async delete(groupId: number, publicId: string, replacementPublicId: string) {
    const platform = await this.findByPublicId(groupId, publicId)
    if (!platform) throw new Error('Plataforma não encontrada')

    const replacement = await this.findByPublicId(groupId, replacementPublicId)
    if (!replacement) throw new Error('Plataforma substituta não encontrada')

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
