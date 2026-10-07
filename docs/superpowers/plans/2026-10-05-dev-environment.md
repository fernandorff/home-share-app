# Dev environment (staging) — plan

Decided with the owner on 2026-10-05 (grill-me, 14 questions). Today `.env` / `.env.local` point at the production
Neon database and the only isolated environment is the local QA Docker stack.

## Decisions

| # | Topic | Decision |
|---|---|---|
| 1 | Role | One **fixed staging** environment with a stable HTTPS URL (PWA install, push subscriptions and the Google redirect URI survive). |
| 2 | Database | A **Neon branch `dev`** created from production (copy-on-write; real data; isolated). |
| 3 | Vercel | Same project: **Preview** env vars scoped to the Git branch `dev` + the domain `dev.homeshare.fernandorffdev.com` assigned to `dev`. Vercel runs crons only in Production → on staging the cron routes are called by hand (`curl` with the staging `CRON_SECRET`). |
| 4 | Other previews | **Only `main` and `dev` deploy** on Vercel; every other branch runs only the GitHub CI (tests + build with a placeholder DB). |
| 5 | Local dev | `.env.local` points at the **local Docker Postgres**; the production URL leaves the PC (Vercel + password manager only). |
| 6 | Schema | **Prisma Migrate, run manually**: versioned SQL in `prisma/migrations`, `prisma migrate deploy` on staging first, then production. One-time baseline of the current production schema. |
| 7 | Google login | Same OAuth client; add `https://dev.homeshare.fernandorffdev.com/api/auth/google/callback` to it. |
| 8 | Sentry | Same project and DSN; staging events arrive as environment `preview` (alerts only on `production`). |
| 9 | Access | App login only (same as production) + an `X-Robots-Tag: noindex` header on staging. |
| 10 | Git flow | feature branch → PR into `dev` (CI; merge updates staging) → test → PR `dev` → `main` (production). CI runs on PRs to `dev` too. |
| 11 | Staging data | Reset the Neon `dev` branch from production **on demand** (before rehearsing a migration), then `migrate deploy` re-applies the new migrations. |
| 12 | Who does the consoles | The **owner**, with an exact checklist from Claude; Claude verifies what is visible from outside afterwards. |
| 13 | Order | **Consoles first, then push**: Claude prepares the infrastructure code + checklist (no push) → owner configures Neon/Vercel/Google → Claude commits on the feature branch, creates `dev`, opens the PR into `dev`. |
| 14 | Branch | `feat/ui-loop-and-pocs` (all pending work + the dev-environment code). |

## Claude's code tasks (no push until the owner confirms the consoles)

1. CI (`.github/workflows/test.yml`): run on push/PR to `dev` as well as `main`.
2. Vercel Ignored Build Step: deploy only `main` and `dev` (script + `vercel.json` `ignoreCommand`, or the dashboard setting — checklist).
3. `X-Robots-Tag: noindex` when `VERCEL_ENV !== "production"` (next.config headers), with a test.
4. Prisma Migrate: `prisma/migrations/0_init` (baseline = production schema before POCs 008–010, i.e. the schema on `main`) + `1_pocs_008_010` (the additive SQL); package scripts; `npm run build` must never touch a database (drop the `prisma db push` from it).
5. `.env.example` / README › Deploy + local setup: local Docker URL, staging, migration commands.
6. Owner checklist: Neon branch, Vercel env vars (Preview scoped to `dev`), domain, ignored builds, Google redirect URI, baseline + `migrate deploy` on staging then production, staging smoke test (PWA, push on Android/iPhone, cron by hand).

## Progress (2026-10-05)

- Code done, no commit/push yet (order 13): CI on main + dev with a migrations-match-schema step (Postgres
  service); `scripts/vercel-ignore-build.mjs` + `ignoreCommand`; `X-Robots-Tag: noindex, nofollow` outside
  production (verified on QA); `build` = `prisma generate && next build`; `db:migrate` / `db:migrate:status`;
  `setup` / `dev:full` / `db:reset` use `migrate deploy` (guard test: no script runs `db push`); docker-compose
  `homeshare-dev-pg` :5433 `homeshare_dev`; prisma.config loads `.env.local` then `.env` and reads
  `SHADOW_DATABASE_URL`; README (+ pt/es/fr) and CLAUDE.md updated.
- `prisma/migrations/0_init` (baseline = `main`'s schema) + `1_pocs_008_010` (4 types, 1 column, 5 tables,
  10 indexes, 11 FKs, no DROP). Verified on local Docker: empty DB → deploy → in sync; production-like DB →
  resolve 0_init → deploy → in sync; un-migrated model → diff exit 2.
- Owner checklist: `docs/dev-environment.md` (incl. Vercel Deployment Protection off/exception for the dev domain).
