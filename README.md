# Home Share

🌐 **English** · [Português](README.pt-BR.md) · [Español](README.es.md) · [Français](README.fr.md)

Shared household expenses: log spending, split it between housemates (**equally**,
**by amount**, or **with a % slider**), and see **who owes whom**. Includes a shopping
list, payment platforms, and multi-household support.

**🔗 Live:** https://homeshare.fernandorffdev.com

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

- **Rust / Axum** server (`server/`) — serves the JSON API (`/api/*`) and the web app, same-origin
- **React 19** web app built by **Vite** (sources in `src/`, routes via react-router) · i18n with use-intl (EN/PT/ES/FR)
- **Tailwind v4** + Radix primitives · **Space Mono** / **JetBrains Mono** fonts
- **PostgreSQL** (Neon) — the Rust server talks to it directly (tokio-postgres + deadpool); **Prisma** is kept only as the migration tool (`prisma/schema.prisma` + `prisma/migrations`)
- Tests: **Vitest** (web app) · `cargo test` (server)

The old Next.js version now lives at https://github.com/fernandorff/home-share-next.

## Run locally

```bash
npm run db:up                 # local Postgres 16 (Docker, localhost:5433)
cp .env.example .env.local    # read by `npm run db:migrate`
npm install
npm run db:migrate            # apply prisma/migrations
# terminal 1 — the Rust server (reads env vars from the shell, not from a file):
cd server && DATABASE_URL=postgresql://postgres:postgres@localhost:5433/homeshare_dev JWT_SECRET=dev-secret cargo run   # http://localhost:8080
# terminal 2 — the web app with hot reload; /api goes to the Rust server:
npm run dev                   # http://localhost:5173
```

Gates (the same CI runs): `npx tsc --noEmit` · `npm run lint` · `npm run test` · `npm run build` · `cargo test --manifest-path server/Cargo.toml`.

Schema changes: edit `prisma/schema.prisma`, run `npx prisma migrate dev --name <change>`
against the local database and commit the new folder in `prisma/migrations` — CI fails when
the schema changes without a migration. Migrations must be additive. `npm run db:reset`
recreates the local database and re-applies every migration.

### Environment variables

Read by the server from the environment (see `.env.example`).

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | Postgres (Neon) |
| `JWT_SECRET` | yes | session signing secret |
| `APP_ENV` | no | `production` is the only deploy search engines may index |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | no | enables Google sign-in. Redirect: `<origin>/api/auth/google/callback` |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | no | Web Push: set all three or none |
| `SENTRY_DSN` | no | error reporting |

The web app also gets `NEXT_PUBLIC_VAPID_PUBLIC_KEY` and `VITE_SENTRY_*` at build time (Docker `--build-arg`).

## Authentication

Session via **httpOnly cookie** (`homeshare_session`, JWT HS256) — the client never sees
or stores a token. The **active household** lives in a separate cookie (`homeshare_group`);
to switch, `POST /api/groups/active`. Being same-origin, there's no CORS. Google sign-in
reuses the same session cookie.

Money is handled in **integer cents** to avoid floating-point drift; splits always sum
exactly to the total.

## Structure

```
server/              # Rust (Axum) server
├── src/main.rs      # routes and layers
├── src/routes/      # one file per route group
└── src/             # auth.rs, house.rs, money.rs, db.rs, config.rs
src/                 # web app
├── vite/            # entry (main.tsx) and routes (routes.tsx)
├── app/auth/**      # public pages: login, register, set-password
├── app/(app)/**     # logged-in area: expenses, balances, shopping, catalogs, activity, house, settings, notifications, recurring
├── components/
├── lib/
└── messages/        # i18n (EN/PT/ES/FR)
prisma/              # schema + migrations
Dockerfile           # one image: Rust binary + Vite build
fly.toml
```

## Deploy

Production runs on **Fly.io** (app `home-share`, São Paulo), with a **Neon** database in
São Paulo and **Cloudflare** in front, at https://homeshare.fernandorffdev.com. There is no
staging environment.

One branch, `main`. Work on a short branch → PR to `main` (GitHub Actions `ci` runs the
gates) → merge = deploy: the `deploy` job applies pending migrations to the production
database (`prisma migrate deploy`), runs `flyctl deploy --remote-only`, then checks
`https://homeshare.fernandorffdev.com/api/health?db=1`.

There is no keep-warm ping: Neon's Free plan scales the compute to zero after 5 idle minutes, and keeping it awake all month would exceed the plan's 100 CU-hours. The first request after a pause takes about a second longer.
