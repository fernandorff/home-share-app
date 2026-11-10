# Rust server (Axum) with precomputed balances — Tasks

Each task names its exact file(s) and the requirement it satisfies. Order = dependency order.
One commit per task (Fernando, 2026-11-09: "cada ponto em commits separados").

## 1. Precomputed balances (ships on the current Next app first)

- [x] 1.1 Migration with the total tables, version table, triggers and backfill —
      `prisma/schema.prisma`, `prisma/migrations/<ts>_precomputed_balances/migration.sql` _Requirements: 5, 6_
- [x] 1.2 Trigger matrix as a test: single write, edit, move house, delete, settlement, CSV `createMany`,
      recurring posting, bulk delete, user rename — `test/global-setup.ts` (apply migrations),
      `src/services/tenant-isolation.test.ts` (the single pglite integration file) _Requirements: 5, 6_
- [x] 1.3 Next route reads the totals and the version cache (ETag/304) —
      `src/app/api/balances/route.ts`, `src/services/balance.service.ts` _Requirements: 5, 7_
- [ ] 1.4 Apply on staging (`npm run db:migrate`, Neon branch `dev`), then production — manual _Requirements: 5_

## 2. Rust core

- [x] 2.1 Workspace, config with fail-fast env check, pool, health — `server/Cargo.toml`,
      `server/src/main.rs`, `server/src/config.rs`, `server/src/routes/health.rs` _Requirements: 21, 22_
- [x] 2.2 Session cookie (verify, sliding renewal, `sessionVersion`), active house, auth layer —
      `server/src/auth.rs`, `server/src/house.rs` _Requirements: 9, 10, 11, 12_
- [x] 2.3 Error `code` contract and money serialization — `server/src/errors.rs`, `server/src/money.rs` _Requirements: 3, 4_
- [x] 2.4 Audit writer, sensitive-field markers, explicit revisions — `server/src/audit.rs` _Requirements: 13_
- [x] 2.5 Expected-state tokens, rate limit, Sentry — `server/src/concurrency.rs`,
      `server/src/rate_limit.rs`, `server/src/observability.rs` _Requirements: 14, 17, 18_
- [x] 2.6 Parity gate for every route (status, body, every table after writes) —
      `server/gate/gate.mjs`, `server/gate/cases.mjs`, `server/gate/fixture.sql` _Requirements: 1, 2, 3_

## 3. Route groups (each: handlers + services + gate green)

- [x] 3.1 Balances — `server/src/routes/balances.rs` _Requirements: 1, 5, 7, 8_
- [x] 3.2 Expenses, history, bulk delete, import, export — `server/src/routes/expenses.rs`, `server/src/csv.rs` _Requirements: 1, 2, 3, 5_
- [x] 3.3 Settlements — `server/src/routes/settlements.rs` _Requirements: 1, 2_
- [x] 3.4 Categories, platforms, payment methods — `server/src/routes/catalogs.rs` _Requirements: 1, 2_
- [x] 3.5 Shopping items and expense links — `server/src/routes/shopping.rs` _Requirements: 1, 2_
- [x] 3.6 Groups, join, active house, members, currency, leave, join code — `server/src/routes/groups.rs` _Requirements: 1, 2, 6, 12_
- [x] 3.7 Notifications, preferences, push subscriptions, test push — `server/src/routes/notifications.rs`, `server/src/push.rs` _Requirements: 1, 2, 16_
- [x] 3.8 Recurring expenses and skips — `server/src/routes/recurring.rs` _Requirements: 1, 2_
- [x] 3.9 Activity and revisions — `server/src/routes/activity.rs` _Requirements: 1, 13_
- [x] 3.10 Auth: login, register, password, me, logout, logout-all, Google — `server/src/routes/auth.rs` _Requirements: 1, 9, 10, 11_
- [x] 3.11 Scheduled jobs in-process — `server/src/jobs.rs` _Requirements: 15_

## 4. Web app from the same process

- [x] 4.1 Vite web build (Rolldown, one bundle) next to the normal Next build; shims for `next/link`,
      `next/navigation`, `next-intl`; theme/locale applied in the browser — `vite.config.ts`,
      `index.html`, `src/vite/**`, `package.json` _Requirements: 20, 23_
- [x] 4.2 Axum serves the Vite build (files + `index.html` fallback) with CSP, headers, old-path and `/` redirects, the `/monitoring`
      Sentry tunnel, the page gate and renewal of `src/middleware.ts` (kept for the `-next` app, task 5.3) —
      `server/src/static_files.rs` _Requirements: 18, 19_
- [x] 4.3 Screenshot comparison of every page before/after — `server/gate/screens.mjs` _Requirements: 19, 20_
      (15 pages × phone/desktop × default-en/bolitas-pt: 60/60 identical Next vs `vite preview`, 2026-11-09,
      and 60/60 Next vs Axum, 2026-11-10)

## 5. Deploy

- [ ] 5.1 Host decision (official prices + criterion 8 measured on each finalist) and a new ADR
      superseding 0004 and 0010 — `docs/decisions/0014-*.md` _Requirements: 8_
- [ ] 5.2 Container and deploy for staging, then production — `server/Dockerfile`, deploy config _Requirements: 8, 21_
- [ ] 5.3 Next app moves to the `-next` host name, crons removed, same database — `vercel.json`,
      DNS/Vercel domain (manual) _Requirements: 23, 24, 25_
- [ ] 5.4 Verify: `cargo test`, `npm run test`, gate green on staging, criterion 8 on the host, live check.
