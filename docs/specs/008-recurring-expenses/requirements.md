# Recurring expenses — Requirements

## Problem

Rent, internet and condo fees repeat every month, but someone has to remember to post them, type the
amount and redo the split. A forgotten month becomes a wrong balance and an argument at the end of the
month (POC `screenshots/loop-2026-09-27/artefato/pocs/despesas-recorrentes.html`, owner request).

## User story

As a household member, I want monthly rules that post an expense by themselves on the right day, with
the split already defined, and that I can pause or skip for a month, so that fixed bills are never
forgotten or posted twice.

## Acceptance criteria (EARS)

Each criterion must be verifiable by a test (or a single curl) in ~10 seconds.

**Rules**

1. WHEN an active member sends `POST /api/recurring-expenses` with a description (1–200 chars, no
   control characters), an `amount` (> 0, at most 2 decimals, ≤ 99,999,999.99), a `dayOfMonth`
   (integer 1–31), a `payerId` that is an active member, `splitMode` `ALL` or `SELECTED` (SELECTED:
   1–50 distinct active-member `participantIds`) and a valid IANA `timezone`, THE SYSTEM SHALL create
   the rule in the active house and respond 201 with the rule, including its next 3 upcoming periods.
2. WHEN any of those fields is invalid, THE SYSTEM SHALL respond 400 with a stable code
   (`DESCRIPTION_REQUIRED`, `DESCRIPTION_TOO_LONG`, `DESCRIPTION_INVALID`, `AMOUNT_INVALID`,
   `AMOUNT_PRECISION`, `AMOUNT_TOO_HIGH`, `PAYER_REQUIRED`, `RECURRING_DAY_INVALID`,
   `RECURRING_SPLIT_INVALID`, `RECURRING_TIMEZONE_INVALID`, `RECURRING_MEMBER_INACTIVE`) and create
   nothing.
3. WHEN the active house already has 50 rules, THE SYSTEM SHALL respond 409 `RECURRING_LIMIT_REACHED`.
4. WHEN a member sends `GET /api/recurring-expenses`, THE SYSTEM SHALL return only the active house's
   rules, a summary (`monthlyTotal` of unpaused rules; the caller's `myMonthlyShare` computed with the
   same integer-cents equal split used for posting; active and paused counts) and the 50 most recent
   closed periods (posted or skipped) of the house, newest first.

**Dates**

