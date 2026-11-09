# Rust server (Axum) with precomputed balances — Requirements

## Problem

The Balances pilot (spec 012, branch `pilot/balances-rust`, commits `6e9460c..6fe51bc`, report
<https://claude.ai/artifact/65SrmaLYuzDUS7JeiqYo2N>) measured the same `GET /api/balances` across
TypeScript (Next and Bun), Go and Rust on a seeded database (large house: 100,000 expenses).
Measured there, not projected:

| Variant | 1 user p50 | 1,000 connections (ok/s) | Server memory |
|---|---|---|---|
| Next today | 632 ms | 0 (connections refused) | 640 MiB |
| Next + precomputed + cache | 2.9 ms | 379 | 310 MiB |
| Rust (Axum) + precomputed + cache | 0.8 ms | 6,914 | 4.7 MiB |

On 2026-11-09 Fernando chose: the whole server moves to **Rust (Axum) with precomputed balances and a
per-house version cache**, in **one spec**, running as **one always-on Rust process that serves both
the API and the web app** (same origin). The React UI stays. These numbers are pilot measurements for
one route on a long-running container; for every other route they are a projection, not a result.

## User story

As a member of a house, I want every screen to answer as fast and as reliably as the pilot's Balances
did, so that the app stays quick with years of expenses and many people at once.

## Acceptance criteria (EARS)

### Parity (the gate)

1. WHEN the parity gate runs every API route of the Next app and of the Rust server against the same
   database with the same cookies, THE SYSTEM SHALL return the same status and a deep-equal JSON body
   (ignoring only `Date`/`ETag` headers and server-generated ids/timestamps listed in the gate) for each
   of the 51 route handlers under `src/app/api/**`, including the middleware's 401 body
   `{ error: 'Not authenticated' }` (no `code`, `src/middleware.ts:43`).
2. WHEN the gate runs a write route (POST/PATCH/PUT/DELETE), THE SYSTEM SHALL leave both databases with
   identical rows in every table touched, including `AuditLog` and `Notification`; `EntityRevision`
   `before`/`after` JSON is compared as normalized JSON (same keys and values, key order free).
3. WHEN any route answers an error, THE SYSTEM SHALL send the same `code` and status as the Next route
   (namespaces `ApiErrors`/`CsvErrors`), so the client's `useApiError` translations keep working.
4. WHILE serializing money, THE SYSTEM SHALL send `amount`/`participant.amount` as strings and balances
   as numbers, exactly as today (ADR 0003).

### Precomputed balances and cache

5. WHEN any expense, participant or settlement is inserted, updated, moved to another house or deleted
   (single write, CSV import via `createMany`, recurring posting, bulk delete), THE SYSTEM SHALL keep the
   precomputed totals equal to a live `SUM` over the same rows (checked by the `check.sql` matrix).
6. WHEN a user's name changes, THE SYSTEM SHALL bump the version of every house that user is in, so the
   next `GET /api/balances` is recomputed. (Membership changes need no bump: the response only names
   payers and participants, `src/services/balance.service.ts:25-33`, and membership is checked before the
   cache is read.)
7. WHEN `GET /api/balances` carries an `If-None-Match` equal to the current version, THE SYSTEM SHALL
   answer `304` with no body.
8. WHEN the large seeded house is read with 1,000 connections on the target host, THE SYSTEM SHALL
   answer at least 1,000 correct responses per second (floor well below the pilot's 6,914 on a laptop).

### Auth, session and house (ADRs 0001, 0002, 0013)

9. WHEN a request carries no `homeshare_session`, an invalid/expired JWT, or a revoked
   `sessionVersion`, THE SYSTEM SHALL answer 401 on `/api/*` and redirect pages to `/auth/login`,
   with the same cookie-clearing behavior as today.
10. WHEN a page request arrives with a session older than one day, THE SYSTEM SHALL re-sign the cookie
    for 30 days (sliding session), never on `/api/*`.
11. WHEN login, register, set-password or the Google callback succeed, THE SYSTEM SHALL set the same
    httpOnly cookie a Next-signed session uses, so a cookie signed by either server is accepted by both.
12. WHILE resolving the active house, THE SYSTEM SHALL take it from the `homeshare_group` cookie,
    confirm membership in the database, and never read `groupId` from the body.

### Cross-cutting behavior

13. WHEN an entity is written, THE SYSTEM SHALL write the same `EntityRevision` row the Prisma audit
    extension writes today (ADR 0005), with sensitive fields recorded as changed, never their value
    (ADR 0012), and explicit revisions where ADR 0009 requires them.
14. WHEN a write carries a stale expected-state token, THE SYSTEM SHALL answer 409 as today (ADR 0006).
15. WHEN a scheduled job is due (recurring expenses, notifications), THE SYSTEM SHALL run it in-process
    once a day with the same idempotent reconciliation and unique-key claims (ADR 0010); a duplicate or
    missed run SHALL neither double-post nor skip a month.
16. WHEN a push is sent, THE SYSTEM SHALL use the same VAPID keys and payload as today (ADR 0011).
17. WHEN a route is rate-limited today (`lib/rate-limit`), THE SYSTEM SHALL apply the same limits.
18. WHEN a handler fails, THE SYSTEM SHALL report to Sentry with the same privacy defaults (ADR 0008),
    and the browser SDK SHALL keep reporting through the same-origin `/monitoring` tunnel, now proxied by
    the Rust server.

### Web app served by the same process

19. WHEN any page path is requested, THE SYSTEM SHALL serve the exported React app from the Rust
    process (same origin, no CORS code anywhere), with the same CSP and security headers as
    `next.config.ts`, the old Portuguese-path redirects, and `/` redirecting to `/expenses`
    (today a server `redirect()` in `src/app/page.tsx`).
20. WHEN a page loads, THE SYSTEM SHALL apply the theme and locale from their cookies in the browser
    before first paint (today they are read on the server in `src/app/layout.tsx`).

### Operations

21. WHEN the server starts, THE SYSTEM SHALL refuse to start if a required variable is missing
    (database URL, session secret; VAPID all-or-none), naming the variable, never its value.
22. WHEN `GET /api/health` is called, THE SYSTEM SHALL answer 200 with the same body as today.

### Side by side, for good (Fernando, 2026-11-09)

23. WHILE the Rust server serves the main URL, THE SYSTEM SHALL keep the Next app deployed and working
    on the same host name with `-next` appended to its first label (e.g. `homeshare-next.…`), against the
    **same database**, so both can be compared in the portfolio.
24. WHEN either server writes, THE SYSTEM SHALL keep the precomputed totals and the version cache correct
    for both (they live in the database triggers, not in either server).
25. WHILE both run, THE SYSTEM SHALL run the scheduled jobs only on the Rust server (Vercel crons removed),
    and SHALL place the Rust server for the lowest latency to the database; the Next deploy takes no
    setting that slows the Rust one.

## Out of scope

- Changing any screen, copy or behavior visible to the user.
- Leptos or any other Rust UI (the pilot measured React faster on the large house).
- Mobile packaging (Capacitor/Tauri) — separate decision.
- Replacing Prisma as the **schema** tool: `prisma/migrations` stays the only migration source.

## Open questions

- **Host.** One always-on container close to the Neon database (São Paulo). Candidates: Cloud Run
  `southamerica-east1` (billing currently closed), Fly.io `gru`, others. Decide with prices read from
  the official pricing pages and one measured run of criterion 8 on each finalist.
