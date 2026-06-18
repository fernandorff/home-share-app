import { prisma } from '@/lib/prisma'
import { generateUUID } from '@/lib/uuid'

const itemInclude = {
  addedBy: {
    select: { id: true, name: true },
  },
} as const

export class ShoppingItemService {
  async list(groupId: number) {
    return prisma.shoppingItem.findMany({
      where: { groupId },
      include: itemInclude,
      orderBy: [
        { isPurchased: 'asc' },
        { createdAt: 'desc' },
      ],
    })
  }

  async create(groupId: number, name: string, addedById?: number) {
    return prisma.shoppingItem.create({
      data: {
        publicId: generateUUID(),
        groupId,
        name: name.trim(),
        addedById: addedById ?? null,
      },
      include: itemInclude,
    })
  }

  /** Group-scoped lookup shared by the mutations below. */
  private async findOwned(groupId: number, publicId: string) {
    const item = await prisma.shoppingItem.findFirst({ where: { publicId, groupId } })
    if (!item) throw new Error('Item não encontrado')
    return item
  }

  async update(groupId: number, publicId: string, name: string) {
    const item = await this.findOwned(groupId, publicId)

    return prisma.shoppingItem.update({
      where: { id: item.id },
      data: { name: name.trim() },
      include: itemInclude,
    })
  }

  async delete(groupId: number, publicId: string) {
    const item = await this.findOwned(groupId, publicId)
    return prisma.shoppingItem.delete({ where: { id: item.id } })
  }

  async togglePurchased(groupId: number, publicId: string) {
    const item = await this.findOwned(groupId, publicId)

    return prisma.shoppingItem.update({
      where: { id: item.id },
      data: { isPurchased: !item.isPurchased },
      include: itemInclude,
    })
  }

  async clearPurchased(groupId: number) {
    return prisma.shoppingItem.deleteMany({
      where: { groupId, isPurchased: true },
    })
  }
}

export const shoppingItemService = new ShoppingItemService()
