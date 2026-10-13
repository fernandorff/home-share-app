# Recurring expenses — Design

## Approach

A **rule** (`RecurringExpense`) describes a monthly expense: description, amount, day of month, payer,
split (all active members, or a fixed list), and the IANA timezone that defines "today" for it. A
**ledger** (`RecurringExpenseOccurrence`) has one row per (rule, `YYYY-MM` period) that reached its due
date — `POSTED` (linked to the expense it created) or `SKIPPED`. The ledger's unique key is the
idempotency guarantee: posting claims the ledger row first (`INSERT … ON CONFLICT DO NOTHING`), inside the
same transaction that creates the expense, so a second run, a retry or a duplicate cron delivery gets no
row back and creates nothing (ADR [0010](../../decisions/0010-scheduled-jobs-vercel-cron.md)).

Posting is a **reconciliation**, not "what changed since the last run": for each unpaused rule it
computes every eligible period whose due date is ≤ the rule's local today and that has no ledger row
yet, and posts them oldest first (catch-up after missed runs). Eligibility starts at `activeFrom` — the
local date the rule was created or last resumed — so creating or resuming never back-fills a past due
date (POC: "resume comes back on the next due date").

Who triggers posting:

- **Vercel Cron**, once a day: `GET /api/cron/recurring-expenses` at `0 11 * * *` (08:00 in
  America/Sao_Paulo; on Hobby the call lands anywhere in 11:00–11:59 UTC), guarded by
  `Authorization: Bearer $CRON_SECRET`.
- **The rule routes**, synchronously and for that rule only, after create / edit / resume — so a rule
  created on its due day posts today instead of tomorrow. Same function, same idempotency.

Expenses are created through the existing `ExpenseService.create` (new optional `db` transaction
client and `recurringExpenseId`), so integer-cents splits (`splitCents`, ADR
[0003](../../decisions/0003-money-as-integer-cents.md)), the audit extension (ADR
[0005](../../decisions/0005-audit-trail-prisma-extension.md)), balances, insights and Activity work
unchanged. Posted expenses are written as the **system actor**: the posting runs inside
`runWithAuditContext({ system: true, groupId })`, a new flag the audit extension honors by writing
`actorId: null` even when a session cookie is present (the synchronous path runs inside a member's
request). Activity renders that null actor as **"Automatic"** when the entry is a recurring posting.

Patterns kept: thin route handlers (validate → service → respond), framework-agnostic service
(`src/services/recurring-expense.service.ts`), cookie auth + active house from `requireActiveGroup`
(`groupId` never from the body, ADR [0002](../../decisions/0002-active-house-cookie-db-membership-authority.md)),
expected-state token for form edits (ADR [0006](../../decisions/0006-optimistic-concurrency-expected-state-tokens.md)),
English schema and error codes localized by the client (ADR [0007](../../decisions/0007-english-only-codebase-and-database.md)).

### Date rules (pure, isomorphic — `src/lib/recurrence.ts`)

| Helper | Contract |
| --- | --- |
| `isValidTimeZone(tz)` | ≤ 64 chars and accepted by `new Intl.DateTimeFormat('en-US', { timeZone: tz })` |
| `localToday(tz, now)` | `YYYY-MM-DD` of `now` in `tz` (`Intl.DateTimeFormat('en-CA', …)`) |
| `periodOf(date)` / `addMonths(period, n)` | `YYYY-MM` arithmetic, string-sortable |
| `dueOn(period, dayOfMonth)` | `YYYY-MM-DD`, day clamped to the month's last day |
| `eligiblePeriods(rule, today, lastClosedPeriod, max = 12)` | periods `p` from `max(periodOf(activeFrom), lastClosedPeriod + 1)` while `dueOn(p) ≤ today`, keeping those with `dueOn(p) ≥ activeFrom` |
| `upcomingPeriods(rule, today, lastClosedPeriod, n = 3)` | the next `n` periods with `dueOn ≥ today` and no ledger row, each `{ period, dueOn, skipped }`; `[]` while paused |

The browser uses the same helpers for the form preview ("First posting: …") with
`Intl.DateTimeFormat().resolvedOptions().timeZone` (fallback `UTC`). The posted expense's `date` is
``new Date(`${dueOn}T12:00:00`)`` — the same server-side noon convention `validateExpenseInput` uses.

Editing a rule previews its **next** posting ("Next posting: …") in the rule's stored `timezone` — the zone
that decides the rule's "today" on the server — not the browser's: criterion 22's browser zone applies to
a new rule, which has no zone yet (`timezone` is set once, on create). A paused rule's edit (by a member or
`MEMBER_LEFT`) shows "paused · nothing will be posted" instead of a date: it posts nothing until resumed.

### Posting algorithm (`recurringExpenseService.postDue(now, { recurringExpenseId?, deadline? })`)

1. Load the unpaused rules (one rule when called from a route) and, in one grouped query, each rule's
   highest ledger `period` (`lastClosed`). Per rule: `today = localToday(rule.timezone, now)`;
   `candidates = eligiblePeriods(rule, today, lastClosed, 12)`. A rule with no candidate costs no further
   query; a rule whose dates cannot be computed counts as `failed`.
