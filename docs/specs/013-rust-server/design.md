# Rust server (Axum) with precomputed balances — Design

## Approach

A new Cargo workspace at `server/` holds one Axum binary that replaces the Next.js server. It follows
the same shape the app already has: thin handlers (validate → call service → respond) over
framework-agnostic services, integer cents, cookie auth, active house from a cookie checked against
membership. It starts from the pilot's code (`pilots/balances-rust/server/src/main.rs` on
`pilot/balances-rust`), which already validates the session cookie and serves `GET /api/balances`
with the precomputed totals and the version cache.

Migration is **gate-first, one cutover**: production keeps running on Next while the Rust routes are
built one group at a time. A group counts as done only when the parity gate (criteria 1–3) passes for
it against a seeded copy of the database. No production traffic reaches Rust before the switch, so the
two servers never write to the same database at once. Staging (`dev`) is the full dry run of the switch;
then production switches in one step (builder's call, 2026-11-09).

Order inside the spec (dependency order, also the commit order):

1. Precomputed totals and version counter as a real Prisma migration (from `pilots/balances-rust/mat/*.sql`,
   renamed from `Pilot*`), with the `check.sql` matrix as a test. The Next route reads
   them first, so production gains before any Rust ships (pilot: 632 → 12 ms).
2. Rust core: config, pool, session/cookie, active house, error `code` contract, money serialization,
   audit writer, expected-state tokens, rate limit, Sentry.
3. Route groups, each with its gate run: balances → expenses (incl. import/export/bulk) → settlements →
   catalogs (categories, platforms, payment methods) → shopping → groups/house → notifications/push →
   recurring → activity/revisions → auth (incl. Google) → cron.
4. The web app built by Vite (Rolldown, one bundle) and served by Axum; theme/locale moved to the browser.
5. Deploy on the chosen host; staging (`dev`) first, then production. The Next app stays deployed on
   Vercel at the `-next` host name, same database, with its crons removed (Fernando, 2026-11-09: both
   side by side for the portfolio, Rust latency first).

## Data model

- New tables, through one migration in `prisma/migrations`: `BalanceCredit`, `BalanceDebit`,
  `BalanceCategoryTotal`, `BalanceMonthTotal` (each with a row count `n`) and `GroupVersion`
  (pilot names `Pilot*` renamed). Declared in `schema.prisma` so Prisma stays the schema authority.
- Triggers and functions live in the migration SQL (Prisma does not model triggers).
- Version triggers on `Expense`, `ExpenseParticipant`, `Settlement` and `User` (name), as in the pilot.
  No `GroupMember` trigger: members are never deleted (`leftAt`, `prisma/schema.prisma:87-90`) and the
  balances response does not depend on membership.
- Cost measured in the pilot: ~1 ms more per expense written (2,000 expenses with 5 participants:
  0.17 s → 1.95 s, `mat/write-cost.sql`).

## API contract

Unchanged. Every path, method, status, body and error `code` is the one in `src/app/api/**` today;
the parity gate is the contract. Database access: `tokio-postgres` + `deadpool-postgres` with
`prepare_cached` (pilot: +33% capacity over plain queries). JSON: `serde`. JWT: `jsonwebtoken` HS256
with the same secret and claims as `lib/auth` (jose).

## UI

- Vite 8 (Rolldown) builds the same `src/app` pages into one JS bundle, no lazy routes (Fernando,
  2026-11-09, from the front-end build pilot: list visible 0.32–0.47 s sooner than a Next export on the
  three main screens, ~193 KB vs ~280 KB of JS per page, and Axum serves plain files with an
  `index.html` fallback instead of Next's RSC segment files). Routes come from the `src/app` folders;
  small shims stand in for `next/link`, `next/navigation` and `next-intl` (`src/vite/**`). Every page
  under `(app)` and `auth` is already a client component; the four server files (`src/app/layout.tsx`,
  `src/app/auth/layout.tsx`, `src/app/page.tsx`, `src/app/not-found.tsx`) are not used by the Vite
  build: the root redirect moves to Axum.
- Browser Sentry keeps its `/monitoring` tunnel (added today by `withSentryConfig`); Axum proxies it to
  Sentry and the CSP stays `connect-src 'self'`.
- `index.html` carries a small inline script that reads the theme and locale cookies before first
  paint; `use-intl` runs client-side (English bundled, the other three locales loaded on demand).
  The Next build keeps reading them on the server, unchanged.
- `src/middleware.ts` is removed; its gate, public prefixes and sliding renewal move to an Axum layer.
- No visible change; screenshot comparison of every page before and after (same method as the pilot's
  pixel comparison).

## Error handling & edge cases

- A cookie signed by Next must validate in Rust and vice versa (same secret, same claims, same
  `sessionVersion` check), so nobody is logged out by the switch.
- Audit rows: Rust writes the same JSON shape Prisma writes for scalar fields and the included
  relations each service uses today (e.g. settlement `fromUser`/`toUser`); the gate compares them as
  normalized JSON. Bulk markers keep their `where`/`data` keys (`src/lib/prisma-audit.ts:176-190`).
- CSV import uses `createMany`: row triggers fire per row; the `check.sql` matrix gets an import case.
- Recurring posting and cron run in-process with `tokio` timers; the database unique-key claim keeps a
  double run harmless (ADR 0010 unchanged in substance). A restart during a run is the same as a
  missed delivery today: the next run reconciles.
- Two writers on one database: totals and version stay right because triggers do the work; the
  Rust body cache revalidates by version on every read, so a Next write is seen at once. Rate limits
  are per server (a client could get twice the limit by using both URLs; accepted).
- The web build for Rust is a separate Vite build (`npm run build:web`, route handlers never part of
  it); the Vercel build stays a normal Next build, so the `-next` app keeps its server.
- In-memory rate limit and body cache are per process; with one instance this matches today's limits.
  `ponytail:` one instance only; a shared store when a second instance is needed.

## Alternatives considered

- Next on Vercel + Rust API on another host behind a rewrite — rejected by Fernando on 2026-11-09: two
  hosts anyway, the shape ADR 0004 rejected, one extra network hop per request.
- Rust as Vercel functions — rejected: never measured, beta, the in-memory cache dies with the function.
- Go — rejected on numbers: 4,162 vs 6,914 ok/s and 10 vs 4.7 MiB in the pilot.
- Keep Next and only add precomputation + cache — rejected on numbers: 379 ok/s ceiling, 310 MiB.
- Delete the Next server after the switch — rejected by Fernando on 2026-11-09: both stay up side by
  side on the same database, Next at the `-next` URL.
- Two specs (precomputation first, server later) — Fernando chose one spec; the precomputation is
  step 1 inside it instead.
