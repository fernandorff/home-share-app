# Recurring expenses — Tasks

Each task names its exact file(s) and the requirement it satisfies. Order = dependency order.
TDD: in every task the test is written first, run red, then the code makes it green.

Ground rules for implementers: never run `npm run build`, `next build` or `prisma db push` locally —
`.env` / `.env.local` point at the production Neon database. Schema changes stay additive. After a
schema change run only `npx prisma generate`; the test harness builds its own schema (pglite via
`prisma migrate diff --from-empty`). Implementers do not start servers or browsers; the live check is
task 21.

- [x] 1. Additive schema: enums `RecurringSplitMode`, `RecurringPauseReason`,
      `RecurringOccurrenceStatus`; models `RecurringExpense`, `RecurringExpenseOccurrence`; nullable
      `Expense.recurringExpenseId` + back-relations on `User`/`Group`/`Expense` (exactly as in
      design.md › Data model); `npx prisma generate` — `prisma/schema.prisma` _Requirements: 1, 8, 9, 10, 11, 17_
- [x] 2. Recurrence helpers, tests first: `isValidTimeZone`, `localToday`, `periodOf`, `addMonths`,
      `dueOn` (clamp), `eligiblePeriods` (activeFrom, lastClosedPeriod, cap 12), `upcomingPeriods`
      (skips, ledger, paused) — `src/lib/recurrence.test.ts`, `src/lib/recurrence.ts` _Requirements: 5, 6, 7, 15, 22_
- [x] 3. System actor for scheduled writes, tests first: `AuditContext.system`; the extension writes
      `actorId: null` when it is set, even with a session cookie present; add
      `RecurringExpenseOccurrence` to `SKIP_MODELS` — `src/lib/audit-context.ts`,
      `src/lib/prisma-audit.ts`, pglite cases in `src/services/tenant-isolation.test.ts` (the only file
      allowed to open the shared pglite DB) _Requirements: 13_
- [x] 4. `ExpenseService.create` accepts `options: { db?: transaction client; recurringExpenseId?: number }`
      (default: global client, null), tests first — `src/services/expense.service.test.ts`,
      `src/services/expense.service.ts` _Requirements: 8_
- [x] 5. Regression test: `POST /api/expenses` with `recurringExpenseId` in the body creates an expense
      whose `recurringExpenseId` is null — `src/app/api/expenses/route.test.ts` _Requirements: 20_
- [x] 6. Service — validation, `create`, `list` (DTO incl. `upcoming`, `lastClosedPeriod`, `canManage`;
      summary with exact `myMonthlyShare`; 50-row history), limit 50, tests first —
      `src/services/recurring-expense.service.test.ts`, `src/services/recurring-expense.service.ts` _Requirements: 1, 2, 3, 4_
- [x] 7. Service — `update` (expectedUpdatedAt → `STALE_RECURRING_EXPENSE`), `setPaused` (MANUAL;
      resume resets `activeFrom`, re-validates members, no-op on same state), `skip`/`unskip` (next 3
      upcoming only; ledger → `RECURRING_PERIOD_CLOSED`), `delete` (expenses kept, `recurringExpenseId`
      null), ownership (`NOT_RECURRING_OWNER`) and house scoping (`RECURRING_NOT_FOUND`), tests first —
      `src/services/recurring-expense.service.test.ts`, `src/services/recurring-expense.service.ts` _Requirements: 14, 15, 16, 17, 18_
- [x] 8. Service — `postDue(now, { recurringExpenseId?, deadline? })`: ledger claim first in the
      transaction, re-read rule, `expenseService.create` with `{ db: tx, recurringExpenseId }`, ALL vs
      SELECTED members, SKIPPED rows, `MEMBER_LEFT` pause, catch-up oldest first capped at 12,
      `runWithAuditContext({ system: true, groupId })`, AuditLog entry with `actorId` null +
      `changes.recurring`, no ledger row back from the claim (`createManyAndReturn` + `skipDuplicates`; `P2002`
      on the ledger key as fallback) → `duplicates`, deadline → `remaining`. Tests first: once, twice,
      pre-claimed ledger row, 3 missed months, deleted expense not re-posted, skipped, paused, resumed
      without back-fill, payer left, SELECTED participant left, exact shares, null actor inside a session
      context, other house untouched — `src/services/recurring-expense.service.test.ts`,
      `src/services/recurring-expense.service.ts` _Requirements: 7, 8, 9, 10, 11, 12, 13_
- [x] 9. Cron guard, tests first: `requireCron(request)` — unset secret → 401 + one warn log, constant-time
      compare, `CRON_UNAUTHORIZED` — `src/lib/cron.test.ts`, `src/lib/cron.ts` _Requirements: 19_
