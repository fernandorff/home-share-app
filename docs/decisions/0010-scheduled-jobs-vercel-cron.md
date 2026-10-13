# Scheduled jobs: daily Vercel Cron → secret-guarded route → idempotent reconciliation

- Status: accepted
- Date: 2026-10-04
- Specs: [008 — Recurring expenses](../specs/008-recurring-expenses/design.md),
  [009 — Notification center](../specs/009-pwa-notification-center/design.md)

**Decision:** time-driven work runs as a once-a-day Vercel Cron calling `GET /api/cron/<job>` with
`Authorization: Bearer $CRON_SECRET` (constant-time check, fail-closed when unset); every job is an
idempotent **reconciliation** — it derives what should exist from current state (never "since the last
run"), claims each unit of work through a database unique key inside the same transaction as the write,
computes "today" in the entity's own IANA timezone, and writes as the system actor (`actorId` null).

## Context and Problem Statement

Recurring expenses must be posted on their due day even if nobody opens the app, and reminders must go
out the day before. The app runs on Vercel serverless functions (no long-running process) with Neon
Postgres. Vercel Cron delivery is best effort: a run can be missed, the same run can be delivered more
than once, and failed runs are not retried; on the Hobby plan a job may run at most once a day and fires
anywhere inside the scheduled hour. The server clock is UTC, most houses live in UTC−3, and the app has
no per-house timezone. How do we run scheduled work so that money is never posted twice and a month is
never silently skipped?

## Decision Drivers

- Money correctness: a duplicate delivery must not double-post; a missed run must not drop a month.
- No new vendor or always-on infrastructure; works on the Hobby plan.
- Scheduled writes must go through the same services as user writes (splits, audit, Activity).
- The audit trail must not attribute an automatic write to a person (ADR 0005, ADR 0009).
- Testable without a scheduler or a clock.

## Considered Options

1. **Vercel Cron (daily) + bearer secret + idempotent reconciliation keyed by unique constraints** — ✅ chosen.
2. GitHub Actions `schedule` (the keep-warm ping already uses it) — ❌ scheduled workflows can be delayed
   or dropped under load and are disabled after 60 days without repository activity; the secret lives in
   a second system; not tied to deployments or rollbacks. Fine for a harmless ping, not for posting money.
3. Lazy generation on read (post due items when someone opens a page) — ❌ writes inside GET requests,
   latency and races for whoever opens first, and a house nobody opens never posts — then posts weeks at
   once when someone finally does.
4. External scheduler or queue (Upstash QStash, Inngest, Vercel Workflow/Queues) — ❌ a new product and
   signing secrets for one daily call; durable workflows are oversized for a job that finishes in
   seconds and is safe to re-run.
5. Postgres `pg_cron` on Neon — ❌ logic moves into SQL outside the codebase and its tests, bypasses
   `ExpenseService` (splits, revisions, Activity) and the session-aware audit — the same objections ADR
   0005 raised against triggers.
6. A per-entity watermark (`lastRunAt`) instead of unique keys — ❌ check-then-write is not atomic: two
   concurrent deliveries both see the old watermark and both post.

## Decision Outcome

- **Schedule** in `vercel.json` `crons` (`0 11 * * *` for posting = 08:00 in Brasília; `0 12 * * *` for
  notices). Hobby window: anywhere within that UTC hour — acceptable for monthly bills and day-before
  reminders.
- **Guard**: `requireCron(request)` in `src/lib/cron.ts` — 401 `CRON_UNAUTHORIZED` unless the header
  equals `Bearer ${CRON_SECRET}` (`crypto.timingSafeEqual`); an unset secret is a 401 plus a warning log.
  `/api/cron` is a public prefix in the middleware (a cron request has no cookie and Vercel does not
  follow the login redirect). Responses and logs carry counts only.
- **Idempotency by unique keys, claimed first**: the recurring ledger
  `@@unique([recurringExpenseId, period])` is claimed by the first statement of the posting transaction,
  `createManyAndReturn({ skipDuplicates: true })` (`INSERT … ON CONFLICT DO NOTHING`): a duplicate waits
  for the winner's claim, gets no row back and creates nothing (a `P2002` counts as a duplicate only on the
  ledger key, as a fallback). The transaction then re-reads the rule and aborts — rolling the claim back —
  when its `updatedAt` changed after the run loaded it; the next run retries with the current rule.
  Scheduled notices use `@@unique([userId, dedupeKey])` with the same
  `createManyAndReturn({ skipDuplicates: true })`.
- **Reconciliation with catch-up**: each run processes every eligible unit up to "today" (missed runs are
  caught up and dated on their own due date), bounded per entity (12 periods per rule) and by a 30 s
  deadline inside `maxDuration = 60`, checked between units, so only the unit in flight (10 s wait + 15 s
  transaction) runs past it; work goes oldest due first, so the remainder leads the next run.
- **Time**: "today" = `localToday(entity.timezone, now)` from `src/lib/recurrence.ts`; entities that are
  scheduled store an IANA timezone. Never the server's date.
- **Actor**: scheduled writes to audited models run inside `runWithAuditContext({ system: true, groupId })`
  (writes to models the audit trail skips — the ledger, personal notices — need no context); the audit
  extension then writes `actorId: null` even when a session cookie is present (the same posting code also
  runs synchronously inside a member's request). Activity labels these entries "Automatic".
- **Clock injection**: services take `now` as a parameter; routes never accept a time override.

### Consequences

- Good: duplicate deliveries, retries and overlapping runs are harmless by construction; a missed day is
  repaired by the next run.
- Good: no new vendor; scheduled writes reuse the services, so splits, revisions and Activity are
  identical to manual ones.
- Good: deterministic tests — the clock and the timezone are inputs.
- Bad: daily granularity on Hobby; anything finer (hourly reminders) needs the Pro plan.
- Bad: a failed run is not retried until the next day — postings arrive one day late (correctly dated),
  and that day's reminders are lost.
- Bad: crons run only on Production deployments; Preview needs a manual call with the secret.
- Bad: `CRON_SECRET` is one more secret to manage; automatic writes have no human actor — the "who" is
  the rule's own revision history.

### Confirmation

- `src/lib/cron.test.ts` — unset secret, missing/wrong header, correct header.
- `src/app/api/cron/recurring-expenses/route.test.ts`, `src/app/api/cron/notifications/route.test.ts` —
  401 without the secret, counts-only responses.
- `src/services/tenant-isolation.test.ts` (describe "recurring expenses", real pglite) — a second run posts
  nothing; concurrent runs post once; a pre-claimed ledger row yields no expense; three missed months are
  caught up; a rule changed after the run loaded it aborts that posting or SKIPPED write; the posted
  expense's revision has `actorId` null. `src/services/recurring-expense.service.test.ts` (Prisma mocked) —
  what a failed posting transaction means, the transaction bounds, the run's query plan and order.
- `src/services/notification.service.test.ts` — a second job run inserts no reminder.
- `src/middleware.test.ts` — `/api/cron/*` passes without a session cookie.
