# Rust/Axum on Fly is the only app; one branch, and a merge to it deploys

- Status: accepted
- Date: 2026-11-12
- Supersedes [0004](0004-nextjs-same-origin-monolith.md) (the Next.js monolith) and the hosting part of
  [0010](0010-scheduled-jobs-vercel-cron.md) (the daily jobs now run on timers inside the Rust server,
  `server/src/routes/jobs.rs`, still behind the same idempotent reconciliation)

**Decision:** This repository holds only the Rust/Axum server (`server/`) and the React web app it serves, built by
Vite (`src/`). The Next.js app moved, with its whole history, to the public repository
`fernandorff/home-share-next`. There is one branch, `main`: a PR runs the gates, and a merge applies pending
migrations to the production database, deploys to Fly and checks `/api/health?db=1`.

## Context and Problem Statement

Spec 013 moved production to the Rust server on 2026-11-11 (Fly, São Paulo; Neon, São Paulo; Cloudflare in front).
The repository still carried both apps: about half of `src/` (route handlers, services, Prisma client code) served
only the Next build, the CI tested only Next (the Rust tests ran nowhere), production was deployed by hand from a
laptop, and the `dev` branch fed a staging site that ran Next — so it never tested what production runs.

## Decision Drivers

- CI must test what production runs, and deploying must not depend on one machine.
- Fewer moving parts for a two-person household app: no branch to keep in sync, no environment that tests the
  wrong server.
- Keep the Next.js version readable and runnable as a reference.

## Considered Options

1. **Rust-only repo, single `main`, CI deploys (chosen).**
2. Keep both apps in one repo and only add Rust to CI — every change still has to keep a dead code path compiling.
3. A Rust staging app on Fly fed by `dev` — catches more before production, but doubles the hosting and the flow for
   two users; revisit if the app gains users.

## Decision Outcome

Option 1.

- Measured on 2026-11-12 before the move: all 16 branches besides `main` and the open PR were fully contained in
  `main` (`git cherry`), so deleting them lost no work.
- The web app keeps importing the router through `src/vite/shims/` (link, navigation) and i18n through `use-intl`
  directly; nothing imports `next/*` any more.
- Prisma stays only as the migration tool (`prisma/schema.prisma` + `prisma/migrations`, CI's
  migrations-match-schema check). Migrations must be **additive**: the deploy job applies them before the new
  server replaces the old one, so the old one runs against the new schema for a moment.
- Tests that needed the Next app left with it: the Playwright smoke test, the parity gate that compared Rust and
  Next responses (`server/gate`), and the service tests that ran against a real database — tenant isolation among
  them. `cargo test` covers the server with unit tests only, so authorization against a database has no automated
  check until a Rust integration suite exists; that is the first test debt to pay.
- `homeshare-next.fernandorffdev.com` stays on Vercel, deployed from that repository.

### Consequences

- Good: CI now runs `cargo test`; a merge to `main` is the whole release; the repo shows one stack.
- Bad: no staging — a migration or a server bug reaches production on merge. Mitigations: additive migrations, the
  live check after each deploy, and `flyctl releases` / `flyctl deploy --image <previous>` to roll back.
