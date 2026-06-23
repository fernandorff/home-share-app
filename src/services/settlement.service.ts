import { prisma } from '@/lib/prisma'
import { uuidv7 } from '@/lib/uuid'
import { ApiError } from '@/lib/errors'

const settlementInclude = {
  fromUser: { select: { id: true, name: true } },
  toUser: { select: { id: true, name: true } },
} as const

export interface CreateSettlementInput {
  fromUserId: number
  toUserId: number
  amount: number
  note?: string | null
  date?: Date
  createdById?: number | null
}

export class SettlementService {
  /** Newest payments first (for the history list). */
  async list(groupId: number) {
    return prisma.settlement.findMany({
      where: { groupId },
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      include: settlementInclude,
    })
  }

  async create(groupId: number, input: CreateSettlementInput) {
    return prisma.settlement.create({
      data: {
        publicId: uuidv7(),
        groupId,
        fromUserId: input.fromUserId,
        toUserId: input.toUserId,
        amount: input.amount,
        note: input.note ?? null,
        date: input.date ?? new Date(),
        createdById: input.createdById ?? null,
      },
      include: settlementInclude,
    })
  }

  /** Group-scoped delete — never touches another house's payment. */
  async delete(groupId: number, publicId: string) {
    const settlement = await prisma.settlement.findFirst({
      where: { publicId, groupId },
      include: settlementInclude,
    })
    if (!settlement) throw new ApiError('Pagamento não encontrado nesta casa', 404)
    await prisma.settlement.delete({ where: { id: settlement.id } })
    return settlement
  }
}

export const settlementService = new SettlementService()