5. THE SYSTEM SHALL compute a rule's "today" as the calendar date in the rule's `timezone` (never the
   server's date), and a period's due date as `dayOfMonth` clamped to the last day of that month
   (31 → 30 April; 29/30/31 → 28 February, 29 in leap years); weekends and holidays do not move it.
6. WHEN a rule is created or resumed, THE SYSTEM SHALL make its first eligible period the first one
   whose due date is on or after that day's local date — a due date earlier in the current month is
   never back-filled.

**Posting**

7. WHEN the scheduled job runs — or when a rule is created, edited or resumed (for that rule only) —
   THE SYSTEM SHALL post one expense for every eligible period of every unpaused rule whose due date
   is on or before the rule's local today and that has no ledger entry yet, oldest period first
   (catch-up for missed runs), at most 12 periods per rule per run.
8. WHEN a period is posted, THE SYSTEM SHALL create the expense through `ExpenseService.create` with
   the rule's description, amount and payer, `date` = the due date at the `T12:00:00` convention,
   `recurringExpenseId` = the rule, and an equal integer-cents split among every active member (`ALL`)
   or among `participantIds` (`SELECTED`) whose shares sum exactly to the amount — and SHALL record a
   POSTED ledger entry linked to that expense in the same transaction.
9. WHEN the job processes the same rule and period more than once — a second run, a retry or a
   duplicate delivery — THE SYSTEM SHALL keep exactly one expense and one ledger entry for that
   (rule, period).
10. WHEN a posted expense is later deleted, THE SYSTEM SHALL NOT post that period again.
11. WHEN a period listed in the rule's skipped periods reaches its due date, THE SYSTEM SHALL record a
    SKIPPED ledger entry and create no expense.
12. WHEN a period becomes due and the payer — or, for `SELECTED`, any participant — is no longer an
    active member, THE SYSTEM SHALL post nothing, pause the rule with `pauseReason` `MEMBER_LEFT` and
    write no ledger entry for that period.
13. WHEN a rule posts an expense, THE SYSTEM SHALL record the `Expense` CREATE revision with
    `actorId` null and an Activity Summary entry with `actorId` null and `changes.recurring = true`;
    both Activity feeds SHALL show that actor as "Automatic" (not "Someone").

**Control**

14. WHEN the rule's payer or a house admin sends `PATCH /api/recurring-expenses/{publicId}` with
    `{ "paused": true }`, THE SYSTEM SHALL pause the rule (nothing is posted while paused); with
    `{ "paused": false }` it SHALL resume it with eligibility restarting at the local today
    (criterion 6), after re-checking that the payer and participants are active members (else 400
    `RECURRING_MEMBER_INACTIVE`). Sending the current state SHALL be a 200 no-op.
15. WHEN the payer or an admin sends `PUT /api/recurring-expenses/{publicId}/skips/{YYYY-MM}` for one
    of the rule's next 3 upcoming periods, THE SYSTEM SHALL add it to the skipped periods (idempotent),
    and `DELETE` on the same path SHALL remove it (idempotent). Any other period SHALL get 400
    `RECURRING_PERIOD_INVALID`; a period that already has a ledger entry SHALL get 409
    `RECURRING_PERIOD_CLOSED`.
16. WHEN the payer or an admin edits a rule (`PATCH` with editable fields and `expectedUpdatedAt`),
    THE SYSTEM SHALL apply the change only to periods not yet posted and leave every posted expense
    untouched; a stale `expectedUpdatedAt` SHALL get 409 `STALE_RECURRING_EXPENSE`.
17. WHEN the payer or an admin sends `DELETE /api/recurring-expenses/{publicId}`, THE SYSTEM SHALL
    delete the rule and its ledger, keep every expense it posted (their `recurringExpenseId` becomes
    null) and post nothing more.
18. WHEN a member who is neither the rule's payer nor an admin attempts criteria 14–17, THE SYSTEM
    SHALL respond 403 `NOT_RECURRING_OWNER` and change nothing; WHEN the rule does not exist or
    belongs to another house, THE SYSTEM SHALL respond 404 `RECURRING_NOT_FOUND`.
19. WHEN a request to `GET /api/cron/recurring-expenses` lacks `Authorization: Bearer <CRON_SECRET>`,
    or `CRON_SECRET` is unset, THE SYSTEM SHALL respond 401 and post nothing; THE route SHALL be
    reachable without a session cookie (no redirect to the login page).
20. WHEN a client sends `recurringExpenseId` in `POST /api/expenses`, THE SYSTEM SHALL ignore it.

**UI and Activity**

21. WHILE on `/recurring`, THE SYSTEM SHALL show the summary card, a "New rule" action and three tabs
    — Rules (one card per rule: amount, day, payer, split, status, Skip/Undo and Pause/Resume, plus
    Edit/Delete when the viewer is the payer or an admin), Upcoming (next periods across rules, at most
    6, each skippable) and Posted (history including skipped months) — in all 4 locales, mobile-first,
    with 44 px touch targets.
22. WHILE the rule form is open, THE SYSTEM SHALL preview the per-person share and the posting date —
    the first posting when creating (browser's timezone), the next posting when editing (the rule's
    stored timezone), "paused · nothing will be posted" for a paused rule — computed by the shared
    recurrence helper, and explain the last-day clamp when the day is above 28.
23. WHILE an expense has a `recurringExpenseId`, THE SYSTEM SHALL show a "Recurring" marker on its
    list row and in its detail.
24. WHEN a rule is created, edited, paused, resumed, skipped, unskipped or deleted, THE SYSTEM SHALL
    add an Activity Summary entry (entity `RECURRING_EXPENSE`, the rule's description) attributed to
    the member who did it, and Activity › Detailed SHALL list `RecurringExpense` revisions under their
    own filter chip.

## Out of scope

- Frequencies other than monthly (weekly, yearly, every N months); end dates or installment counts.
- Custom (unequal) splits, tags, platforms, payment methods or notes on a rule — the posted expense
  can be edited like any other.
- Changing a rule's timezone after creation; a house-level timezone setting.
- Skipping beyond the next 3 upcoming periods; moving due dates off weekends/holidays.
- Back-filling past periods on demand.
- Notifications (new posted expense, due-date reminders, auto-pause alerts) — spec 009.
- A "recurring" column in the CSV export; opening the posted expense from the Posted tab.

## Open questions

None — every decision was taken with the recommended option (owner instruction) and is recorded in
[design.md › Alternatives considered](design.md#alternatives-considered) and ADR
[0010](../../decisions/0010-scheduled-jobs-vercel-cron.md).
