# Active house from a cookie preference; DB membership is the authority

- Status: accepted
- Date: 2026-07-11 (backfilled — decision predates this record)

**Decision:** the httpOnly cookie `bolitas_group` is only a *preference*;
`requireActiveGroup()` verifies membership in the DB on every request. **`groupId` never
comes from a request body or header** for data operations — the one endpoint that accepts
it is the membership-checked switch, `POST /api/groups/active`.

## Context and Problem Statement

A user can belong to several houses (groups), but every expense/balance/shopping request
operates on exactly one "active" house. How does the server know which house a request
targets — without letting the client claim access to a house it isn't a member of (IDOR)?

## Decision Drivers

- Authorization must not depend on any client-supplied value being honest.
- Switching houses should be one explicit action, then stick across requests.
- Route handlers should get the resolved house from one helper, not re-derive it.

## Considered Options

1. **Cookie as preference + DB membership as authority** — ✅ chosen.
2. `X-Group-Id` header per call — ❌ client-controlled; every handler must re-check
   membership and one forgotten check is an IDOR. The safe version converges on "DB is
   the authority" anyway, leaving the header as pure attack surface.
3. `groupId` in each request body — ❌ same trust problem, plus it leaks the group
   concept into every payload shape and client form.
4. URL-scoped routes (`/api/groups/:id/expenses`) — ❌ same per-request membership check,
   every link carries the id, and switching houses means rewriting every URL the app
   builds. More moving parts for the same authority model.

## Decision Outcome

`requireActiveGroup()` in [src/lib/api-helpers.ts](../../src/lib/api-helpers.ts) resolves
the cookie and verifies membership — the cookie is a hint, membership is the authority.

Multi-tab divergence (tab A switches house, tab B submits against the old one) is
detected, not trusted: mutations may carry `expectedGroupId`, and a mismatch with the
server-resolved active group returns `409 STALE_GROUP`. The body token detects divergence
but never grants access.

### Consequences

- Good: IDOR-proof by construction — a tampered cookie fails the membership check; there
  is no client-writable group field to tamper with.
- Good: handlers are uniform: `requireSession()` → `requireActiveGroup()` → work.
- Bad: the active house is ambient state — tests/tools must set the cookie via the switch
  endpoint instead of passing an id per call.
- Bad: cross-tab divergence exists at all (inherent to ambient state); handled by the
  `STALE_GROUP` 409.

### Confirmation

- `requireActiveGroup()` + `assertExpectedGroup()` in
  [src/lib/api-helpers.ts](../../src/lib/api-helpers.ts); route tests cover non-member
  access and the 409 path.
