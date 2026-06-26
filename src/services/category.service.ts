import { prisma } from '@/lib/prisma'
import { uuidv7 } from '@/lib/uuid'
import { ApiError } from '@/lib/errors'

export class CategoryService {
  async list(groupId: number) {
    return prisma.category.findMany({ where: { groupId }, orderBy: { name: 'asc' } })
  }

  /** Categories with how many of the house's expenses currently use each one. */
  async listWithCounts(groupId: number) {
    const categories = await prisma.category.findMany({ where: { groupId }, orderBy: { name: 'asc' } })
    if (categories.length === 0) return []
    // Expense.category is a string (system key or custom name) — count by matching the name.
    const grouped = await prisma.expense.groupBy({
      by: ['category'],
      where: { groupId, category: { in: categories.map((c) => c.name) } },
      _count: { _all: true },
    })
    const countByName = new Map(grouped.map((g) => [g.category, g._count._all]))
    return categories.map((c) => ({ ...c, _count: { expenses: countByName.get(c.name) ?? 0 } }))
  }

  /** Group-scoped — never resolves another house's category. */
  async findByPublicId(groupId: number, publicId: string) {
    return prisma.category.findFirst({ where: { publicId, groupId } })
  }

  async create(groupId: number, name: string) {
    const trimmed = name.trim()
    const existing = await prisma.category.findFirst({ where: { groupId, name: trimmed } })
    if (existing) throw new ApiError('Já existe uma categoria com esse nome', 409)
    try {
      return await prisma.category.create({ data: { publicId: uuidv7(), groupId, name: trimmed } })
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'P2002') {
        throw new ApiError('Já existe uma categoria com esse nome', 409)
      }
      throw e
    }
  }

  async delete(groupId: number, publicId: string) {
    const category = await this.findByPublicId(groupId, publicId)
    if (!category) throw new ApiError('Categoria não encontrada', 404)
    return prisma.$transaction(async (tx) => {
      // No replacement needed: the expenses that used it simply become uncategorized.
      await tx.expense.updateMany({ where: { groupId, category: category.name }, data: { category: null } })
      return tx.category.delete({ where: { id: category.id } })
    })
  }

  /** True if `name` is one of the group's custom categories (used to validate expense input). */
  async existsInGroup(groupId: number, name: string): Promise<boolean> {
    const c = await prisma.category.findFirst({ where: { groupId, name }, select: { id: true } })
    return c !== null
  }
}

export const categoryService = new CategoryService()