2. The rules with candidates go **oldest due date first** (ties by `id`), until `deadline` (cron:
   30 s into a `maxDuration = 60` function; checked before each rule and before each further month of a started
   rule, so only the month in flight — 10 s connection wait + 15 s transaction — can run past it; a degraded
   database can still overrun, and then Vercel kills the run, the transaction rolls back and the next run retries): the rules a deadline leaves behind are the newest due, and they
   lead the next run, so the same rules never starve. For each candidate `period` (ascending):
   - **Skipped** (`period ∈ rule.skippedPeriods`): in a transaction like a posting's (same bounds), claim a
     `SKIPPED` ledger row, then re-read the rule — its `updatedAt` changed since the run loaded it (an Undo
     skip, a pause, an edit) or the period is no longer skipped → abort: the claim rolls back, this rule
     stops for this run, and the next run reads it again (and posts the month after an Undo skip). Continue.
   - **Members**: read the house's members (outside the transaction — the test pool has one
     connection). If the payer is inactive, or (`SELECTED`) any participant is inactive → update the
     rule `pausedAt = now`, `pauseReason = MEMBER_LEFT` (system actor) and stop this rule.
   - **Post** in `prisma.$transaction(async (tx) => …, { maxWait: 10_000, timeout: 15_000 })` under
     `runWithAuditContext({ system: true, groupId })`:
     1. the claim: `tx.recurringExpenseOccurrence.createManyAndReturn({ data: [POSTED row, expenseId null],
        skipDuplicates: true })` — `INSERT … ON CONFLICT DO NOTHING` on the unique (rule, period): a
        concurrent or repeated run waits for an uncommitted claim, then gets no row back and writes nothing
        (no failing statement inside the transaction, so nothing to roll back);
     2. re-read the rule through `tx`: its `updatedAt` changed after the run loaded it (any pause, skip,
        Undo skip or edit) → abort: the claim rolls back, this rule stops, and the next run posts with the
        rule as it is then;
     3. `expenseService.create(groupId, memberIds, input, { db: tx, recurringExpenseId: rule.id })` with
        `splitEqually: true` over `memberIds` = all active members (`ALL`) or `participantIds`
        (`SELECTED`);
     4. `tx.recurringExpenseOccurrence.update({ expenseId })`.
   - No claim row → counted as `duplicates`, no error. Abort → stop this rule (no count). A `P2002` thrown
     anyway is a fallback: on the ledger key it is a duplicate; any other unique violation, or a `P2003`
     (the rule was deleted mid-run), stops the rule with the month still open. Anything else → `failed`
     (logged, rolled back, retried by the next run); the other rules continue.
   - After commit: `recordActivity({ actorId: null, entityType: 'EXPENSE', action: 'CREATE',
     summary: description, changes: { amount, recurring: true, period } })`.
3. Return `{ posted, skipped, paused, duplicates, failed, remaining }` (`remaining` = due rules not reached
   before the deadline; they are caught up by the next run, dated correctly).

**Transaction bounds** — `{ maxWait: 10_000, timeout: 15_000 }` instead of Prisma's 2 s / 5 s: the first
query of a run can wake a suspended Neon compute, and a rollback at 5 s would push that posting to the
next day. A function killed at `maxDuration` never commits half a posting (the open transaction rolls back).
The audit extension writes revisions after the operation returns (`after()`, ADR
[0005](../../decisions/0005-audit-trail-prisma-extension.md)), not inside the transaction: a posting that
rolls back after its expense insert (a timeout, a failed link update) can still leave that expense's
`CREATE` revision, for an expense that does not exist. Accepted — the same best-effort trade-off as every
audited write (ADR 0005); the larger timeout makes it rarer.

## Data model

Additive only (new enums, two new tables, one nullable column and its index, back-relations) — safe for
`prisma db push` without `--accept-data-loss`.

