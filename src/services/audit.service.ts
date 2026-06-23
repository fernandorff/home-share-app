import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'

export type AuditEntityType = 'EXPENSE' | 'SETTLEMENT' | 'SHOPPING_ITEM' | 'GROUP' | 'PLATFORM'
export type AuditAction = 'CREATE' | 'UPDATE' | 'DELETE'

export interface AuditEntry {
  groupId: number
  actorId: number | null
  entityType: AuditEntityType
  entityId?: string | null
  action: AuditAction
  summary: string
  /** Field-level before/after for UPDATEs (kept small + human-meaningful). */
  changes?: Prisma.InputJsonValue | null
}

export class AuditService {
  /**
   * Append an activity entry. Fire-and-forget from routes: a logging failure must
   * NEVER fail the user's actual mutation, so callers swallow errors.
   */
  async log(entry: AuditEntry) {
    return prisma.auditLog.create({
      data: {
        groupId: entry.groupId,
        actorId: entry.actorId ?? null,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        action: entry.action,
        summary: entry.summary,
        changes: entry.changes ?? undefined,
      },
    })
  }

  async list(groupId: number, limit = 100) {
    return prisma.auditLog.findMany({
      where: { groupId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 500),
      include: { actor: { select: { id: true, name: true } } },
    })
  }
}

export const auditService = new AuditService()
