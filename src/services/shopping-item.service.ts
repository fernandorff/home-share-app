import { prisma } from '@/lib/prisma'
import { generateUUID } from '@/lib/uuid'
import { ApiError } from '@/lib/errors'
import type { Prisma } from '@/generated/prisma/client'

const itemInclude = {
  addedBy: {
    select: { id: true, name: true },
  },
  expenseLinks: {
    orderBy: { expense: { date: 'desc' as const } },
    include: {
      expense: {
        select: { publicId: true, description: true, amount: true, date: true },
      },
    },
  },
} as const

type ItemWithLinks = Prisma.ShoppingItemGetPayload<{ include: typeof itemInclude }>

function serializeItem(item: ItemWithLinks) {
  const { expenseLinks, ...rest } = item
  return { ...rest, linkedExpenses: expenseLinks.map((link) => link.expense) }
}

export class ShoppingItemService {
  async list(groupId: number) {
    const items = await prisma.shoppingItem.findMany({
      where: { groupId },
      include: itemInclude,
      orderBy: [
        { isPurchased: 'asc' },
        { createdAt: 'desc' },
      ],
    })
    return items.map(serializeItem)
  }

  async create(groupId: number, name: string, addedById?: number) {
    const item = await prisma.shoppingItem.create({
      data: {
        publicId: generateUUID(),
        groupId,
        name: name.trim(),
        addedById: addedById ?? null,
      },
      include: itemInclude,
    })
    return serializeItem(item)
  }

  /** Group-scoped lookup shared by the mutations below. */
  private async findOwned(groupId: number, publicId: string) {
    const item = await prisma.shoppingItem.findFirst({ where: { publicId, groupId } })
    if (!item) throw new ApiError('Item not found', 404)
    return item
  }

  async update(groupId: number, publicId: string, name: string) {
    const item = await this.findOwned(groupId, publicId)

    const updated = await prisma.shoppingItem.update({
      where: { id: item.id },
      data: { name: name.trim() },
      include: itemInclude,
    })
    return serializeItem(updated)
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
    await prisma.$executeRaw`UPDATE "ShoppingItem" SET "isPurchased" = NOT "isPurchased" WHERE id = ${item.id}`

    const updated = await prisma.shoppingItem.findFirstOrThrow({
      where: { id: item.id },
      include: itemInclude,
    })
    return serializeItem(updated)
  }

  /** Replace every expense link after proving both sides belong to the active house. */
  async replaceExpenseLinks(groupId: number, publicId: string, expensePublicIds: string[]) {
    return prisma.$transaction(async (tx) => {
      const item = await tx.shoppingItem.findFirst({
        where: { publicId, groupId },
        select: { id: true, isPurchased: true },
      })
      if (!item) throw new ApiError('Item not found', 404)
      if (!item.isPurchased) {
        throw new ApiError('Only purchased items can be linked to expenses', 409, 'ITEM_NOT_PURCHASED')
      }

      const expenses = await tx.expense.findMany({
        where: { groupId, publicId: { in: expensePublicIds } },
        select: { id: true, publicId: true },
      })
      if (expenses.length !== expensePublicIds.length) {
        throw new ApiError('One or more expenses were not found in this house', 404, 'EXPENSE_NOT_FOUND')
      }

      await tx.shoppingItemExpense.deleteMany({ where: { shoppingItemId: item.id } })
      if (expenses.length > 0) {
        await tx.shoppingItemExpense.createMany({
          data: expenses.map((expense) => ({ shoppingItemId: item.id, expenseId: expense.id })),
        })
      }

      const updated = await tx.shoppingItem.findUniqueOrThrow({
        where: { id: item.id },
        include: itemInclude,
      })
      return serializeItem(updated)
    })
  }

  async clearPurchased(groupId: number) {
    return prisma.shoppingItem.deleteMany({
      where: { groupId, isPurchased: true },
    })
  }
}

export const shoppingItemService = new ShoppingItemService()
