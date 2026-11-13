# Host: one always-on Fly machine in São Paulo, Neon in São Paulo, Cloudflare proxy in front

- Status: accepted
- Date: 2026-11-13 (records decisions made on 2026-11-10 and 2026-11-11)
- Closes the "Host" open question of [spec 013](../specs/013-rust-server/requirements.md); complements
  [0014](0014-rust-only-repo-single-branch-ci-deploy.md), which takes this hosting as given

**Decision:** Production runs as one always-on Fly.io machine in `gru` (shared 1 CPU, 256 MB, `fly.toml`), talks to
a Neon Postgres in São Paulo (`aws-sa-east-1`, Free plan, created through the Vercel integration), and is reached
only through Cloudflare's proxy (SSL Full strict, one rate-limiting rule on `/api/`).

## Context and Problem Statement

Spec 013 replaced the Next.js app on Vercel with a Rust/Axum server that serves the API and the web app. It needed
one long-running process (in-memory cache, in-process daily timers) close to the database. On 2026-11-10 the
production database turned out to be in Washington D.C. (`iad1`), not São Paulo, while both users are in Brazil.
Neon cannot move an existing project to another region.

## Decision Drivers

- Latency for two users in Brazil: server and database in the same region, near them.
- A predictable bill with no surprise: the owner did not want a pay-per-request host without a hard cap.
- One process that stays up (the cache and the daily timers live in memory).
- Same protection as the Next app had on Vercel (DDoS, a rate limit) in front of a 256 MB origin.

## Considered Options

1. **Fly.io `gru` machine, always on + Neon São Paulo + Cloudflare proxy (chosen).**
2. Google Cloud Run `southamerica-east1` — ❌ needs a Google billing account; the owner declined to open one
   (2026-11-10). A budget there only alerts, and two instances at worst case were estimated at about US$183/month.
3. Postgres on Fly (Fly Managed Postgres, from US$38/month, or a self-run Postgres machine) — ❌ cost and upkeep
   against a free Neon in the same city (2026-11-10).
4. Keep the Washington database and only move the server — ❌ every query would cross the continent; measured on
   2026-11-11, the Next app with its function in `iad1` and the database in São Paulo averaged 902 ms p50 over 9
   signed-in routes, against 134 ms with both in São Paulo.
5. Rust as Vercel functions — ❌ rejected in spec 013 (never measured, beta, the in-memory cache dies with the
   function).
6. No Cloudflare proxy (DNS only, straight to Fly) — ❌ the proxy adds about 78 ms p50 (measured 2026-11-11: 180 ms
   through Cloudflare vs 102 ms direct, average of 9 signed-in routes), but the owner chose to keep the same DDoS and
   rate-limit protection the Next app had (2026-11-11).

## Decision Outcome

Option 1.

- Data moved to a new Neon project, `home-share-db-sp` (São Paulo, PG 18). It was rehearsed with the staging copy on
  2026-11-10 (row counts equal) and production was switched on 2026-11-11. The Washington project stays as a backup.
- Measured on 2026-11-10, Fly `gru` + Neon São Paulo, load generated from a home PC:
  - database keep-alive median: 66 ms;
  - without the database: 2,848 req/s at 200 connections (p99 97 ms);
  - with the database: 669 req/s at 50 connections (p99 141 ms);
  - at 1,000 connections: 3,548 req/s without the database (1.4 % timeouts) and 766 req/s with it (5 % timeouts).
- Criterion 8 of spec 013 ("the large seeded house read with 1,000 connections, at least 1,000 correct responses per
  second") was **not run as written**: there was no large seeded house on the target host, and the 1,000-connection
  run above used real data from one home connection. Revisit it if the app gains users.
- Measured on 2026-11-11: the Fly VM used 55 MB on average (210 MB at peak) over 24 h, the server process about 4 MB.
- `fly.toml`: `auto_stop_machines = "off"`, `auto_start_machines = false`, one machine.
- Neon Free plan: 100 CU-hours per project per month and scale-to-zero after 5 idle minutes, which cannot be turned
  off on that plan (https://neon.com/pricing, https://neon.com/docs/introduction/scale-to-zero). The database sleeps
  when nobody uses it: the first request after a pause took 1.6 s against 0.4 s warm (2026-11-13). A keep-warm ping
  was removed for that reason (it would exceed the allowance and suspend the database).
- Cloudflare: proxied `A` record for `homeshare.fernandorffdev.com` to the Fly app, SSL Full strict, and one rule
  "Flood guard - prod API per IP": more than 100 requests in 10 s to `/api/` from one IP → blocked for 10 s.
  Tested on 2026-11-12: sustained load was blocked after about 100 requests; a single instant burst of 150 passed.

### Consequences

- Good: server and database in the same city; one fixed-size machine; no Google billing account.
- Good: the deploy is one command in CI (`flyctl deploy --remote-only`, see 0014), and `flyctl releases` plus
  `flyctl deploy --image <previous>` roll back.
- Bad: one machine is a single point of failure, with no second region and no staging (0014).
- Bad: the Neon Free plan sleeps after 5 minutes, so the first request after a pause is about a second slower. If
  usage grows past the 100 CU-hours, Neon suspends the database until the next billing period: watch the usage
  page before adding anything that keeps it awake.
- Bad: the Cloudflare proxy adds about 78 ms to each request in exchange for the protection.

### Confirmation

- `fly.toml` (`primary_region = "gru"`, always-on settings) and the CI deploy job's live check of
  `https://homeshare.fernandorffdev.com/api/health?db=1` after every deploy (`.github/workflows/ci.yml`).
- The database region is not checked by code: confirm in the Neon console (`home-share-db-sp`, AWS São Paulo).
