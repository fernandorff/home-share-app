import { prisma } from '@/lib/prisma'

// Reads the Envers-style EntityRevision trail (written by lib/prisma-audit).
// EntityRevision has NO foreign keys, so the actor's name is resolved manually here.

export interface RevisionRecord {
  id: number
  entityType: string
  entityId: string
  action: string // CREATE | UPDATE | DELETE
  actorId: number | null
  actorName: string | null
  createdAt: string // ISO
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
}

type Json = Record<string, unknown> | null

async function actorNames(actorIds: (number | null)[]): Promise<Map<number, string>> {
  const ids = [...new Set(actorIds.filter((x): x is number => x != null))]
  if (ids.length === 0) return new Map()
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  })
  return new Map(users.map((u) => [u.id, u.name]))
}

function toRecord(
  row: {
    id: number
    entityType: string
    entityId: string
    action: string
    actorId: number | null
    before: unknown
    after: unknown
    createdAt: Date
  },
  names: Map<number, string>
): RevisionRecord {
  return {
    id: row.id,
    entityType: row.entityType,
    entityId: row.entityId,
    action: row.action,
    actorId: row.actorId,
    actorName: row.actorId != null ? names.get(row.actorId) ?? null : null,
    createdAt: row.createdAt.toISOString(),
    before: (row.before as Json) ?? null,
    after: (row.after as Json) ?? null,
  }
}

export class RevisionService {
  /** Full chronological trail for a single entity (oldest first; the client builds the diff chain). */
  async listForEntity(groupId: number, entityType: string, entityId: string): Promise<RevisionRecord[]> {
    const rows = await prisma.entityRevision.findMany({
      where: { groupId, entityType, entityId },
      orderBy: { createdAt: 'asc' },
    })
    const names = await actorNames(rows.map((r) => r.actorId))
    return rows.map((r) => toRecord(r, names))
  }

  /**
   * Recent revisions across all entities in a house (newest first), for the detailed audit feed.
   * Bulk markers (entityId `bulk:N`, e.g. CSV imports) point at no single entity — excluded here.
   */
  async listForGroup(
    groupId: number,
    opts: { entityType?: string; limit?: number } = {}
  ): Promise<RevisionRecord[]> {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 300)
    const rows = await prisma.entityRevision.findMany({
      where: {
        groupId,
        ...(opts.entityType ? { entityType: opts.entityType } : {}),
        NOT: { entityId: { startsWith: 'bulk:' } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
    const names = await actorNames(rows.map((r) => r.actorId))
    return rows.map((r) => toRecord(r, names))
  }
}

export const revisionService = new RevisionService()
