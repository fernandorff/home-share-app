# Optimistic concurrency via expected-state tokens → 409

- Status: accepted
- Date: 2026-07-11 (backfilled — decision predates this record)

**Decision:** concurrent-edit races are *detected, never silently resolved*: mutations may
carry a client token of the state they were built against (`expectedUpdatedAt` for an
expense, `expectedGroupId` for the active house), and a mismatch returns **409** with a
stable code (`STALE_EXPENSE` / `STALE_GROUP`) telling the user to reload. The tokens
detect divergence only — they never grant authorization (see
[ADR-0002](0002-active-house-cookie-db-membership-authority.md)).

## Context and Problem Statement

Two housemates edit the same expense; the second save silently overwrites the first
(lost update — found as a real bug in adversarial QA). Same shape across tabs: tab A
switches the active house, tab B submits a form built against the old one. How do
mutations behave when the world changed under them?

## Decision Drivers

- Money edits must never be silently lost or merged wrong — a visible error beats both.
- Reads vastly outnumber write conflicts in a household app; pessimistic locking is
  disproportionate.
- The server must stay the authority; anything client-supplied is a hint.

## Considered Options

1. **Expected-state tokens compared server-side → 409** — ✅ chosen.
2. Last-write-wins (the status quo ante) — ❌ the QA-confirmed lost-update bug; silent
   data loss on money.
3. `version` column + increment-on-write — ❌ same guarantee as comparing `updatedAt`,
   which already exists on every row; a new column and migration for no added safety.
4. Pessimistic row locks (`SELECT … FOR UPDATE` held across user think-time) — ❌ locks
   held across human editing time don't fit serverless request lifecycles.

## Decision Outcome

`ExpenseService.update` compares `existing.updatedAt.toISOString()` against the client's
`expectedUpdatedAt` inside the transaction and throws
`ApiError(409, 'STALE_EXPENSE')` on mismatch
([src/services/expense.service.ts](../../src/services/expense.service.ts)). The fast race
(two saves in the same instant) is additionally caught by mapping the transaction's
Prisma `P2002`/`P2034` to the same 409. `assertExpectedGroup` does the group analogue in
[src/lib/api-helpers.ts](../../src/lib/api-helpers.ts). Single-field flips that need no
form state (e.g. shopping-item purchase toggle) skip tokens entirely and mutate
atomically in SQL (`SET comprado = NOT comprado`) — no read-modify-write to race.

### Consequences

- Good: conflicts surface as a reloadable pt-BR error, never as silent overwrites.
- Good: stable error codes let the client distinguish "stale" from other 409s/500s.
- Bad: the losing editor must reload and re-apply their change by hand (no auto-merge) —
  acceptable at household scale.
- Bad: tokens are opt-in per mutation; a new mutation that forgets one reverts to
  last-write-wins for that path. Mitigated by convention + review.

### Confirmation

- Expense service tests cover the `STALE_EXPENSE` 409 (stale token and same-instant
  race); API-helper tests cover `STALE_GROUP`; the toggle's atomicity lives in the SQL
  statement itself.
