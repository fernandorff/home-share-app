# Agent guide — Home Share

Shared-household expense app: Next.js App Router monolith (frontend + API same-origin),
Prisma/Postgres, cookie-based auth, money as integer cents.

- **Conventions & invariants:** [CLAUDE.md](CLAUDE.md) — the canonical instruction file.
- **Why the architecture is the way it is** (incl. rejected alternatives): [docs/decisions/](docs/decisions/README.md).
- **Feature specs** (non-trivial changes): [docs/specs/](docs/specs/README.md).

Gates before claiming anything works: `npx tsc --noEmit` · `npm run test` (vitest, boots
its own in-process Postgres — no Docker needed) · `npx next build`.
⚠️ Never run `npm run build` locally — it executes `prisma db push` against the real database.
