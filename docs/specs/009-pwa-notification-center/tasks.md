# Installable app + notification center — Tasks

Each task names its exact file(s) and the requirement it satisfies. Order = dependency order.
TDD: in every task the test is written first, run red, then the code makes it green.
Prerequisite: spec 008 merged (recurrence helpers, `requireCron`, `/api/cron` public prefix, recurring
poster, `i18n-parity` test).

Ground rules: never run `npm run build`, `next build` or `prisma db push` locally (`.env*` = production
Neon). Additive schema only; after it, only `npx prisma generate`. No servers/browsers for implementers
— the live check is task 20.

- [x] 1. Additive schema: enum `NotificationType`, models `Notification` and `NotificationPreference`,
      back-relations on `User`/`Group` (design.md › Data model); `npx prisma generate` —
      `prisma/schema.prisma` _Requirements: 4, 6, 7, 8, 9, 11_
- [x] 2. Exclude personal models from the audit trail, test first: `Notification` and
      `NotificationPreference` in `SKIP_MODELS` (writes create no `EntityRevision`) —
      `src/lib/prisma-audit.ts`, real-DB cases in `src/services/tenant-isolation.test.ts` (the only file
      allowed to open the shared pglite DB) _Requirements: 20_
- [x] 3. Pure helpers, tests first: `notificationHref`, `groupByDay`, `isoWeek` —
      `src/lib/notifications.test.ts`, `src/lib/notifications.ts` _Requirements: 8, 15_
- [x] 4. Service core, tests first: `create` (drop actor, active members only, preference filter,
      `createManyAndReturn` + `skipDuplicates`), `getPreferences`/`setPreference` (defaults on) —
      `src/services/notification.service.test.ts`, `src/services/notification.service.ts` _Requirements: 9, 13_
- [x] 5. Event producers, tests first: `expenseCreated` (payer ∪ share > 0, minus actor; `recurring`
      flag) and `settlementCreated` (recipient unless self) — same files _Requirements: 4, 5, 6_
- [x] 6. Read side, tests first: `list` (≤ 50, unread filter, newest first), `unreadCount`, `markRead`,
      `markAllRead`, `delete` — all scoped by user + house (`NOTIFICATION_NOT_FOUND`) — same files _Requirements: 11, 12_
- [x] 7. Scheduled producers, tests first: `sendRecurringDueReminders(now)` (tomorrow in the rule's
      timezone, first unskipped upcoming period, payer only, dedupe per rule+period),
      `sendDebtReminders(now)` (Mondays UTC, balance < 0 via `balanceService.aggregate` +
      `applySettlements`, dedupe per house+ISO week), `prune(now)` (> 90 days) — same files _Requirements: 7, 8, 17, 18_
- [x] 8. Account deletion removes notices and preferences inside its transaction, test first —
      `src/services/auth.service.ts`, `src/services/notification.service.test.ts` _Requirements: 19_
- [x] 9. `notifySafely` wrapper (catch + `logger.error`, never throws), test first —
      `src/lib/api-helpers.ts`, `src/lib/api-helpers.test.ts` _Requirements: 10_
- [x] 10. Wire producers, tests first (a throwing service still yields 201): expense POST, settlement
      POST, and the recurring poster after each committed posting —
      `src/app/api/expenses/route.ts`, `src/app/api/expenses/route.test.ts`,
      `src/app/api/settlements/route.ts`, `src/app/api/settlements/route.test.ts`,
      `src/services/recurring-expense.service.ts`, `src/services/recurring-expense.service.test.ts` _Requirements: 4, 5, 6, 10_
- [x] 11. Center routes, tests first: `GET /api/notifications`, `GET /api/notifications/unread-count`,
      `POST /api/notifications/read-all`, `PATCH`/`DELETE /api/notifications/{publicId}` —
      `src/app/api/notifications/route.ts`, `src/app/api/notifications/route.test.ts`,
      `src/app/api/notifications/unread-count/route.ts`, `src/app/api/notifications/read-all/route.ts`,
      `src/app/api/notifications/[notificationId]/route.ts`,
      `src/app/api/notifications/[notificationId]/route.test.ts` _Requirements: 11, 12_
- [x] 12. Preferences route, tests first: `GET`/`PUT /api/notification-preferences`
      (`NOTIFICATION_PREF_INVALID`) — `src/app/api/notification-preferences/route.ts`,
      `src/app/api/notification-preferences/route.test.ts` _Requirements: 9, 13_
- [x] 13. Cron route + schedule, tests first: `GET /api/cron/notifications` (due reminders, Monday debt
      reminders, prune; counts only) and the `crons` entry `0 12 * * *` —
      `src/app/api/cron/notifications/route.ts`, `src/app/api/cron/notifications/route.test.ts`,
      `src/middleware.test.ts`, `vercel.json` _Requirements: 7, 8, 17, 18_
- [x] 14. PWA icons: generator script with the exact-pinned devDependency `@resvg/resvg-js`, run once,
      PNGs committed — `scripts/generate-pwa-icons.mjs`, `package.json`, `package-lock.json`,
      `public/icons/icon-192.png`, `public/icons/icon-512.png`, `public/icons/maskable-512.png`,
      `public/icons/apple-touch-icon.png` _Requirements: 1_
- [x] 15. Manifest + layout metadata, contract test first (fields, icon files and PNG sizes; middleware
      lets `/manifest.json` and `/icons/*` through without a cookie) — `src/lib/pwa-manifest.test.ts`,
      `public/manifest.json`, `src/app/layout.tsx`, `src/middleware.test.ts` _Requirements: 1_
- [x] 16. Install prompt logic, tests first: deferred-event store, `appinstalled`, `isIos`,
      `isStandalone`, 30-day dismissal with guarded `localStorage` — `src/lib/install-prompt.test.ts`,
      `src/lib/install-prompt.ts` _Requirements: 2, 3_
- [x] 17. Client types + i18n keys (design.md › i18n keys, 4 locales), parity test extended first —
      `src/lib/types.ts`, `src/lib/i18n-parity.test.ts`, `src/messages/en.json`, `src/messages/pt.json`,
      `src/messages/es.json`, `src/messages/fr.json` _Requirements: 13, 15, 16_
- [x] 18. Unread-count provider + header bell (mobile and desktop) —
      `src/lib/notifications-context.tsx`, `src/components/app/NotificationBell.tsx`,
      `src/components/app/AppChrome.tsx`, `src/app/(app)/layout.tsx` _Requirements: 14_
- [x] 19. Notices page: tabs, filter, day groups, item, preferences switches, install banner + sheet +
      "App on home screen" card — `src/app/(app)/notifications/page.tsx`,
      `src/components/notifications/NotificationItem.tsx`,
      `src/components/notifications/NotificationPreferences.tsx`,
      `src/components/notifications/InstallBanner.tsx`, `src/components/notifications/InstallSheet.tsx` _Requirements: 2, 3, 15, 16_
- [x] 20. ADR + verify: promote ADR 0011's PWA part to `accepted` when this ships (push part stays with
      spec 010) — `docs/decisions/0011-pwa-web-push.md`. `npx tsc --noEmit` + `npm run test` +
      `npx eslint src` green; `npx next build` via CI only. Live check on QA (design.md › Testing
      strategy › Live) at 393 px and desktop; after the owner actions, install on a real Android phone
      and iPhone; Cron Jobs › Run → counts _Requirements: 1–20_
