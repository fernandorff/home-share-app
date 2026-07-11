import { prisma } from '@/lib/prisma'
import { generateUUID } from '@/lib/uuid'
import { ApiError } from '@/lib/errors'

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
    if (!item) throw new ApiError('Item não encontrado', 404)
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

    // Flip in the DB (SET comprado = NOT comprado) rather than reading the value into JS and
    // writing back its negation — the read-modify-write version loses updates when two people
    // tap the same checkbox at once (found in QA). The NOT is evaluated atomically under the
    // row lock, so N concurrent toggles land on the correct final state.
    await prisma.$executeRaw`UPDATE "item_compra" SET "comprado" = NOT "comprado" WHERE id = ${item.id}`

    return prisma.shoppingItem.findFirstOrThrow({
      where: { id: item.id },
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
