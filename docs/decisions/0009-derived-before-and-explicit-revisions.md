# Activity › Detailed derives `before` on read; writes the audit extension cannot see record an explicit revision

- Status: accepted
- Date: 2026-10-04
- Refines [0005](0005-audit-trail-prisma-extension.md) (not superseded: the extension stays the default writer)

**Decision:** Activity › Detailed derives an UPDATE's `before` on read from the previous revision of the same
entity in the same house (an explicit `before` is never overwritten); every write on an audited entity that the
audit extension cannot see (raw SQL, relation-only changes) writes its own UPDATE revision — a full snapshot,
transactional with the write whenever the write is.

## Context and Problem Statement

[0005](0005-audit-trail-prisma-extension.md) stores only `after` on an UPDATE; a change's `before` is the previous
revision's `after`, and it states that the app code never writes revisions explicitly. Activity › Detailed (R2-09)
now shows "old → new" for every update, so `revisionService.listForGroup` fills the missing `before` on read from
that chain. The feed therefore depends on the chain having no holes — and some writes bypass the extension:

- **Raw SQL** (`$executeRaw`/`$queryRaw` is not a model operation): the atomic purchase toggle
  (`SET "isPurchased" = NOT "isPurchased"`) and the removal of a deleted tag from expenses
  (`SET "categories" = array_remove(...)`).
- **Relation-only changes**: the expense links of a shopping item live in `ShoppingItemExpense`, which Detailed does
  not list, so the item itself never changes.

A hole makes the next edit borrow a stale `after`: delete the tag "Streaming", and the next edit of an expense that
used it reads "Bruno edited an expense · categories ~~Groceries, Streaming~~ → Groceries" although Bruno only
changed the amount. In an audit trail that is a false statement about a person, not a cosmetic glitch.

## Decision Drivers

- The trail must stay truthful: no change may be pinned on whoever happens to edit the entity next.
- Writes stay single round-trip (the 0005 constraint: no pre-read in the extension, no second connection).
- Old rows keep working: revisions written before this decision have no `before` and must still diff.
- Activity is readable by every member: derived data must stay inside the house and stay redacted.

## Considered Options

1. **Derive `before` on read + explicit revisions for the writes the extension cannot see** — ✅ chosen.
2. Store `before` on every write path (the extension pre-reads each row) — ❌ one extra round-trip per write and
   the single-connection deadlock 0005 documents; it still could not see raw SQL, and rows already stored stay
   without a `before`.
3. Leave the gaps (accept phantom diffs on the next edit) — ❌ misattributes changes in the one place meant to
   say who changed what.
4. Postgres triggers for the raw-SQL paths — ❌ same reason 0005 rejected them: the session actor is not visible to
   the database, and audit logic moves out of the codebase.

## Decision Outcome

- **Read side** — `withPreviousState` in [src/services/revision.service.ts](../../src/services/revision.service.ts):
  an UPDATE whose `before` is null takes the `after` of the nearest earlier revision with the same
  `entityType` + `entityId` **and the same `groupId`**; the result goes through the same read-side redaction as any
  snapshot. A revision that carries its own `before` is left as written.
- **Write side** — a write the extension cannot see records `EntityRevision` rows itself (`sanitize` from
  [src/lib/prisma-audit.ts](../../src/lib/prisma-audit.ts), `actorId` from the session, `groupId` from the written row):
  - purchase toggle (`togglePurchased`): exact `before` (only `isPurchased` changed); best-effort after the commit,
    because a failed audit insert must not turn a committed toggle into a 500;
  - expense links (`replaceExpenseLinks`): linked-expense count before → after, **inside the transaction** that
    replaces the links;
  - tag removal (`makeTagService().delete`): one revision per expense that held the tag, **inside the transaction**,
    with an exact `before` (the locking sub-select returns the tag array as it was) and **full snapshots shaped
    like the extension's own** — the same `expenseInclude`/`legacyOmit` exported from
    [src/services/expense.service.ts](../../src/services/expense.service.ts), so `participants` and `payer` are on both
    sides and the split diff never sees an untracked `before`.
- **No-ops write nothing.** Re-picking the active currency (`updateCurrency`) and saving the link set an item already
  has (`replaceExpenseLinks`) return `changed: false`; the route records no activity entry and there is no revision
  to chain.
- **Rule for new code:** raw SQL or a relation-only change on an audited entity writes an explicit UPDATE revision
  in the same transaction, with the same snapshot shape the extension would have stored, and takes the actor from
  the session.

### Consequences

- Good: Detailed shows old → new everywhere, including rows stored before this decision.
- Good: nothing is attributed to the wrong person after a raw-SQL or relation-only write.
- Bad: explicit revisions are hand-written at each site — a forgotten one reopens a hole (covered by the tests
  below, not by construction like the extension).
- Bad: the explicit Expense snapshot shares `expenseInclude` with the extension; a change to one must change both.
- Bad: the toggle's best-effort revision (and the extension's deferred writes) can still be lost, leaving a hole.
- Bad: one extra query per feed page to resolve the previous revisions (bounded by the feed's 300-row clamp).

### Confirmation

[src/services/tenant-isolation.test.ts](../../src/services/tenant-isolation.test.ts) (integration, real pglite):

- derived `before`: "listForGroup fills an UPDATE's missing before from the previous revision…" and "the borrowed
  before stays in the same house and is redacted like any snapshot";
- explicit revisions: "togglePurchased writes an UPDATE revision…", "replaceExpenseLinks records the linked-expense
  count…" (including that the first link revision keeps its own `before.linkedExpenses === 0`), and "delete records an
  explicit UPDATE revision per affected expense…" (full snapshot with participants, no phantom category diff on the
  next edit, other houses untouched);
- no-ops: the two "saving … again/no links … changes nothing" link tests and "updateCurrency: re-picking the active
  currency writes no Group revision…"; the routes' activity gating is covered by
  `src/app/api/shopping-items/[itemId]/expenses/route.test.ts` and `src/app/api/groups/active/currency/route.test.ts`.
