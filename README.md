# Home Share

🌐 **English** · [Português](README.pt-BR.md) · [Español](README.es.md) · [Français](README.fr.md)

Shared household expenses: log spending, split it between housemates (**equally**,
**by amount**, or **with a % slider**), and see **who owes whom**. Includes a shopping
list, payment platforms, and multi-household support.

**🔗 Live:** https://home-share-app-xi.vercel.app

A **retro editorial mono** interface (receipt/ledger aesthetic): monospaced, tabular
numbers, dotted rules, and a single "stamp" accent. Mobile-first, with staggered
entrance animations and loading skeletons (respecting `prefers-reduced-motion`).

## Features

- **Auth** — username/password + **Google sign-in**, session via **httpOnly cookie**
  (JWT). First-access flow for legacy users (set password).
- **Households** — create / join with a 6-character code, ADMIN/MEMBER roles, switch household.
- **Expenses** — create/edit/delete, split **equally / by amount / by %** (exact cents),
  bulk selection, **CSV import/export**, sorting and pagination.
- **Balances** — who owes whom, with the minimal set of transfers to settle up.
- **Shopping list** and **payment platforms** (with reassignment on delete).

## Stack

- **Next.js 16** (App Router) + **React 19** — monolith: frontend and API in one app, same-origin
- **Tailwind v4** + Radix primitives · **Space Mono** / **JetBrains Mono** fonts
- **Prisma 7** (`@prisma/adapter-pg`) + **PostgreSQL** (Neon)
- **jose** (JWT) · **bcryptjs** · **Vitest**

## Run locally

```bash
docker compose up -d          # local Postgres 16 (container homeshare-dev-pg, localhost:5433)
cp .env.example .env.local    # DATABASE_URL already points at it; set JWT_SECRET
npm install
npm run db:migrate            # apply prisma/migrations (prisma migrate deploy)
npm run dev                   # http://localhost:3000
npm run test                  # vitest (self-contained: in-process Postgres, no Docker needed)
```

`.env.local` points only at the local database. Production and staging database URLs live
only in Vercel, never in a local file — delete (or empty) any old `.env`: Next.js and the
Prisma CLI both read it for anything `.env.local` doesn't set.

Schema changes: edit `prisma/schema.prisma`, run `npx prisma migrate dev --name <change>`
against the local database and commit the new folder in `prisma/migrations` — CI fails when
the schema changes without a migration. `npm run db:reset` recreates the local database and
re-applies every migration.

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | Postgres (Neon) |
| `JWT_SECRET` | yes in production | session signing secret |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | no | enables Google sign-in. Redirect: `<origin>/api/auth/google/callback` |

## Authentication

Session via **httpOnly cookie** (`bolitas_session`, JWT HS256) — the client never sees
or stores a token. The **active household** lives in a separate cookie (`bolitas_group`);
to switch, `POST /api/groups/active`. Being same-origin, there's no CORS. Google sign-in
reuses the same session cookie.

Money is handled in **integer cents** (`src/lib/currency`) to avoid floating-point
drift; splits always sum exactly to the total.

## Structure

```
src/
├── app/
│   ├── api/**       # route handlers (auth[+google], groups, expenses, balances, platforms, shopping-items, health)
│   ├── auth/**      # public pages: login, register, set-password
│   └── (app)/**     # logged-in area: expenses, balances, shopping, platforms, household
├── components/      # ui/ (retro-mono design system) · app/ · expenses/ · auth/
├── lib/             # auth, api (client), session, currency, balance, format, members, ...
└── services/        # auth, group, expense, platform, shopping-item
prisma/              # schema + config
```

## Deploy

Hosted on **Vercel** with a **Neon** database. Two environments, one Vercel project:

- **Production** — branch `main`, Neon's main branch.
- **Staging** — branch `dev`, at https://dev.homeshare.fernandorffdev.com (Vercel Preview
  env vars scoped to `dev`), with its own Neon branch `dev` (a copy of production, reset on
  demand).

Only `main` and `dev` deploy (`scripts/vercel-ignore-build.mjs`, the `ignoreCommand` in
`vercel.json`); every other branch runs only the GitHub CI. Flow: feature branch → PR into
`dev` (merging updates staging) → test on staging → PR `dev` → `main`.

- **Build** — `prisma generate && next build`; it never touches a database.
- **Schema** — versioned SQL in `prisma/migrations`, applied by hand with
  `prisma migrate deploy`, **staging first, then production**. Pass the target's URL (Neon's
  direct, non-`-pooler` string) in the shell for that one command, never in a file:
  `DATABASE_URL="<url>" npm run db:migrate` (`npm run db:migrate:status` to check).
- **Crons** (`vercel.json`) run only in Production. On staging, call them by hand with
  staging's `CRON_SECRET`:
  `curl -H "Authorization: Bearer $CRON_SECRET" https://dev.homeshare.fernandorffdev.com/api/cron/recurring-expenses`
  (same for `/api/cron/notifications`).
- Every non-production environment answers `X-Robots-Tag: noindex, nofollow`.

## Design explorations

The [`design-samples/`](design-samples) folder holds 7 visual directions explored
before settling on retro editorial mono (cozy/clay, candy, dark fintech, glassmorphism,
neo-brutalist, bauhaus, retro mono). Open `index.html` to compare.
