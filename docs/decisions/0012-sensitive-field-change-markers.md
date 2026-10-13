# Sensitive fields: an audit revision records that they changed, never their value

- Status: accepted
- Date: 2026-10-04
- Refines [0005](0005-audit-trail-prisma-extension.md) (not superseded: the extension stays the default writer)

**Decision:** An audited update never stores a sensitive value (password, joinCode); when its payload sets one, the
revision records `<field>Changed: true` instead, so Activity can name the event without the value.

## Context and Problem Statement

The audit extension in [src/lib/prisma-audit.ts](../../src/lib/prisma-audit.ts) drops `SENSITIVE_FIELDS` (`password`,
`joinCode`) from every snapshot — the join code is admin-only, while Activity is readable by every member. A
join-code regeneration is an update whose only change is that field, so its revision came out identical to the
previous one: Activity › Detailed read "updated the house · name Casa QA · currency BRL · No visible field changed"
and the Summary had no entry at all (R3-19). The feed could not say "regenerated the house code" because the one
fact that identifies the event — that the code was set — had been stripped along with the code.

## Decision Drivers

- The join code must never reach a revision payload, an API response or the UI — not even hashed.
- The feed must name the event; "no visible change" on a real, security-relevant action is a false statement.
- Writes stay single round-trip (the 0005 constraint: no pre-read in the extension).
- Revisions already stored must keep working.

## Considered Options

1. **A boolean marker derived from the update's own payload** (`<field>Changed: true`) — ✅ chosen.
2. Store a hash of the code — ❌ a 6-character code is brute-forceable from its hash, so the hash is the secret.
3. The service writes its own revision for regenerations — ❌ a second revision for one write, and the extension
   would still write the misleading one beside it.
4. Infer "nothing visible changed on a Group UPDATE = regeneration" on read — ❌ mislabels legacy same-currency rows
   and any other update whose visible fields did not move.

## Decision Outcome

- **Write side** — `changeMarkers` in [src/lib/prisma-audit.ts](../../src/lib/prisma-audit.ts): an audited `update`
  whose `data` contains a key of `SENSITIVE_FIELDS` writes `after: { …sanitize(row), <field>Changed: true }`. The
  marker is derived from the update's field names: a value is only checked for `undefined` (a key set to `undefined`
  counts as unset), never read into the revision or stored, so the marker costs no extra query. `sanitize` keeps the
  marker because `joinCodeChanged` is not a sensitive key.
- **Summary** — `POST /api/groups/active/regenerate-code` also records an `AuditLog` entry
  `{ entityType: 'GROUP', action: 'UPDATE', summary: '', changes: { joinCodeChanged: true } }` (no code).
- **Read side** — `isJoinCodeRegeneration` (Detailed) and `summaryPhrase` (Summary) in
  [src/lib/activity-format.ts](../../src/lib/activity-format.ts) read the marker; both tabs say "regenerated the house
  code" and Detailed lists no name/currency rows (they would read as the change).

### Consequences

- Good: the event is named in both tabs and the code stays out of every payload, response and screen.
- Good: generic — any future sensitive field gets the same marker without new write-path code.
- Bad: regenerations recorded before this decision keep no marker; they stay as they were (no regeneration of old rows).
- Bad: a `User` password change now writes `passwordChanged: true` (and an account deletion, which nulls the
  password, the same marker). User revisions belong to no house and no feed shows them, so nothing reads it.
- Bad: only a single-row `update`'s own `data` is inspected; a sensitive field set through another operation
  (`upsert`, `updateMany`, raw SQL) carries no marker — `updateMany` logs its `data` through `sanitize`, which strips
  `joinCode`, so the revision names the targeting clause and nothing about the secret. A key set to `undefined`
  (which Prisma ignores) is no change and writes no marker.

### Confirmation

- Update (spec 009 final review): `updateManyAndReturn` now writes one revision per returned row and carries the same
  `changeMarkers` as a single-row `update` (`upsert` already did); a terminal branch logs any write operation the
  extension does not record — [src/lib/prisma-audit.test.ts](../../src/lib/prisma-audit.test.ts).

- [src/services/tenant-isolation.test.ts](../../src/services/tenant-isolation.test.ts) (integration, real pglite): "a
  join-code regeneration records only a joinCodeChanged marker, never the code (R3-19)" — the marker is on the
  regeneration, absent from a currency change, and neither the old nor the new code appears in the feed or in the
  stored rows.
- [src/app/api/groups/active/regenerate-code/route.test.ts](../../src/app/api/groups/active/regenerate-code/route.test.ts):
  the Summary entry carries the marker only; a member is refused and nothing is recorded.
- [src/lib/activity-format.test.ts](../../src/lib/activity-format.test.ts): `summaryPhrase — join-code regeneration`
  and `isJoinCodeRegeneration`.
