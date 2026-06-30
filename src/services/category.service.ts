import { prisma } from '@/lib/prisma'
import { uuidv7 } from '@/lib/uuid'
import { ApiError } from '@/lib/errors'

export class CategoryService {
  async list(groupId: number) {
    return prisma.category.findMany({ where: { groupId }, orderBy: { name: 'asc' } })
  }

  /** Categories with how many of the house's expenses currently use each one (categories[] contains the name). */
  async listWithCounts(groupId: number) {
    const categories = await prisma.category.findMany({ where: { groupId }, orderBy: { name: 'asc' } })
    const counts = await Promise.all(
      categories.map((c) => prisma.expense.count({ where: { groupId, categories: { has: c.name } } }))
    )
    return categories.map((c, i) => ({ ...c, _count: { expenses: counts[i] } }))
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
      // No replacement needed: pull the tag off every expense that used it.
      await tx.$executeRaw`UPDATE "Expense" SET categorias = array_remove(categorias, ${category.name}) WHERE "groupId" = ${groupId}`
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
