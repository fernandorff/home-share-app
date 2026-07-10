import { prisma } from '@/lib/prisma'
import { Prisma } from '@/generated/prisma/client'
import { uuidv7 } from '@/lib/uuid'
import { ApiError } from '@/lib/errors'

/** A house's custom tag entry (category / platform / payment method). The three models are
 *  structurally identical (id/publicId/groupId/name/createdAt), so one factory drives all three. */
export interface TagRow {
  id: number
  publicId: string
  groupId: number
  name: string
  createdAt: Date
}

/** The subset of the Prisma delegate the tag services use (shared by all three models). */
type TagDelegate = {
  findMany(args: { where: { groupId: number }; orderBy: { name: 'asc' } }): Promise<TagRow[]>
  findFirst(args: { where: { groupId: number; name?: string; publicId?: string } }): Promise<TagRow | null>
  create(args: { data: { publicId: string; groupId: number; name: string } }): Promise<TagRow>
}

/** The Expense array column that holds this dimension's tags (used in the count/detach raw SQL). */
type TagColumn = 'categorias' | 'plataformas' | 'formas_pagamento'

/** Prisma client key for the model (used to run the delete inside the transaction). */
type TagModel = 'category' | 'platform' | 'paymentMethod'

export function makeTagService(opts: {
  delegate: TagDelegate
  model: TagModel
  column: TagColumn
  notFound: string
  duplicate: string
}) {
  const { delegate, model, column, notFound, duplicate } = opts
  // `column`/`model` are compile-time-constant unions (never user input) — safe to inject as raw SQL.
  const col = Prisma.raw(`"${column}"`)

  return {
    list(groupId: number) {
      return delegate.findMany({ where: { groupId }, orderBy: { name: 'asc' } })
    },

    /** Tags with how many of the house's expenses use each — one aggregate query, not 1 per tag. */
    async listWithCounts(groupId: number) {
      const rows = await delegate.findMany({ where: { groupId }, orderBy: { name: 'asc' } })
      if (rows.length === 0) return []
      const counts = await prisma.$queryRaw<{ tag: string; count: bigint }[]>(
        Prisma.sql`SELECT tag, COUNT(*)::bigint AS count FROM "Expense", unnest(${col}) AS tag WHERE "groupId" = ${groupId} GROUP BY tag`
      )
      const byTag = new Map(counts.map((r) => [r.tag, Number(r.count)]))
      return rows.map((r) => ({ ...r, _count: { expenses: byTag.get(r.name) ?? 0 } }))
    },

    /** Group-scoped — never resolves another house's tag. */
    findByPublicId(groupId: number, publicId: string) {
      return delegate.findFirst({ where: { publicId, groupId } })
    },

    async create(groupId: number, name: string) {
      const trimmed = name.trim()
      const existing = await delegate.findFirst({ where: { groupId, name: trimmed } })
      if (existing) throw new ApiError(duplicate, 409, 'DUPLICATE_NAME')
      try {
        return await delegate.create({ data: { publicId: uuidv7(), groupId, name: trimmed } })
      } catch (e) {
        if (e && typeof e === 'object' && 'code' in e && (e as { code?: string }).code === 'P2002') {
          throw new ApiError(duplicate, 409, 'DUPLICATE_NAME')
        }
        throw e
      }
    },

    async delete(groupId: number, publicId: string) {
      const row = await delegate.findFirst({ where: { publicId, groupId } })
      if (!row) throw new ApiError(notFound, 404)
      return prisma.$transaction(async (tx) => {
        // No replacement needed: pull the tag off every expense that used it, then delete the row.
        await tx.$executeRaw(
          Prisma.sql`UPDATE "Expense" SET ${col} = array_remove(${col}, ${row.name}) WHERE "groupId" = ${groupId}`
        )
        const txModel = (tx as unknown as Record<TagModel, { delete(args: { where: { id: number } }): Promise<TagRow> }>)[model]
        return txModel.delete({ where: { id: row.id } })
      })
    },

    /** True if `name` is one of the group's custom tags (used to validate expense input). */
    async existsInGroup(groupId: number, name: string): Promise<boolean> {
      const row = await delegate.findFirst({ where: { groupId, name } })
      return row !== null
    },
  }
}
