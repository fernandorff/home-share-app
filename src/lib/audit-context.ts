import { AsyncLocalStorage } from "node:async_hooks";

// Request-scoped context for the audit trail: who (actorId) and which house (groupId) triggered
// the write. The Prisma audit extension reads this when stamping an EntityRevision.
//
// Envers solves the same problem with a thread-local set by a Spring filter; the JS equivalent is
// AsyncLocalStorage. `runWithAuditContext` is the reliable form (wrap a block) — used by tests and
// any handler that wants a guaranteed actor. `setAuditContext` (enterWith) is best-effort: handy to
// call from requireSession with zero handler churn, but enterWith may not propagate back across an
// awaited helper boundary, so treat the actor as a best-effort enrichment, not a guarantee.
export interface AuditContext {
  actorId?: number;
  groupId?: number;
}

const storage = new AsyncLocalStorage<AuditContext>();

/** Run `fn` with the given audit context guaranteed visible to every write inside it. */
export function runWithAuditContext<T>(ctx: AuditContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Best-effort: merge into the current context for the remainder of this async execution. */
export function setAuditContext(ctx: AuditContext): void {
  const prev = storage.getStore();
  storage.enterWith({ ...prev, ...ctx });
}

export function getAuditContext(): AuditContext {
  return storage.getStore() ?? {};
}
