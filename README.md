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
cp .env.example .env      # fill in DATABASE_URL and JWT_SECRET
npm install
npx prisma db push        # create the schema in the database
npm run dev               # http://localhost:3000
npm run test              # vitest (currency, balance, csv-parser, auth)
```

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

Hosted on **Vercel** with a **Neon** database (integration). The build runs
`prisma generate && next build` — the schema is applied deliberately with
`prisma db push` (not in CI). Two environments: **Production** (`main` branch) and
**Preview** (branches/PRs).

## Design explorations

The [`design-samples/`](design-samples) folder holds 7 visual directions explored
before settling on retro editorial mono (cozy/clay, candy, dark fintech, glassmorphism,
neo-brutalist, bauhaus, retro mono). Open `index.html` to compare.