```prisma
enum RecurringSplitMode {
  ALL      // every active member at posting time
  SELECTED // exactly participantIds; all must still be active
}

enum RecurringPauseReason {
  MANUAL      // paused by a member
  MEMBER_LEFT // auto-paused: the payer or a selected participant left the house
}

enum RecurringOccurrenceStatus {
  POSTED
  SKIPPED
}

// A monthly rule that posts an expense by itself (spec 008). Audited by the extension like any model.
model RecurringExpense {
  id             Int                   @id @default(autoincrement())
  publicId       String                @unique @db.Uuid
  groupId        Int
  createdById    Int?
  payerId        Int
  description    String
  amount         Decimal               @db.Decimal(10, 2)
  // 1–31; clamped to the month's last day (31 → 30 Apr, 28/29 Feb). Weekends don't move it.
  dayOfMonth     Int
  splitMode      RecurringSplitMode    @default(ALL)
  // SELECTED only (empty for ALL). No FK: users are never hard-deleted (BL-23); re-validated at posting.
  participantIds Int[]                 @default([])
  // IANA zone ("America/Sao_Paulo") that defines the rule's "today"; captured from the creator's browser.
  timezone       String
  // First local date eligible to post: creation date, reset on every resume (no back-fill).
  activeFrom     DateTime              @db.Date
  pausedAt       DateTime?
  pauseReason    RecurringPauseReason?
  // "YYYY-MM" periods the house chose not to post; an UPDATE of this row, so audited by construction.
  skippedPeriods String[]              @default([])
  createdAt      DateTime              @default(now())
  updatedAt      DateTime              @updatedAt

  group       Group                        @relation(fields: [groupId], references: [id], onDelete: Cascade)
  payer       User                         @relation("RecurringExpensePayer", fields: [payerId], references: [id], onDelete: Cascade)
  createdBy   User?                        @relation("RecurringExpenseCreatedBy", fields: [createdById], references: [id], onDelete: SetNull)
  occurrences RecurringExpenseOccurrence[]
  expenses    Expense[]

  @@index([groupId])
}

// Idempotency ledger: one row per (rule, period) that reached its due date. Bookkeeping written by the
// system — excluded from the audit extension (SKIP_MODELS); the audited effect is the Expense CREATE.
model RecurringExpenseOccurrence {
  id                 Int                       @id @default(autoincrement())
  recurringExpenseId Int
  period             String // "YYYY-MM"
  dueOn              DateTime                  @db.Date
  status             RecurringOccurrenceStatus
  // Null for SKIPPED, and after the posted expense is deleted (the period stays closed: never re-posted).
  expenseId          Int?                      @unique
  createdAt          DateTime                  @default(now())

  recurringExpense RecurringExpense @relation(fields: [recurringExpenseId], references: [id], onDelete: Cascade)
  expense          Expense?         @relation(fields: [expenseId], references: [id], onDelete: SetNull)

  @@unique([recurringExpenseId, period])
}
```

Existing models (additions only):

```prisma
model Expense {
  // …existing fields…
  // Set only by the recurring poster (never from a request body); null after the rule is deleted.
  recurringExpenseId  Int?
  recurringExpense    RecurringExpense?           @relation(fields: [recurringExpenseId], references: [id], onDelete: SetNull)
  recurringOccurrence RecurringExpenseOccurrence?

  // Deleting a rule nulls its posted expenses (onDelete SetNull): without it, a scan of every expense.
  @@index([recurringExpenseId])
}

model User {
  // …existing relations…
  recurringExpensesPaid    RecurringExpense[] @relation("RecurringExpensePayer")
  recurringExpensesCreated RecurringExpense[] @relation("RecurringExpenseCreatedBy")
}

model Group {
  // …existing relations…
  recurringExpenses RecurringExpense[]
}
```

The new `Expense.recurringExpenseId` scalar appears in the extension's Expense snapshots and in the
explicit tag-removal revisions (ADR [0009](../../decisions/0009-derived-before-and-explicit-revisions.md))
with no code change, since both read every scalar column. The app never changes it after creation, so it
never shows up as a diff; the one change is deleting the rule, where Postgres sets it to null
(`onDelete: SetNull`) below the extension, so no revision records it — the expense itself stays
(criterion 18). Keep it out of the audited Expense field lists so a stale snapshot never reads as an edit.

## API contract

All routes: `requireActiveGroup()`; lookups by `(publicId, groupId)`; `payerId`/`participantIds` are
internal user ids (as in `POST /api/expenses`) validated with `allActiveGroupMembers`; mutations with a
body accept `expectedGroupId` (`409 STALE_GROUP`). Money is a string in responses (Decimal).

**DTOs** (`src/lib/types.ts`)

```ts
interface RecurringExpense {
  publicId: string
  description: string
  amount: string                    // "1800.00"
  dayOfMonth: number                // 1–31
  payerId: number
  splitMode: 'ALL' | 'SELECTED'
  participantIds: number[]          // SELECTED only
  timezone: string
  activeFrom: string                // YYYY-MM-DD
  paused: boolean
  pauseReason: 'MANUAL' | 'MEMBER_LEFT' | null
  skippedPeriods: string[]          // only periods without a ledger row
  lastClosedPeriod: string | null   // highest ledger period
  upcoming: { period: string; dueOn: string; skipped: boolean }[] // next 3; [] while paused
  canManage: boolean                // viewer is the payer or an admin
  updatedAt: string                 // ISO — the expectedUpdatedAt token
}
interface RecurringHistoryItem {
  period: string
  dueOn: string
  status: 'POSTED' | 'SKIPPED'
  rule: { publicId: string; description: string }
  expense: { publicId: string; amount: string; payerId: number; participantCount: number } | null // null: skipped or deleted
}
```

