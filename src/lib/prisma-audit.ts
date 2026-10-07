import { after } from "next/server";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { getAuditContext } from "@/lib/audit-context";
import { verifySession, SESSION_COOKIE } from "@/lib/auth";
import { logger } from "@/lib/logger";

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

// RecurringExpenseOccurrence is the recurring poster's idempotency ledger (spec 008): system bookkeeping
// whose audited effect is the Expense CREATE it links to. Notification and NotificationPreference
// (spec 009) are personal data, and Activity › Detailed is readable by every member of the house.
// PushSubscription (spec 010) holds per-device secrets (`auth`, `p256dh`).
const SKIP_MODELS = new Set([
  "EntityRevision", "AuditLog", "RecurringExpenseOccurrence", "Notification", "NotificationPreference", "PushSubscription",
]);
// Every Prisma write operation (pinned against Prisma's own action list by prisma-audit.test.ts): one left out is
// a silent hole in the trail.
export const WRITE_OPS: ReadonlySet<string> = new Set([
  "create", "update", "delete", "upsert", "createMany", "updateMany", "deleteMany",
  "createManyAndReturn", "updateManyAndReturn",
]);
// joinCode grants entry to a house — never copy it into a snapshot (the Detailed feed is readable
// by every member, while the code itself is admin-only). auth / p256dh are a push subscription's keys:
// stripped too in case a User write ever includes its pushSubscriptions in the returned row.
const SENSITIVE_FIELDS = new Set(["password", "joinCode", "auth", "p256dh"]);

type AnyRow = Record<string, unknown>;

// R3-19: a sensitive value never enters a snapshot, but THAT it changed is not secret — an update
// whose payload sets one records `<field>Changed: true` (e.g. joinCodeChanged), so Activity can say
// "regenerated the house code" instead of an update where nothing visible changed. Only the update's
// own `data` is inspected (no pre-read: writes stay single round-trip). A key set to `undefined` is
// ignored by Prisma (the column is untouched), so it is no change either.
function changeMarkers(data: unknown): AnyRow {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  return Object.fromEntries(
    Object.entries(data)
      .filter(([k, v]) => SENSITIVE_FIELDS.has(k) && v !== undefined)
      .map(([k]) => [`${k}Changed`, true])
  );
}

const pending = new Set<Promise<unknown>>();

/** Await all in-flight revision writes. Used by tests; safe to call anywhere. */
export async function flushAudit(): Promise<void> {
  await Promise.allSettled([...pending]);
}

/**
 * Exported for the few writes the extension cannot see (raw SQL), which record their revision explicitly.
 * Deep-convert a Prisma row into a JSON-safe value: Decimal→string, Date→ISO, drop secrets.
 */
export function sanitize(value: unknown): unknown {
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

function pickGroupId(model: string, ...rows: Array<{ id?: unknown; groupId?: unknown } | null | undefined>): number | null {
  for (const r of rows) {
    if (!r) continue;
    // A Group row has no groupId column — it IS the tenant, so its own id scopes the revision.
    if (model === "Group" && typeof r.id === "number") return r.id;
    if (typeof r.groupId === "number") return r.groupId;
  }
  return null;
}

export function auditExtension(base: PrismaClient) {
  function enqueue(rows: Prisma.EntityRevisionUncheckedCreateInput[]): void {
    if (rows.length === 0) return;
    const write = () =>
      base.entityRevision
        .createMany({ data: rows })
        .then(() => undefined)
        .catch((e) => logger.error("audit revision failed", { entityType: rows[0].entityType }, e));
    // In a real request, hand the write to Next's after(): the response is sent immediately, but the
    // platform keeps the serverless function alive until the write finishes — so a deferred audit is
    // never dropped on freeze (plain fire-and-forget would risk that). Outside a request (tests,
    // scripts) after() throws → track the promise so flushAudit() can await it.
    try {
      after(write);
    } catch {
      const p = write().finally(() => pending.delete(p));
      pending.add(p);
    }
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
          // request's session cookie (reliable in real route handlers). A system context (scheduled
          // writes) is never attributed to a person, cookie or not.
          const ctx = getAuditContext();
          const actorId = ctx.system ? null : ctx.actorId ?? (await actorFromRequest());

          const result = await query(args);

          try {
            const a = args as { where?: object; data?: AnyRow | AnyRow[] };
            const stamp = { entityType: model, actorId };

            if (operation === "create") {
              const row = result as AnyRow;
              enqueue([{ ...stamp, entityId: String(row.id), action: "CREATE",
                groupId: pickGroupId(model, row, ctx), after: sanitize(row) as Prisma.InputJsonValue }]);
            } else if (operation === "update" || operation === "upsert") {
              const row = result as AnyRow;
              enqueue([{ ...stamp, entityId: String(row.id), action: "UPDATE",
                groupId: pickGroupId(model, row, ctx),
                after: { ...(sanitize(row) as AnyRow), ...changeMarkers(a.data) } as Prisma.InputJsonValue }]);
            } else if (operation === "delete") {
              // delete returns the removed row — record its final state.
              const row = result as AnyRow;
              enqueue([{ ...stamp, entityId: String(row.id), action: "DELETE",
                groupId: pickGroupId(model, row, ctx), before: sanitize(row) as Prisma.InputJsonValue }]);
            } else if (
              (operation === "createManyAndReturn" || operation === "updateManyAndReturn") &&
              (result as AnyRow[]).every((row) => row.id != null)
            ) {
              // The *AndReturn bulk writes hand back every written row: one revision per row, exactly like the
              // single-row branches (an UPDATE stores its after only; Detailed derives the before — ADR 0009).
              // Rows without an id (a `select` that leaves it out) have nothing to key on → the bulk markers below.
              const action = operation === "createManyAndReturn" ? "CREATE" : "UPDATE";
              enqueue((result as AnyRow[]).map((row) => ({ ...stamp, entityId: String(row.id), action,
                groupId: pickGroupId(model, row, ctx),
                after: { ...(sanitize(row) as AnyRow), ...(action === "UPDATE" ? changeMarkers(a.data) : {}) } as Prisma.InputJsonValue })));
            } else if (operation === "createMany" || operation === "createManyAndReturn") {
              // createMany can't return the new rows/ids — log one marker with the input payload.
              const data = Array.isArray(a.data) ? a.data : a.data ? [a.data] : [];
              const count = Array.isArray(result) ? result.length : (result as { count?: number })?.count ?? data.length;
              enqueue([{ ...stamp, entityId: `bulk:${count}`, action: "CREATE",
                groupId: pickGroupId(model, data[0], ctx), after: sanitize(data) as Prisma.InputJsonValue }]);
            } else if (operation === "updateMany" || operation === "updateManyAndReturn" || operation === "deleteMany") {
              // Bulk: no per-row data without a pre-read — log a marker with the targeting clause.
              const count = Array.isArray(result) ? result.length : (result as { count?: number })?.count ?? 0;
              enqueue([{ ...stamp, entityId: `bulk:${count}`,
                action: operation === "deleteMany" ? "DELETE" : "UPDATE",
                groupId: pickGroupId(model, ctx),
                after: sanitize({ where: a.where ?? {}, data: a.data ?? null }) as Prisma.InputJsonValue }]);
            } else {
              // A WRITE_OPS action with no branch above would otherwise vanish from the trail: say so (ids only, no data).
              logger.error("audit: write not recorded", { entityType: model, operation });
            }
          } catch (e) {
            logger.error("audit post-write failed", { entityType: model, operation }, e);
          }

          return result;
        },
      },
    },
  });
}
