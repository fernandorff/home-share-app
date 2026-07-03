import { prisma } from '@/lib/prisma'
import { uuidv7 } from '@/lib/uuid'
import { ApiError } from '@/lib/errors'

// A house's custom payment methods (system defaults from lib/payment-methods are i18n keys).
// Mirrors CategoryService: Expense.paymentMethods[] holds the custom name or a default key.
export class PaymentMethodService {
  async list(groupId: number) {
    return prisma.paymentMethod.findMany({ where: { groupId }, orderBy: { name: 'asc' } })
  }

  async listWithCounts(groupId: number) {
    const methods = await prisma.paymentMethod.findMany({ where: { groupId }, orderBy: { name: 'asc' } })
    if (methods.length === 0) return []
    // One aggregate instead of one count per method (see CategoryService.listWithCounts).
    const rows = await prisma.$queryRaw<{ tag: string; count: bigint }[]>`
      SELECT tag, COUNT(*)::bigint AS count
      FROM "Expense", unnest(formas_pagamento) AS tag
      WHERE "groupId" = ${groupId}
      GROUP BY tag
    `
    const byTag = new Map(rows.map((r) => [r.tag, Number(r.count)]))
    return methods.map((m) => ({ ...m, _count: { expenses: byTag.get(m.name) ?? 0 } }))
  }

  async findByPublicId(groupId: number, publicId: string) {
    return prisma.paymentMethod.findFirst({ where: { publicId, groupId } })
  }

  async create(groupId: number, name: string) {
    const trimmed = name.trim()
    const existing = await prisma.paymentMethod.findFirst({ where: { groupId, name: trimmed } })
    if (existing) throw new ApiError('Já existe uma forma de pagamento com esse nome', 409)
    try {
      return await prisma.paymentMethod.create({ data: { publicId: uuidv7(), groupId, name: trimmed } })
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'P2002') {
        throw new ApiError('Já existe uma forma de pagamento com esse nome', 409)
      }
      throw e
    }
  }

  async delete(groupId: number, publicId: string) {
    const method = await this.findByPublicId(groupId, publicId)
    if (!method) throw new ApiError('Forma de pagamento não encontrada', 404)
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "Expense" SET formas_pagamento = array_remove(formas_pagamento, ${method.name}) WHERE "groupId" = ${groupId}`
      return tx.paymentMethod.delete({ where: { id: method.id } })
    })
  }

  async existsInGroup(groupId: number, name: string): Promise<boolean> {
    const m = await prisma.paymentMethod.findFirst({ where: { groupId, name }, select: { id: true } })
    return m !== null
  }
}

export const paymentMethodService = new PaymentMethodService()