| Method & path | Body | Success | Errors |
| --- | --- | --- | --- |
| `GET /api/recurring-expenses` | — | `200 { rules, summary: { monthlyTotal, myMonthlyShare, activeCount, pausedCount }, history }` (history: 50 newest ledger rows of the house) | 401, 403 `NO_GROUP` |
| `POST /api/recurring-expenses` | `{ description, amount, dayOfMonth, payerId, splitMode, participantIds?, timezone, expectedGroupId? }` | `201 { rule, postedNow }` (`postedNow` = periods posted synchronously, 0 or 1) | 400 (criterion 2 codes), 409 `RECURRING_LIMIT_REACHED`, 409 `STALE_GROUP` |
| `PATCH /api/recurring-expenses/{publicId}` | either `{ paused: boolean }` alone, or any of `{ description, amount, dayOfMonth, payerId, splitMode, participantIds }` + `expectedUpdatedAt` (required) | `200 { rule, postedNow }` | 400 codes, 400 `RECURRING_PATCH_INVALID` (`paused` mixed with fields, or nothing to change), 403 `NOT_RECURRING_OWNER`, 404 `RECURRING_NOT_FOUND`, 409 `STALE_RECURRING_EXPENSE` |
| `DELETE /api/recurring-expenses/{publicId}` | — | `200 { ok: true }` | 403, 404 |
| `PUT /api/recurring-expenses/{publicId}/skips/{period}` | — | `200 { rule }` (idempotent) | 400 `RECURRING_PERIOD_INVALID`, 403, 404, 409 `RECURRING_PERIOD_CLOSED` |
| `DELETE /api/recurring-expenses/{publicId}/skips/{period}` | — | `200 { rule }` (idempotent) | same |
| `GET /api/cron/recurring-expenses` | header `Authorization: Bearer $CRON_SECRET` | `200 { ok: true, posted, skipped, paused, duplicates, failed, remaining }` | 401 `CRON_UNAUTHORIZED` |

Rules for the mutation routes:

