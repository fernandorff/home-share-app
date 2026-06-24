import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { getAuditContext } from "@/lib/audit-context";
import { verifySession, SESSION_COOKIE } from "@/lib/auth";

// Reliable "who" for a real request: read the session cookie from Next's request scope. Next keeps
// that scope alive across the handler's awaits (the run()-wrapping we'd otherwise need ourselves),
// so this works inside the extension where our own AsyncLocalStorage enterWith does not. Throws when
// called outside a request (tests, scripts) → caught → null, and the ALS context takes over there.
async function actorFromRequest(): Promise<number | null> {
  try {
    const { cookies } = await import("next/headers");
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    if (!token) return null;
    const session = await verifySession(token);
    return session?.userId ?? null;
  } catch {
    return null;
  }
}

// Envers-style automatic audit: a Prisma client extension that records an EntityRevision for every
// create/update/delete (single-row and bulk) of any audited model — a post-state snapshot + who +
// which house. The "before" of a change is simply the previous revision's "after" (history chain),
// so we never pre-read: that keeps every write to a SINGLE round-trip.
//
// Why the revision write is deferred (fire-and-forget), not awaited inside the operation:
// when a write happens inside an interactive/nested transaction, that transaction holds the DB
// connection; awaiting a second write on the (un-extended) base client would need a second
// connection and DEADLOCK on a single-connection pool (the test socket). Deferring the write until
// after the operation returns — when the tx has released the connection — avoids that entirely.
// Trade-off: capture is best-effort (like recordActivity); call flushAudit() to await pending writes
// (tests rely on this; a handler can too if it needs a hard guarantee).

const SKIP_MODELS = new Set(["EntityRevision", "AuditLog"]);
const WRITE_OPS = new Set([
  "create", "update", "delete", "upsert", "createMany", "updateMany", "deleteMany",
]);
const SENSITIVE_FIELDS = new Set(["password"]);

type AnyRow = Record<string, unknown>;

const pending = new Set<Promise<unknown>>();

/** Await all in-flight revision writes. Used by tests; safe to call anywhere. */
export async function flushAudit(): Promise<void> {
  await Promise.allSettled([...pending]);
}

/** Deep-convert a Prisma row into a JSON-safe value: Decimal→string, Date→ISO, drop secrets. */
function sanitize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Prisma.Decimal) return value.toString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(sanitize);
  if (typeof value === "object") {
    const out: AnyRow = {};
    for (const [k, v] of Object.entries(value as AnyRow)) {
      if (SENSITIVE_FIELDS.has(k)) continue;
      out[k] = sanitize(v);
    }
    return out;
  }
  return value;
}

function pickGroupId(...rows: Array<{ groupId?: unknown } | null | undefined>): number | null {
  for (const r of rows) {
    if (r && typeof r.groupId === "number") return r.groupId;
  }
  return null;
}

export function auditExtension(base: PrismaClient) {
  function enqueue(rows: Prisma.EntityRevisionUncheckedCreateInput[]): void {
    if (rows.length === 0) return;
    const p = base.entityRevision
      .createMany({ data: rows })
      .then(() => undefined)
      .catch((e) => console.error("audit revision failed", e))
      .finally(() => pending.delete(p));
    pending.add(p);
  }

  return Prisma.defineExtension({
    name: "entity-audit",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (SKIP_MODELS.has(model) || !WRITE_OPS.has(operation)) {
            return query(args);
          }

          // Resolve the actor BEFORE awaiting the query: a pooled pg connection can resume the
          // post-await continuation on a different async context where our AsyncLocalStorage store
          // is gone. Prefer the explicit ALS context (tests / runWithAuditContext); fall back to the
          // request's session cookie (reliable in real route handlers).
          const ctx = getAuditContext();
          const actorId = ctx.actorId ?? (await actorFromRequest());

          const result = await query(args);

          try {
            const a = args as { where?: object; data?: AnyRow | AnyRow[] };
            const stamp = { entityType: model, actorId };

            if (operation === "create") {
              const row = result as AnyRow;
              enqueue([{ ...stamp, entityId: String(row.id), action: "CREATE",
                groupId: pickGroupId(row, ctx), after: sanitize(row) as Prisma.InputJsonValue }]);
            } else if (operation === "update" || operation === "upsert") {
              const row = result as AnyRow;
              enqueue([{ ...stamp, entityId: String(row.id), action: "UPDATE",
                groupId: pickGroupId(row, ctx), after: sanitize(row) as Prisma.InputJsonValue }]);
            } else if (operation === "delete") {
              // delete returns the removed row — record its final state.
              const row = result as AnyRow;
              enqueue([{ ...stamp, entityId: String(row.id), action: "DELETE",
                groupId: pickGroupId(row, ctx), before: sanitize(row) as Prisma.InputJsonValue }]);
            } else if (operation === "createMany") {
              // createMany can't return the new rows/ids — log one marker with the input payload.
              const data = Array.isArray(a.data) ? a.data : a.data ? [a.data] : [];
              const count = (result as { count?: number })?.count ?? data.length;
              enqueue([{ ...stamp, entityId: `bulk:${count}`, action: "CREATE",
                groupId: pickGroupId(data[0], ctx), after: sanitize(data) as Prisma.InputJsonValue }]);
            } else if (operation === "updateMany" || operation === "deleteMany") {
              // Bulk: no per-row data without a pre-read — log a marker with the targeting clause.
              const count = (result as { count?: number })?.count ?? 0;
              enqueue([{ ...stamp, entityId: `bulk:${count}`,
                action: operation === "updateMany" ? "UPDATE" : "DELETE",
                groupId: pickGroupId(ctx),
                after: sanitize({ where: a.where ?? {}, data: a.data ?? null }) as Prisma.InputJsonValue }]);
            }
          } catch (e) {
            console.error("audit post-write failed", e);
          }

          return result;
        },
      },
    },
  });
}
