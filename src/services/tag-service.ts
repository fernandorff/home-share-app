import { prisma } from '@/lib/prisma'
import { Prisma } from '@/generated/prisma/client'
import { uuidv7 } from '@/lib/uuid'
import { ApiError } from '@/lib/errors'
import { sanitize } from '@/lib/prisma-audit'
import { expenseInclude, legacyOmit } from './expense.service'
import { isSystemDefaultName, type TagKind } from '@/lib/system-defaults'

// Explicit locale, not `localeCompare`'s server-default ICU locale (nondeterministic across
// environments). Base sensitivity ignores case/accents for the primary sort (D9). Names equal
// under that (e.g. "VR"/"vr" — the duplicate check in `create()` is case-sensitive, so both can
// coexist in the same house) fall back to `collatorTiebreak`, a case-sensitive compare in the
// same locale, so the final order is fully deterministic.
const collatorBase = new Intl.Collator('pt-BR', { sensitivity: 'base' })
const collatorTiebreak = new Intl.Collator('pt-BR')

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
type TagColumn = 'categories' | 'platforms' | 'paymentMethods'

/** Prisma client key for the model (used to run the delete inside the transaction). */
type TagModel = 'category' | 'platform' | 'paymentMethod'

export function makeTagService(opts: {
  delegate: TagDelegate
  model: TagModel
  column: TagColumn
  kind: TagKind
  notFound: string
  duplicate: string
  systemCollision: string
}) {
  const { delegate, model, column, kind, notFound, duplicate, systemCollision } = opts
  // `column`/`model` are compile-time-constant unions (never user input) — safe to inject as raw SQL.
  const col = Prisma.raw(`"${column}"`)

  // The DB's `orderBy: name asc` sorts by byte value, which puts e.g. "VR" before "Vale" and
  // "Loja do bairro" before "iFood" (D9). Re-sort case/accent-insensitively after the query.
  function sortByName(rows: TagRow[]): TagRow[] {
    return [...rows].sort((a, b) => {
      const primary = collatorBase.compare(a.name, b.name)
      return primary !== 0 ? primary : collatorTiebreak.compare(a.name, b.name)
    })
  }

  return {
    async list(groupId: number) {
      const rows = await delegate.findMany({ where: { groupId }, orderBy: { name: 'asc' } })
      return sortByName(rows)
    },

    /** Tags with how many of the house's expenses use each — one aggregate query, not 1 per tag. */
    async listWithCounts(groupId: number) {
      const rows = sortByName(await delegate.findMany({ where: { groupId }, orderBy: { name: 'asc' } }))
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
      if (isSystemDefaultName(kind, trimmed)) {
        throw new ApiError(systemCollision, 409, 'SYSTEM_DEFAULT_COLLISION')
      }
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

    /** `actorId` is the session user, recorded on the revisions of the expenses that lose the tag. */
    async delete(groupId: number, publicId: string, actorId: number | null = null) {
      const row = await delegate.findFirst({ where: { publicId, groupId } })
      if (!row) throw new ApiError(notFound, 404)
      return prisma.$transaction(async (tx) => {
        // No replacement needed: pull the tag off every expense of THIS house that used it, then delete
        // the row. The sub-select locks those rows and hands back the tag array as it was, so each
        // revision below has an exact `before`.
        const detached = await tx.$queryRaw<{ id: number; previousTags: string[] }[]>(
          Prisma.sql`UPDATE "Expense" AS e SET ${col} = array_remove(e.${col}, ${row.name})
            FROM (SELECT id, ${col} AS prev FROM "Expense" WHERE "groupId" = ${groupId} AND ${row.name} = ANY(${col}) FOR UPDATE) AS old
            WHERE e.id = old.id AND e."groupId" = ${groupId}
            RETURNING e.id, old.prev AS "previousTags"`
        )
        // Raw SQL is invisible to the audit extension (ADR 0005), so the edit would leave a hole in the
        // history chain and Activity › Detailed would pin the removal on whoever edits the expense next.
        // Write the UPDATE revisions here (ADR 0009): full snapshots shaped like the extension's own
        // Expense snapshots (same include/omit, so participants and payer are there), in this transaction.
        if (detached.length > 0) {
          const previousTags = new Map(detached.map((d) => [d.id, d.previousTags]))
          const expenses = await tx.expense.findMany({
            where: { groupId, id: { in: [...previousTags.keys()] } },
            omit: legacyOmit,
            include: expenseInclude,
          })
          await tx.entityRevision.createMany({
            data: expenses.map((expense) => ({
              entityType: 'Expense',
              entityId: String(expense.id),
              groupId,
              action: 'UPDATE',
              actorId,
              before: sanitize({ ...expense, [column]: previousTags.get(expense.id) }) as Prisma.InputJsonValue,
              after: sanitize(expense) as Prisma.InputJsonValue,
            })),
          })
        }
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
