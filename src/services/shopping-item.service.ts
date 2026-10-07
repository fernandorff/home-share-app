import { prisma } from '@/lib/prisma'
import { generateUUID } from '@/lib/uuid'
import { ApiError } from '@/lib/errors'
import { sanitize } from '@/lib/prisma-audit'
import { logger } from '@/lib/logger'
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

// Row shape returned by the raw toggle's RETURNING * (ShoppingItem's own columns).
type ShoppingItemRow = {
  id: number
  publicId: string
  groupId: number
  name: string
  isPurchased: boolean
  createdAt: Date
  addedById: number | null
}

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

  /** Group-scoped lookup by public id — used to snapshot the pre-update state for the activity log. */
  async findByPublicId(groupId: number, publicId: string) {
    return prisma.shoppingItem.findFirst({ where: { publicId, groupId } })
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

  async togglePurchased(groupId: number, publicId: string, actorId: number | null = null) {
    const item = await this.findOwned(groupId, publicId)

    // Flip in the DB (SET comprado = NOT comprado) rather than reading the value into JS and
    // writing back its negation — the read-modify-write version loses updates when two people
    // tap the same checkbox at once (found in QA). The NOT is evaluated atomically under the
    // row lock, so N concurrent toggles land on the correct final state.
    const [row] = await prisma.$queryRaw<ShoppingItemRow[]>`UPDATE "ShoppingItem" SET "isPurchased" = NOT "isPurchased" WHERE id = ${item.id} RETURNING *`
    // The item can be deleted between findOwned and the UPDATE — no row comes back.
    if (!row) throw new ApiError('Item not found', 404)

    // Raw SQL bypasses the audit extension ($allOperations wraps model operations only, ADR 0005),
    // so the revision Activity › Detailed reads is written here. `before` is exact: the statement
    // changed nothing but isPurchased. Best-effort like the extension's own audit writes: the toggle
    // already committed, so a failed audit insert must not turn it into a 500 (the client would
    // revert its optimistic state and a retry would flip the item back).
    try {
      await prisma.entityRevision.create({
        data: {
          entityType: 'ShoppingItem',
          entityId: String(row.id),
          groupId: row.groupId,
          action: 'UPDATE',
          actorId,
          before: sanitize({ ...row, isPurchased: !row.isPurchased }) as Prisma.InputJsonValue,
          after: sanitize(row) as Prisma.InputJsonValue,
        },
      })
    } catch (e) {
      logger.error('audit revision failed', { entityType: 'ShoppingItem' }, e)
    }

    const updated = await prisma.shoppingItem.findFirstOrThrow({
      where: { id: item.id },
      include: itemInclude,
    })
    return serializeItem(updated)
  }

  /**
   * Replace every expense link after proving both sides belong to the active house. Saving the set
   * the item already has (compared as a set — order never matters) writes nothing: no delete/create,
   * no revision, `changed: false` (I2, same shape as groupService.updateCurrency / R2-08), so the
   * caller records no activity entry either.
   */
  async replaceExpenseLinks(groupId: number, publicId: string, expensePublicIds: string[], actorId: number | null = null) {
    return prisma.$transaction(async (tx) => {
      const item = await tx.shoppingItem.findFirst({
        where: { publicId, groupId },
        select: { id: true, isPurchased: true, expenseLinks: { select: { expenseId: true } } },
      })
      if (!item) throw new ApiError('Item not found', 404)
      // B9: an item unchecked after being linked keeps its links editable (view/remove) — otherwise
      // its "N expenses" chip points at links nobody can reach. Linking a never-purchased item stays refused.
      if (!item.isPurchased && item.expenseLinks.length === 0) {
        throw new ApiError('Only purchased items can be linked to expenses', 409, 'ITEM_NOT_PURCHASED')
      }

      const expenses = await tx.expense.findMany({
        where: { groupId, publicId: { in: expensePublicIds } },
        select: { id: true, publicId: true },
      })
      if (expenses.length !== expensePublicIds.length) {
        throw new ApiError('One or more expenses were not found in this house', 404, 'EXPENSE_NOT_FOUND')
      }

      const linkedIds = new Set(item.expenseLinks.map((link) => link.expenseId))
      if (linkedIds.size === expenses.length && expenses.every((expense) => linkedIds.has(expense.id))) {
        const current = await tx.shoppingItem.findUniqueOrThrow({ where: { id: item.id }, include: itemInclude })
        return { item: serializeItem(current), changed: false }
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

      // R2-03: link rows live in ShoppingItemExpense, which Activity › Detailed doesn't list —
      // record the change on the item itself (linked-expense count before → after) so Detailed
      // shows the same event as the Summary. Inside the transaction: the links and their audit
      // row commit or roll back together (EntityRevision is skipped by the audit extension).
      const row: ShoppingItemRow = {
        id: updated.id,
        publicId: updated.publicId,
        groupId: updated.groupId,
        name: updated.name,
        isPurchased: updated.isPurchased,
        createdAt: updated.createdAt,
        addedById: updated.addedById,
      }
      await tx.entityRevision.create({
        data: {
          entityType: 'ShoppingItem',
          entityId: String(row.id),
          groupId: row.groupId,
          action: 'UPDATE',
          actorId,
          before: sanitize({ ...row, linkedExpenses: item.expenseLinks.length }) as Prisma.InputJsonValue,
          after: sanitize({ ...row, linkedExpenses: updated.expenseLinks.length }) as Prisma.InputJsonValue,
        },
      })
      return { item: serializeItem(updated), changed: true }
    })
  }

  async clearPurchased(groupId: number) {
    return prisma.shoppingItem.deleteMany({
      where: { groupId, isPurchased: true },
    })
  }
}

export const shoppingItemService = new ShoppingItemService()
