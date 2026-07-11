# Next.js same-origin monolith, not a separate frontend + API

- Status: accepted
- Date: 2026-07-11 (backfilled — decision predates this record)

**Decision:** frontend and API live in one Next.js App Router app, same-origin. Route
handlers under `src/app/api/**` are thin (validate → call service → respond); business
logic lives in framework-agnostic `src/services/**`. There is **no CORS code anywhere** —
its absence is the guarantee that no cross-origin surface exists.

## Context and Problem Statement

An earlier iteration ran a standalone API separate from the frontend. Two codebases,
two deploys, CORS between them, and Bearer-token plumbing — for an app whose only client
is its own web frontend. Where should the API live?

## Decision Drivers

- Exactly one consumer of the API: the app's own frontend.
- Cookie-based auth (see [ADR-0001](0001-httponly-cookie-session-auth.md)) is dramatically
  simpler same-origin — no CORS-with-credentials matrix.
- One person maintains this: one repo, one deploy, one place to look.

## Considered Options

1. **Next.js monolith, same-origin** — ✅ chosen.
2. Separate SPA + API service (the previous shape) — ❌ CORS + credentialed-cookie
   complexity, duplicated models/validation across repos, and two deploys to keep in sync,
   all for a second consumer that doesn't exist.
3. Next.js frontend + separate API behind a reverse-proxy rewrite (pseudo same-origin) —
   ❌ keeps the operational split (two services) while only hiding the origin problem.

## Decision Outcome

The services layer keeps the monolith honest: handlers stay thin, services stay
framework-agnostic, so extracting a real API service later is a refactor, not a rewrite.
The client talks to the API through the `lib/api` wrapper (cookies flow automatically).

### Consequences

- Good: zero CORS code, zero token plumbing, one deploy (Vercel), shared types between
  front and back by construction.
- Good: middleware gates pages and API with the same session cookie.
- Bad: front and back scale/deploy as one unit; a hot API path can't be scaled alone.
- Bad: a future non-browser client (mobile/CLI) needs a new auth path and likely an
  extracted API — accepted until such a client exists (same bet as ADR-0001).

### Confirmation

- Absence check: no `Access-Control-Allow-*` headers and no CORS middleware in `src/`.
- Structure check: route handlers in `src/app/api/**` contain no Prisma calls — services
  do ([src/services](../../src/services)).