- [x] 10. Cron route + middleware + schedule, tests first: `GET /api/cron/recurring-expenses`
      (`dynamic = 'force-dynamic'`, `maxDuration = 60`, 30 s deadline, counts-only JSON); `/api/cron` in
      `PUBLIC_API_PREFIXES`; `crons` entry in `vercel.json` — `src/app/api/cron/recurring-expenses/route.test.ts`,
      `src/app/api/cron/recurring-expenses/route.ts`, `src/middleware.test.ts`, `src/middleware.ts`,
      `vercel.json` _Requirements: 7, 19_
- [x] 11. Audit types for the Summary feed: `AuditEntityType` += `'RECURRING_EXPENSE'`, `AuditAction` +=
      `'PAUSE' | 'RESUME' | 'SKIP' | 'UNSKIP'` — `src/services/audit.service.ts` _Requirements: 24_
- [x] 12. Collection route, tests first: `GET` (list) and `POST` (validate → create → synchronous
      `postDue` for the new rule → `recordActivity` CREATE → `201 { rule, postedNow }`;
      `expectedGroupId` → `STALE_GROUP`) — `src/app/api/recurring-expenses/route.test.ts`,
      `src/app/api/recurring-expenses/route.ts` _Requirements: 1, 2, 3, 4, 6, 7, 24_
- [x] 13. Item route, tests first: `PATCH` (pause/resume vs field edit, `RECURRING_PATCH_INVALID`,
      synchronous `postDue` after edit/resume, Summary entries, no entry on no-op) and `DELETE` —
      `src/app/api/recurring-expenses/[recurringExpenseId]/route.test.ts`,
      `src/app/api/recurring-expenses/[recurringExpenseId]/route.ts` _Requirements: 14, 16, 17, 18, 24_
- [x] 14. Skip routes, tests first: `PUT`/`DELETE …/skips/{period}` (format check, idempotent, Summary
      SKIP/UNSKIP entries only on change) —
      `src/app/api/recurring-expenses/[recurringExpenseId]/skips/[period]/route.test.ts`,
      `src/app/api/recurring-expenses/[recurringExpenseId]/skips/[period]/route.ts` _Requirements: 15, 18, 24_
- [x] 15. Client types: `RecurringExpense`, `RecurringHistoryItem`, `Expense.recurringExpenseId` —
      `src/lib/types.ts` _Requirements: 4, 23_
- [x] 16. i18n keys (design.md › i18n keys) in all 4 locales + reusable parity test, test first —
      `src/lib/i18n-parity.test.ts`, `src/messages/en.json`, `src/messages/pt.json`,
      `src/messages/es.json`, `src/messages/fr.json` _Requirements: 2, 13, 21, 22, 23, 24_
- [x] 17. Activity: `actorLabelKey` helper (test first) → "Automatic" for recurring postings in Summary
      and Detailed; `RecurringExpense` in `REVISION_ENTITY_TYPES` and in the Detailed field preset; new
      `act.*`, entity, field and value labels — `src/lib/activity-format.test.ts`,
      `src/lib/activity-format.ts`, `src/lib/constants.ts`, `src/app/(app)/activity/page.tsx` _Requirements: 13, 24_
- [x] 18. Rule form modal (create/edit, day stepper + clamp hint, split modes, live preview with
      `recurrence` + `splitCents`, `expectedUpdatedAt`, 409 handling) —
      `src/components/recurring/RecurringExpenseFormModal.tsx` _Requirements: 1, 16, 22_
- [x] 19. Page, rule card, tabs, navigation entry and expense marker —
      `src/app/(app)/recurring/page.tsx`, `src/components/recurring/RecurringRuleCard.tsx`,
      `src/components/app/navigation.tsx`, `src/app/(app)/expenses/page.tsx`,
      `src/components/expenses/ExpenseDetailModal.tsx` _Requirements: 4, 14, 15, 17, 21, 23_
- [x] 20. ADR + env template: promote ADR 0010 to `accepted` when this ships; add `CRON_SECRET=` (with a
      Portuguese comment, like the other entries) — `docs/decisions/0010-scheduled-jobs-vercel-cron.md`,
      `.env.example` _Requirements: 19_
- [x] 21. Verify: `npx tsc --noEmit` + `npm run test` + `npx eslint src` green; `npx next build` is
      checked by CI with a placeholder `DATABASE_URL` (never locally); every criterion maps to a test or
      the manual check below. Live check on QA (design.md › Testing strategy › Live): rule due today
      posts once with the ↻ marker and "Automatic" in Activity; cron twice → one expense; no header →
      401; pause/skip/resume behave as in the POC on a 393 px viewport. After the owner actions
      (design.md › Owner actions): Vercel › Cron Jobs › Run → 200 with counts _Requirements: 1–24_