- Ownership (criteria 14–17): `rule.payerId === session.userId || role === 'ADMIN'`, checked in the
  service after the house-scoped lookup (so another house's rule is a 404, never a 403).
- `timezone` is accepted only on create (out of scope to change it).
- Pause stores `pauseReason = MANUAL`; resume clears `pausedAt`/`pauseReason`, sets
  `activeFrom = localToday(rule.timezone, now)` and drops the `skippedPeriods` before
  `periodOf(activeFrom)` (those months can never post again; kept, they would linger in the DTO and in
  every later revision).
- After create, a field edit or a resume, the route calls `postDue(now, { recurringExpenseId })`
  before responding.
- Activity Summary (criterion 24) via `recordActivity` in the routes: `entityType: 'RECURRING_EXPENSE'`,
  `action: 'CREATE' | 'UPDATE' | 'DELETE' | 'PAUSE' | 'RESUME' | 'SKIP' | 'UNSKIP'`,
  `summary: description`, `changes`: `{ amount }` (create), changed fields before/after (update),
  `{ period }` (skip/unskip). No-ops (same pause state, period already skipped/unskipped) record nothing.
- `POST /api/expenses` is unchanged: `validateExpenseInput` never returns `recurringExpenseId` and
  `create` only reads the validated input, so a client cannot mark an expense as recurring
  (criterion 20, covered by a regression test).

Cron route: `export const dynamic = 'force-dynamic'`, `export const maxDuration = 60`; `requireCron`
(`src/lib/cron.ts`) compares the header with `crypto.timingSafeEqual` on equal-length buffers; an unset
`CRON_SECRET` is a 401 plus one `logger.warn` (fail closed). The middleware gets `/api/cron` in
`PUBLIC_API_PREFIXES` (a cron invocation has no cookie, and Vercel does not follow the login redirect).
`vercel.json` gains:

```json
"crons": [{ "path": "/api/cron/recurring-expenses", "schedule": "0 11 * * *" }]
```

## UI

- **Navigation** — `src/components/app/navigation.tsx`: new entry `{ href: "/recurring", key: "recurring",
  Icon: RepeatIcon }` right after Expenses (sidebar and mobile drawer read the same list).
- **Page** — `src/app/(app)/recurring/page.tsx`: header ("Recurring" + subtitle); summary card (monthly
  total of active rules, "N active · M paused", "Your share: X per month"); full-width "+ New rule"
  button; segmented tabs Rules / Upcoming (count, max 6) / Posted. Skeletons while loading, `reveal`
  entrance animations behind `prefers-reduced-motion`, 44 px targets, mobile-first like the POC.
- **Rule card** — `src/components/recurring/RecurringRuleCard.tsx`: description + "↻ monthly" tag,
  "on day N of every month · paid by X", amount (`Money`), participant dots + "÷ n · R$ x each", status line (paused
  / paused because a member left / "month skipped, back in {month}" / "next posting: {date}"), actions
  "Skip {month}" ↔ "Undo skip" and "Pause" ↔ "Resume"; a ⋯ `Menu` with Edit / Delete only when
  `canManage` (skip/pause buttons are also hidden without `canManage`). While a `MEMBER_LEFT` rule still
  names an inactive payer/selected participant (`ruleStatus(rule, activeIds)`), Edit replaces Resume
  (resume could only fail); once an edit has replaced them it reads as a plain pause and Resume returns.
  Card actions are `aria-describedby` the rule's name. Delete asks for confirmation ("Expenses already
  posted stay; nothing new will be posted.").
- **Form** — `src/components/recurring/RecurringExpenseFormModal.tsx` (create and edit, `Modal`):
  description (`LIMITS.DESCRIPTION`), amount (same money input as `ExpenseFormModal`), day stepper
  1–31 with hint (day > 28: last-day clamp; otherwise "weekends don't move the date"), payer select
  (active members), split segmented control "Equal for everyone" / "Choose people" (checkbox list),
  live preview "R$ X ÷ n = R$ Y per person · First posting: {date}, then on day {N} of every month" (helpers from
  `src/lib/recurrence.ts` + `splitCents`; edit says "Next posting", a paused rule "paused · nothing will
  be posted"). Bodies come from the pure `buildRuleBody` (edit sends `expectedUpdatedAt`, never `paused`
  or `timezone`); a 409 shows the stale message with "Load latest", which takes focus. Closing a dirty
  form (`ruleFormDirty`) asks first, with the expense form's discard dialog.
- **Upcoming / Posted** — rendered inside the page: Upcoming flattens `rules[].upcoming` (sorted by
  `dueOn`, max 6) with Skip/Undo; Posted lists `history` (posted rows with the ↻ tag; skipped rows with
  a "skipped" stamp and "nothing posted"; deleted expense: "expense deleted").
- **Expense marker** — `src/app/(app)/expenses/page.tsx` (list row: a "↻" glyph with
  `title`/`aria-label` "Recurring") and `src/components/expenses/ExpenseDetailModal.tsx` (line "Created
  automatically by a recurring rule").
- **Activity** — `src/app/(app)/activity/page.tsx`: null actor + recurring marker
  (`changes.recurring === true` in Summary, `after.recurringExpenseId != null` on an `Expense` CREATE in
  Detailed, plus the auto-pause revision — `RecurringExpense` UPDATE with `after.pauseReason` MEMBER_LEFT —
  the only actor-less rule write) renders "Automatic" (avatar "↻") through a small pure helper
  `actorLabelKey(entry)` in `src/lib/activity-format.ts`; any other actor-less entry stays "Someone"; skipped
  months render as "November 2026" (`periodListLabel`); new `act.*` keys; `RecurringExpense` added to `REVISION_ENTITY_TYPES`
  (`src/lib/constants.ts`) and to the Detailed snapshot field preset (`description`, `amount`,
  `dayOfMonth`, `payerId`, `splitMode`, `participantIds`, `pausedAt`, `pauseReason`, `skippedPeriods`).

### i18n keys (en/pt/es/fr)

`Nav.recurring` "Recurring".

`Recurring.*`: `title` "Recurring", `subtitle` "Rent, internet, condo: posted by themselves every
month", `monthlyTotal` "Fixed per month", `counts` "{active, plural, =0 {no active rules} one {# active rule}
other {# active rules}}{paused, plural, =0 {} one { · # paused} other { · # paused}}", `yourShare` "Your
share: <b>{amount}</b> per month", `newRule` "+ New rule", `tabs.rules` "Rules", `tabs.upcoming` "Upcoming",
`tabs.posted` "Posted", `monthlyTag` "monthly", `everyDay` "on day {day} of every month · paid by {name}",
`perPerson` "÷ {count} · {amount} each", `paused` "paused", `pausedNothing` "nothing will be posted",
`pausedMemberLeft` "Paused: a member of this rule left the house. Edit it, then resume.", `monthSkipped`
"month skipped", `backIn` "back in {month}", `nextPosting` "next posting: {date}", `skipMonth` "Skip
{month}", `undoSkip` "Undo skip", `pause` "Pause", `resume` "Resume", `edit` "Edit", `delete` "Delete",
`actionsFor` "Actions for {name}", `deleteTitle` "Delete this rule?", `deleteBody` "Expenses already
posted stay; nothing new will be posted.", `form.createTitle` "New recurring expense",
`form.editTitle` "Edit recurring expense", `form.description` "Description", `form.descriptionHint`
"e.g. Rent", `form.amount` "Amount", `form.day` "Day of month", `form.dayDecrease` "Previous day",
`form.dayIncrease` "Next day", `form.dayHintClamp` "In months without day {day}, it posts on the last
day of the month.", `form.dayHintWeekend` "Weekends don't move the date.", `form.payer` "Who pays",
`form.split` "Split", `form.splitAll` "Equal for everyone", `form.splitPick` "Choose people",
`form.preview` "{amount} ÷ {count} = {share} per person", `form.firstPosting` "First posting: {date},
then on day {day} of every month.", `form.previewEmpty` "Enter an amount and people to see the split.",
`form.create` "Create rule", `form.save` "Save", `form.cancel` "Cancel", `upcoming.auto` "posted
automatically · ÷ {count}", `upcoming.skipped` "skipped", `upcoming.empty` "No active rules. Resume or
create one.", `posted.recurringTag` "recurring", `posted.skippedNothing` "month skipped, nothing
posted", `posted.expenseDeleted` "expense deleted", `posted.empty` "Nothing posted yet.",
`empty` "No recurring expenses yet", `emptyHint` "Create a rule for rent, internet or any fixed bill.",
`toast.created` "Rule created: {name}, on day {day} of every month. Next posting on {date}.",
`toast.createdPostedToday` "Rule created and today's {name} was posted.", `toast.saved` "Rule saved.",
`toast.paused` "{name} paused: nothing will be posted until you resume.", `toast.resumed` "{name}
resumed: back on the next due date.", `toast.skipped` "{name} skipped in {month}. Other rules continue
as usual.", `toast.unskipped` "Skip undone: {name} will be posted on {date}.", `toast.deleted` "Rule
deleted.", `you` "You", `everyDayYou` "on day {day} of every month · paid by you" (the viewer as payer — "You" inside
`everyDay` read "paid by You"), `form.nextPosting` "Next posting: {date}, then on day {day} of every month."
(edit preview). The day of month never reads as "daily" ("every day 5"): es says "el día {day} de cada
mes"; pt keeps the idiomatic "todo dia {day}"; fr writes it as `{day, plural, =1 {1er} other {#}}` ("le 1er
de chaque mois").

`Expenses.recurringBadge` "Recurring", `Expenses.recurringDetail` "Created automatically by a recurring
rule".

`Activity.automatic` "Automatic"; `Activity.act.CREATE_RECURRING_EXPENSE` "created a recurring
expense", `UPDATE_RECURRING_EXPENSE` "edited a recurring expense", `DELETE_RECURRING_EXPENSE` "deleted a
recurring expense", `PAUSE_RECURRING_EXPENSE` "paused a recurring expense", `RESUME_RECURRING_EXPENSE`
"resumed a recurring expense", `SKIP_RECURRING_EXPENSE` "skipped a month of a recurring expense",
`UNSKIP_RECURRING_EXPENSE` "undid the skip of a recurring expense"; `Activity.entity.RecurringExpense`
"Recurring expense"; `Activity.entityArticle.RecurringExpense` "a recurring expense";
`Activity.field.dayOfMonth` "day of month", `splitMode` "split", `participantIds` "people",
`pausedAt` "paused at", `pauseReason` "pause reason", `skippedPeriods` "skipped months";
`Activity.splitModeValue.ALL` "Everyone", `SELECTED` "Selected people";
`Activity.pauseReasonValue.MANUAL` "Paused by a member", `MEMBER_LEFT` "A member left".

`ApiErrors.*`: `RECURRING_NOT_FOUND`, `RECURRING_DAY_INVALID`, `RECURRING_SPLIT_INVALID`,
`RECURRING_TIMEZONE_INVALID`, `RECURRING_MEMBER_INACTIVE`, `RECURRING_LIMIT_REACHED`,
`RECURRING_PERIOD_INVALID`, `RECURRING_PERIOD_CLOSED`, `RECURRING_PATCH_INVALID`,
`STALE_RECURRING_EXPENSE`, `NOT_RECURRING_OWNER`, plus the two codes `validateExpenseInput` already
returns but no locale translates today: `AMOUNT_PRECISION`, `DESCRIPTION_INVALID`.

## Error handling & edge cases

- **Duplicate / concurrent runs**: the ledger claim (`createManyAndReturn({ skipDuplicates: true })`,
  `ON CONFLICT DO NOTHING`) is the first write of the posting transaction; the loser waits for the winner's
  claim, gets no row back and writes nothing (no expense). Counted as `duplicates`, never a 500. A `P2002`
  is mapped to `duplicates` only when it is on the ledger key (fallback).
- **Missed runs** (Vercel delivery is best effort, no retries): the next run posts every missed
  eligible period, each dated on its own due date. Capped at 12 per rule per run.
- **Pause/skip racing a run** (same second): the posting transaction re-reads the rule after the claim
  and aborts if its `updatedAt` changed since the run loaded it (pause, skip, Undo skip, edit); the next
  run retries with the current rule. The SKIPPED write does the same, so an Undo skip made during a run
  is honored. A change committed after the re-read and before the commit can still post — the expense is
  a normal expense and can be deleted (the period then stays closed).
- **Deleted posted expense**: `expenseId` → null (FK `SetNull`), the POSTED row stays, never re-posted.
- **Member leaves**: `ALL` simply uses the active members at posting time. If the payer or a `SELECTED`
  participant left, the rule auto-pauses (`MEMBER_LEFT`) at posting time and the card says so; resuming
  requires editing the payer/participants (resume re-validates, `RECURRING_MEMBER_INACTIVE`).
- **Day edited after a period is due**: periods are keyed by month, so an edit never double-posts a
  month. Moving the day earlier than today in a month not yet posted posts that month immediately
  (the synchronous run after the edit) when the new due date is on or after `activeFrom`. Moving it
  before `activeFrom` (the creation or last resume date) in that same month skips the month:
  `eligiblePeriods` keeps only due dates `≥ activeFrom` (`src/lib/recurrence.ts`), so nothing is posted
  for it and the next posting is next month. The edit preview ("Next posting: …") computes the same
  thing and shows that next-month date.
- **Day 29–31**: clamped per month (`dueOn`), so February posts on the 28th/29th and resumes on the
  31st in March.
- **Timezone near midnight**: "today" comes from `localToday(rule.timezone, now)`; a run at 02:30 UTC
  still sees the previous day for an America/Sao_Paulo rule.
- **Rule edits never touch posted expenses** (they are independent `Expense` rows); editing a posted
  expense never touches the rule.
- **Deadline**: due rules not reached before 30 s are counted in `remaining` and processed by the next
  run, ahead of the rules that fall due later (oldest due date first).
- **Skip validation**: only the next 3 upcoming periods; a period already in the ledger → 409
  `RECURRING_PERIOD_CLOSED`; malformed period (`!/^\d{4}-(0[1-9]|1[0-2])$/`) → 400.

## Security & tenant isolation

- Every rule route resolves the house with `requireActiveGroup()` and looks rules up by
  `(publicId, groupId)`; another house's rule is indistinguishable from a missing one (404).
- `payerId`/`participantIds` must be active members of the active house; at posting time the poster
  reads members of the rule's own `groupId` only, so a rule can never post into, or split with, another
  house.
- Money-moving actions (edit, pause/resume, skip, delete) are limited to the payer or an admin, like
  expense edit/delete.
- The cron route is the only cookie-less entry: bearer secret, constant-time comparison, fail-closed
  when unset; the response carries only counts (no ids, names or amounts); log lines carry counts.
- Abuse bounds: 50 rules per house, 12 periods per rule per run, 30 s deadline. The 50-rule cap is a
  soft bound: `create` counts, then inserts, so two simultaneous creates at 49 can end at 51 —
  acceptable for a per-house cap (no lock for it).
- Audit: rule writes are audited by the extension (create/update/delete, including `skippedPeriods`
  and pause fields); the ledger is in `SKIP_MODELS` (system bookkeeping); posted expenses are audited
  with `actorId: null`. `recurringExpenseId` cannot be set from a request body.

## Testing strategy

TDD per task (test first, see tasks.md). Integration tests use the existing pglite harness (single
connection — the posting code must use `tx` inside the transaction and read members before it). Only
`src/services/tenant-isolation.test.ts` may open the shared pglite database — a second pglite file races
it — so every "real pglite" case below lives there (`describe` blocks "system actor for scheduled
writes" and "recurring expenses"); the other files named below are unit tests with Prisma mocked.

- **Unit** — `src/lib/recurrence.test.ts`: `localToday` for America/Sao_Paulo, Asia/Tokyo and
  Pacific/Honolulu around 00:00/03:00 UTC; `dueOn` clamps (31 → Apr 30, Feb 28 2027, Feb 29 2028);
  `eligiblePeriods` with `activeFrom` mid-month, `lastClosedPeriod`, the 12 cap and a paused-then-resumed
  rule; `upcomingPeriods` with skips and ledger rows; `isValidTimeZone`. `src/lib/cron.test.ts`: unset
  secret, missing header, wrong scheme, wrong value, different length, correct value.
  `src/lib/activity-format.test.ts`: `actorLabelKey` (recurring → automatic; other null → system).
- **Integration** — `src/services/tenant-isolation.test.ts` (real pglite; unit cases with Prisma
  mocked in `src/services/recurring-expense.service.test.ts`): create + every
  validation code + limit 50; list summary (`myMonthlyShare` for 100.00 ÷ 3 = 33.34/33.33/33.33);
  `postDue` posts once and a second call is a no-op; a pre-inserted ledger row (simulated duplicate
  delivery) yields no expense; catch-up of 3 missed months; deleted expense not re-posted; skipped
  period → SKIPPED row and no expense; paused → nothing; resume does not back-fill; payer left →
  `MEMBER_LEFT` pause; SELECTED participant left → pause; shares sum exactly to the amount; the
  Expense revision has `actorId` null even inside a session context, and the AuditLog entry has
  `changes.recurring`; edit does not touch posted expenses; delete keeps expenses with
  `recurringExpenseId` null; tenant isolation (house B cannot list, edit, skip, pause or delete house A's
  rule; posting uses house A's members only); an edit or an Undo skip made after the run loaded the rule
  aborts that posting / SKIPPED write and the next run posts; resume drops the skipped months before
  `activeFrom`. Unit: the cron run makes one ledger query for all rules and none per rule when nothing is
  due, goes oldest due date first, and a deadline never starves the same rules; both transactions carry
  the 15 s / 10 s bounds. `src/services/expense.service.test.ts`: `create` with
  `{ db, recurringExpenseId }`.
- **Routes** — `src/app/api/recurring-expenses/**/route.test.ts`: status codes and error codes of
  criteria 1–4 and 14–18 (service mocked where the service tests already cover behavior);
  `src/app/api/cron/recurring-expenses/route.test.ts`: 401 cases and the 200 summary;
  `src/app/api/expenses/route.test.ts`: a body with `recurringExpenseId` creates an expense with it
  null; `src/middleware.test.ts`: `/api/cron/recurring-expenses` passes without a cookie.
- **i18n** — `src/lib/i18n-parity.test.ts` (new, reusable): the `Recurring` namespace and the new
  `Nav`/`Expenses`/`Activity`/`ApiErrors` keys exist with the same key set in en/pt/es/fr.
- **Live (QA, never production data)** — QA Docker DB `homeshare-qa-pg` (127.0.0.1:55432): rebuild its
  schema offline (`prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script`) and
  reseed (`reset-qa.sh`); add a QA-only `CRON_SECRET` to the QA launcher env; restart `homeshare-qa`
  (the Prisma client lives on `globalThis`). Create a rule due today → posted at once with the ↻ marker
  and "Automatic" in Activity; `curl -H "Authorization: Bearer <qa-secret>"
  http://127.0.0.1:3100/api/cron/recurring-expenses` twice → `posted: 0`, one expense; without the
  header → 401. Never `npm run build` / `prisma db push` locally (`.env*` point at production).

## Owner actions

1. **`CRON_SECRET`** — generate a random value of at least 16 characters (e.g. `openssl rand -hex 32`
   or a password manager) and add it in Vercel › Project › Settings › Environment Variables for
   **Production** (mark it Sensitive). Preview is optional: Vercel only runs crons on Production
   deployments. Redeploy afterwards.
2. **Schema** — apply the additive schema (3 enums, `RecurringExpense`, `RecurringExpenseOccurrence`,
   nullable `Expense.recurringExpenseId` and its index) to the production Neon database with the
   deliberate step README › Deploy describes (`prisma db push`, no `--accept-data-loss`; `vercel.json`'s
   build command is `prisma generate && next build`, it does not push) **before** this code reaches
   Production. Run it yourself from a trusted machine — agents never touch the production database.
   First preview the diff (`prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma
   --script`); expected SQL, and nothing else: 3 `CREATE TYPE`; `ALTER TABLE "Expense" ADD COLUMN
   "recurringExpenseId" INTEGER`; `CREATE TABLE "RecurringExpense"` and `"RecurringExpenseOccurrence"`;
   5 `CREATE [UNIQUE] INDEX` (`RecurringExpense_publicId_key`, `RecurringExpense_groupId_idx`,
   `RecurringExpenseOccurrence_expenseId_key`, `RecurringExpenseOccurrence_recurringExpenseId_period_key`,
   `Expense_recurringExpenseId_idx`); 6 `ADD CONSTRAINT … FOREIGN KEY`. Any `DROP`, `RENAME` or
   `ALTER COLUMN` → stop (production drifted).
3. **Cron job** — nothing to configure by hand: the `crons` entry in `vercel.json` creates the job on
   the next production deploy. Check Vercel › Settings › Cron Jobs lists
   `/api/cron/recurring-expenses` (`0 11 * * *`), press **Run** once and confirm the log line shows
   `posted`/`duplicates` counts. On Hobby it fires once a day anywhere between 11:00 and 11:59 UTC
   (08:00–08:59 in Brasília); on Pro, at 11:00.
4. **Optional** — a Sentry alert on errors whose `route` tag is `/api/cron/recurring-expenses`.

## Alternatives considered

Each line: the chosen option first, then what was rejected and why.

- **Scheduler** — Vercel Cron daily, secret-guarded (ADR 0010). Rejected: GitHub Actions schedule
  (delays/drops under load, auto-disabled after 60 days of inactivity, secret in a second system);
  lazy posting on page load (writes in GETs; a house nobody opens never posts, then posts weeks at
  once); external scheduler/queue (new vendor for one daily call); Neon `pg_cron` (bypasses
  `ExpenseService`, splits and the audit actor).
- **Idempotency** — ledger with `@@unique([recurringExpenseId, period])`, claimed first inside the
  posting transaction. Rejected: unique key on `Expense` (a deleted expense would be re-posted; skips
  would need another store); a `lastRunAt` watermark (check-then-write races on duplicate delivery);
  an advisory lock alone (prevents overlap, not a re-run after commit).
- **Actor of posted expenses** — system (`actorId` null, shown as "Automatic") via
  `runWithAuditContext({ system: true })`. Rejected: the rule's creator (pins a monthly write on someone
  who did nothing that day, and who may have left or deleted the account — ADR 0009's "never pin a
  change on the wrong person"); the payer (same problem, and the payer may not have created the rule).
- **"Today"** — IANA timezone stored on the rule, captured from the creator's browser. Rejected: UTC
  dates (a synchronous post after 21:00 in Brasília already falls on the next UTC day, and catch-up runs
  would date by UTC); server local time (UTC on Vercel, local in dev — behavior would differ by
  environment); a house-level timezone (needs a settings screen and a default for every existing house;
  revisit if more scheduled features need it).
- **Catch-up** — post every missed eligible period on the next run, eligibility starting at
  create/resume. Rejected: only the current period (a missed run silently drops a month's rent);
  unbounded catch-up (a bug could flood a house — capped at 12).
- **Synchronous posting on create/edit/resume** — yes, same idempotent function. Rejected: cron-only
  (a rule created on its due day shows nothing until the next morning).
- **Skips** — `skippedPeriods` on the audited rule + a SKIPPED ledger row at due time. Rejected:
  SKIPPED ledger rows written in advance (a relation-only change that would need hand-written
  revisions under ADR 0009; the array is audited by construction).
- **Split** — `ALL` = active members at posting time; `SELECTED` = a fixed list that auto-pauses when
  someone leaves. Rejected: `SELECTED` silently dropping leavers (raises everyone else's share without
  anyone deciding); custom per-person amounts (not in the POC — v2).
- **Participants storage** — `Int[]` on the rule. Rejected: a join table (one more audited model and
  revision noise per change; users are never hard-deleted, and posting re-validates membership anyway).
- **Delete** — hard delete of rule + ledger; posted expenses kept (`SetNull`). Rejected: soft delete
  (`deletedAt` filters everywhere for a "deleted rules" view nobody asked for).
- **Permissions** — payer or admin, mirroring expense edit/delete. Rejected: any member (money-critical);
  creator-only (expenses do not track creators; inconsistent).
- **Marker on the expense** — nullable `Expense.recurringExpenseId`. Rejected: a reverse include through
  the ledger in the hot list query; a boolean flag (loses the link to the rule).
- **Weekends** — never move the due date (POC copy: "if it falls on a weekend, it posts the same day").
  Rejected: business-day shifting (needs a holiday calendar per country).
