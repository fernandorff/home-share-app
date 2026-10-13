# Dev environment — owner setup checklist

Plan and decisions: [superpowers/plans/2026-10-05-dev-environment.md](superpowers/plans/2026-10-05-dev-environment.md).
Do the steps in order. Exception, found on the panels (2026-10-07): Vercel only accepts a Git branch that already
exists on GitHub (domain: "Branch "dev" not found in the connected Git repository"), so `dev` is pushed first as an
exact copy of `main` — same code and same database as production, no new code. Until step 2 is done that preview
runs with production's `DATABASE_URL` (the Neon integration sets it for All Environments) and without
`JWT_SECRET` (Preview has none; `getSecret()` throws under `NODE_ENV=production`, so no session can be signed).

Where a step needs a secret (database URL, keys), you paste it yourself; Claude never types credentials.

Done by Claude on 2026-10-07: step 1.1 (Neon branch `dev`, project `home-share-db` / `hidden-forest-06290958`,
parent `main`), step 3 DNS record + domain, step 3b check (already off), step 5.

## 1. Neon — staging database branch

The database is the Vercel **Neon integration** store `home-share-db`: Vercel › home-share-app › **Storage** ›
home-share-db › **Open in Neon**. The first time, Neon asks you to verify your e-mail to link the account
(link sent by e-mail).

1. Neon console › project › **Branches** › **Create branch**: name `dev`, parent = the production branch
   (usually `main`), "from current data".
2. On the new branch: **Connect** → copy two connection strings into your password manager:
   - **pooled** (host contains `-pooler`) → used by the app on Vercel;
   - **direct** (pooling off) → used only by the manual migration commands below.

## 2. Vercel — staging variables (Project › Settings › Environment Variables)

For each variable: **Environment = Preview**, **Git branch = `dev`** (the "Preview (dev)" scope).

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon `dev` **pooled** URL |
| `JWT_SECRET` | a NEW random value (`openssl rand -hex 32`) — never the production one |
| `CRON_SECRET` | a NEW random value (staging crons are called by hand) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | the same values as production |
| `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` | the same as production, if Sentry is set up (events arrive as environment `preview`) |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | a STAGING key pair (`npx web-push generate-vapid-keys`) + `https://dev.homeshare.fernandorffdev.com` — all three or none |

Today (2026-10-07) `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `POSTGRES_*` and `PG*` come from the Neon integration
for **All Environments** (production database), `JWT_SECRET` exists for Production and Development only, and
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` for Production only. A Preview (`dev`) value overrides the All
Environments one for that branch; the app reads only `DATABASE_URL`. If Vercel refuses a second `DATABASE_URL`
("already exists"), tell Claude before changing the integration's variables.

## 3. Vercel — staging domain

Project › Settings › **Domains** › Add Existing › `dev.homeshare.fernandorffdev.com` → Connect to an environment:
**Preview**, Git branch **`dev`** (only after `dev` exists on GitHub). DNS (done, Cloudflare): CNAME
**`dev.homeshare`** → `cname.vercel-dns.com`, **DNS only** (the record name inside the `fernandorffdev.com` zone).

## 3b. Vercel — Deployment Protection must NOT cover the staging domain

Checked 2026-10-07: Vercel Authentication ("Require Log In") is already **off** on this project — nothing to do.

Under Vercel's default **Standard Protection**, a custom domain assigned to a non-production branch (our
`dev.homeshare.fernandorffdev.com`) sits behind Vercel Authentication: staging would show Vercel's login wall before
the app, breaking the app's own login, the PWA install, push, the Google callback and the cron `curl`. Decision 9 is
"app login only". Project › Settings › **Deployment Protection** › **Vercel Authentication**: either turn it **off**
(only `main` and `dev` deploy now, so there are no stray previews to hide), or — if your plan offers it — add
`dev.homeshare.fernandorffdev.com` as a **Deployment Protection Exception**. Check after the first deploy: opening the
staging URL in a private window shows the Home Share login, not Vercel's.

## 4. Vercel — only `main` and `dev` deploy

Nothing to click: the repo's `vercel.json` now has `"ignoreCommand": "node scripts/vercel-ignore-build.mjs"`,
which skips every branch except `main` and `dev`. Check Project › Settings › Git › **Ignored Build Step** is not
overriding it (leave it on "Automatic" / empty).

