import { prisma } from '@/lib/prisma'
import { sanitize } from '@/lib/prisma-audit'

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

// Read-side redaction (defense in depth): revisions written before the audit stopped copying
// joinCode still hold it in their snapshots. `sanitize` drops the sensitive fields at any depth, so
// no read path can return them whatever is stored.
function redact(snapshot: unknown): Json {
  return snapshot == null ? null : (sanitize(snapshot) as Json)
}

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
    before: redact(row.before),
    after: redact(row.after),
  }
}

/**
 * R2-09: the audit extension stores only `after` on an UPDATE — by design its "before" is the
 * previous revision's `after` for the same entity (ADR 0005, history chain). The detailed feed
 * fills it in on read, so Activity › Detailed shows "old → new" for every update (house currency,
 * item rename, expense edits) with no write-path change and for rows already stored. Revisions
 * that carry an explicit `before` (purchase toggle, expense links) are kept as they are. Scoped
 * to the same house: a revision never borrows another tenant's snapshot.
 */
async function withPreviousState<
  R extends { id: number; entityType: string; entityId: string; action: string; before: unknown }
>(groupId: number, rows: R[]): Promise<R[]> {
  const missing = rows.filter((r) => r.action === 'UPDATE' && r.before == null)
  if (missing.length === 0) return rows
  const earlier = await prisma.entityRevision.findMany({
    where: {
      groupId,
      OR: missing.map((r) => ({ entityType: r.entityType, entityId: r.entityId, id: { lt: r.id } })),
    },
    orderBy: { id: 'desc' },
    select: { id: true, entityType: true, entityId: true, after: true },
  })
  return rows.map((r) => {
    if (r.action !== 'UPDATE' || r.before != null) return r
    const prev = earlier.find(
      (e) => e.entityType === r.entityType && e.entityId === r.entityId && e.id < r.id && e.after != null
    )
    return prev ? { ...r, before: prev.after } : r
  })
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
    const filled = await withPreviousState(groupId, rows)
    const names = await actorNames(filled.map((r) => r.actorId))
    return filled.map((r) => toRecord(r, names))
  }
}

export const revisionService = new RevisionService()
