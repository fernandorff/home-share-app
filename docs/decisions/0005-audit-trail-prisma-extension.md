# Audit trail via Prisma extension writing EntityRevision rows

- Status: accepted
- Date: 2026-07-11 (backfilled — decision predates this record)

**Decision:** every entity write is audited Envers-style into one generic
`EntityRevision` table (`entityType`, `entityId`, `action`, `actorId`, `before`/`after`
JSON) by a Prisma client extension — the app code never writes revisions explicitly, and
the actor flows in ambiently via AsyncLocalStorage.

## Context and Problem Statement

Housemates share money; "who changed this expense, when, from what to what" must be
answerable after the fact. How do we record a complete change history without sprinkling
audit calls through every service method?

## Decision Drivers

- Auditing must be automatic — a forgotten audit call is a silent hole in the trail.
- The actor is a session concept (cookie), which the database layer doesn't know about.
- One history mechanism for all entities, not one shadow table per model.

## Considered Options

1. **Prisma client extension + one generic `EntityRevision` table** — ✅ chosen.
2. Postgres triggers writing history tables — ❌ the actor (session user) isn't visible
   to the database without smuggling it through `SET LOCAL` on every transaction; audit
   logic drifts away from the codebase into migrations.
3. Per-entity shadow tables (classic Envers) — ❌ a schema change per audited model,
   forever; the generic JSON `before`/`after` gives the same answer with one table.
4. Explicit audit calls in each service method — ❌ relies on every future method
   remembering; the first forgotten call defeats the purpose.

## Decision Outcome

[src/lib/prisma.ts](../../src/lib/prisma.ts) builds the client as
`base.$extends(auditExtension(base))` — the **un-extended** `base` performs the
extension's own pre-reads and revision writes, so audit writes never re-enter the audit
(no recursion). The actor comes from AsyncLocalStorage
([src/lib/audit-context.ts](../../src/lib/audit-context.ts), `runWithAuditContext`),
populated from the session cookie per request. `before`/`after` diffs are computed in
[src/lib/audit-diff.ts](../../src/lib/audit-diff.ts).

Hard-won constraints (violating these broke things during rollout):

- **Single-connection deadlock**: the pre-read and the write can come from the same pool;
  with a 1-connection pool (tests use pglite) an extension that opens a second concurrent
  query deadlocks. The extension is written to never hold two connections.
- **Serverless write timing**: revision writes must complete within the request (or via
  `after()`) — fire-and-forget promises die when the serverless function freezes.

### Consequences

- Good: coverage by construction — new models are audited the moment they're written
  through the extended client.
- Good: one queryable timeline (`entityType`+`entityId`, or `groupId`) powers the history
  UI directly.
- Bad: revisions are JSON snapshots — schema changes make very old `before`/`after`
  payloads diverge from current field names; acceptable for a human-readable trail.
- Bad: every write costs an extra pre-read + one insert.

### Confirmation

- `audit-diff` unit tests ([src/lib/audit-diff.test.ts](../../src/lib/audit-diff.test.ts));
  integration tests assert revisions appear for service writes with the right actor.