## 5. Google — staging redirect URI

Google Cloud Console › APIs & Services › Credentials › the existing OAuth client › **Authorized redirect URIs** ›
add `https://dev.homeshare.fernandorffdev.com/api/auth/google/callback` (keep the production one).
Done 2026-10-07: project **Home Share** (`home-share-501623`, Google account fernandorffdev), client "Home Share Web".

## 6. Local PC — stop pointing at production

1. Save the current `.env` / `.env.local` content (production URL and secrets) into your password manager, then
   **delete `.env`** and replace `.env.local` with a copy of `.env.example` (local Docker URL). Both Next.js and the
   Prisma CLI read `.env.local` first and `.env` after it — an old `.env` left with the production URL would still be
   picked up for any variable `.env.local` doesn't set.
2. `docker compose up -d` (Postgres on `localhost:5433`, db `homeshare_dev`) → `npm run db:migrate` → `npm run dev`.

## 7. Tell Claude "painéis prontos"

Claude then commits on `feat/ui-loop-and-pocs`, creates `dev` from `main`, pushes both and opens the PR
`feat/ui-loop-and-pocs → dev`, and follows the CI.

## 8. Staging schema (before merging the PR into `dev`) — the rehearsal

PowerShell, from the repo root on the `feat/ui-loop-and-pocs` checkout, Neon `dev` **direct** URL:

```
$env:DATABASE_URL = "<neon dev DIRECT url>"
git show main:prisma/schema.prisma > "$env:TEMP\schema.main.prisma"
npx prisma migrate diff --from-config-datasource --to-schema "$env:TEMP\schema.main.prisma" --exit-code
```

0. **Pre-check:** exit code **0** = the database matches the schema on `main`, which is exactly what `0_init`
   describes → safe to baseline. Exit 2 = drift: stop and send Claude the printed summary.
1. **Baseline** (the database already has the schema `0_init` describes — it is a copy of production):
   `npx prisma migrate resolve --applied 0_init`
2. **Apply the new migration:** `npx prisma migrate deploy` → applies only `1_pocs_008_010`
   (4 `CREATE TYPE`, 1 `ADD COLUMN "recurringExpenseId"`, 5 `CREATE TABLE`, 10 indexes, 11 foreign keys — no DROP).
3. **Check:** `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` → exit 0.
4. `Remove-Item Env:DATABASE_URL`

Then merge the PR into `dev` → staging deploys at `https://dev.homeshare.fernandorffdev.com`.

## 9. Staging smoke test

- Log in (password and Google), expenses list, balances.
- Recurring: create a rule due today → posted + ↻; cron by hand:
  `curl -i -H "Authorization: Bearer <staging CRON_SECRET>" https://dev.homeshare.fernandorffdev.com/api/cron/recurring-expenses`
  (and `/api/cron/notifications`) → 200 with counts; a second run posts 0.
- Install the app (Android Chrome and iPhone Safari › Share › Add to Home Screen) → opens full screen.
- Push: Notices › Preferences › Receive on this device → test notice arrives; a second account adds an expense →
  notification without the amount; tap opens the right house.
- `curl -I https://dev.homeshare.fernandorffdev.com/expenses` shows `x-robots-tag: noindex, nofollow`.

## 10. Production (after the PR `dev → main` is approved) — same commands, production DIRECT URL

pre-check against `main`'s schema (exit 0) → `migrate resolve --applied 0_init` → `migrate deploy` →
`migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` (0), **before** merging into `main`
(the new code reads tables that only exist after `1_pocs_008_010`). Then set the production-only variables (production `CRON_SECRET`, production VAPID pair — all
three or none) and merge. Details and production checks: the `owner-actions.md` of POCs 008, 009 and 010.

From then on every schema change ships as a new folder in `prisma/migrations` (created locally with
`npx prisma migrate dev --name <change>` against the local Docker DB), applied with `npm run db:migrate`
on staging first, then production. CI fails a PR whose `schema.prisma` changed without a matching migration
(`prisma migrate diff --from-migrations … --exit-code` against a throwaway Postgres service).
