# Observability with Sentry — Requirements

## Problem

Production failures are invisible today: route handlers swallow unexpected errors into a generic 500
plus a `console.error` that lives only in Vercel's short-retention runtime logs, client crashes are
not recorded at all, and nobody can see latency, database time or Web Vitals. The owner wants one
"system dashboard" (decided: Sentry) without leaking housemates' personal data (LGPD).

## User story

As the app owner, I want server errors, client crashes, latency, database time and Web Vitals in a
Sentry dashboard — with no personal data in it — so that I notice and fix problems before housemates
report them.

## Acceptance criteria (EARS)

Each criterion must be verifiable by a test (or a single curl) in ~10 seconds.

1. WHEN `SENTRY_DSN` (server/edge) or `NEXT_PUBLIC_SENTRY_DSN` (browser) is unset or blank, THE SYSTEM
   SHALL NOT call `Sentry.init` in that runtime.
2. WHEN neither DSN is set at build time, THE SYSTEM SHALL export the Next config without
   `withSentryConfig`; WHEN a DSN is set, IF `SENTRY_AUTH_TOKEN` is absent, THE SYSTEM SHALL wrap it with
   source maps disabled (`sourcemaps.disable: true`), and IF the token is present, with upload enabled.
3. WHILE the SDK is initialized, THE SYSTEM SHALL pass an explicit restrictive `dataCollection`
   (`userInfo`, `cookies`, `urlQueryParams`, `databaseQueryData`, `queues`, `stackFrameVariables` all
   `false`; `httpBodies: []`; GenAI and GraphQL capture off; request headers allowlisted to
   `user-agent`, `content-type`, `content-length`, `accept-language`).
4. WHEN an error event is about to be sent, THE SYSTEM SHALL remove request cookies, bodies, `env` and
   query strings, keep only allowlisted request headers, reduce `user` to `{ id }`, strip query strings
   from breadcrumb URLs, replace values of sensitive keys (cookie, authorization, password, token,
   secret, jwt, joinCode, email, …) with `[Filtered]`, redact e-mails, `homeshare_session` /
   `homeshare_group` cookie values, bearer tokens, JWTs and request-body fragments echoed by JSON parse
   errors in every string, and reduce Prisma client error messages to their final reason line (their
   invocation dump can contain names and amounts).
5. WHEN a span is about to be sent, THE SYSTEM SHALL strip query strings from its name and URL
   attributes, drop cookie/authorization/query/user-identifying/client-address attributes, and redact
   e-mails in the remaining string attributes.
6. WHEN a route handler's error reaches `handleApiError` and is not an `ApiError` or is an `ApiError`
   with status ≥ 500, THE SYSTEM SHALL answer exactly as before (generic `{ error }` 500, or the
   ApiError's own message/code/status), capture exactly one Sentry exception tagged `route`,
   `http_status`, `api_error_code` (when present) and `request_id`, and write exactly one JSON error log
   line carrying the same `requestId`/`route`/`status`, `durationMs` and the Sentry event id.
7. WHEN the error is an `ApiError` with status < 500, THE SYSTEM SHALL answer exactly as before and
   SHALL NOT capture a Sentry event or write a log line.
8. WHEN `requireSession` succeeds, THE SYSTEM SHALL set the Sentry user to `{ id: <user publicId> }`;
   WHEN `requireActiveGroup` resolves a house, THE SYSTEM SHALL tag events `house=<house publicId>`;
   WHILE the client session is loaded, THE SYSTEM SHALL set the same user id and house tag in the
   browser SDK. Names, e-mails and amounts SHALL never be set as user data or tags.
9. WHEN server code calls the logger, THE SYSTEM SHALL write exactly one JSON line (`time`, `level`,
   `msg`, the defined fields such as `requestId`, `route`, `status`, `durationMs`, and a serialized
   error with e-mails redacted) to the console sink of that level, and add a Sentry breadcrumb with the
   same message and fields.
10. THE SYSTEM SHALL contain no `console.log/warn/error` call in `src/` outside `src/lib/logger.ts`
    (tests and generated code excluded).
11. WHEN the middleware lets a request through, THE SYSTEM SHALL set `x-homeshare-request-id` (Vercel's
    `x-vercel-id`, else a random UUID), `x-homeshare-path` and `x-homeshare-start` request headers,
    overwriting client-supplied values; THE middleware matcher SHALL NOT match `/monitoring`.
12. WHILE the SDK is enabled, THE SYSTEM SHALL route browser envelopes through the same-origin tunnel
    `/monitoring`, leaving the production CSP `connect-src 'self'` unchanged.
13. WHEN a rendering error reaches the root, THE SYSTEM SHALL show a GlobalError screen in the
    visitor's locale (`locale` cookie; en/pt/es/fr, default en) with a reload button, and capture the
    error.
14. WHILE tracing, THE SYSTEM SHALL sample at `SENTRY_TRACES_SAMPLE_RATE` /
    `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` when it is a number in [0, 1], else 0.1 in `production` and
    1.0 in any other environment; THE SYSTEM SHALL NOT send `/api/health` spans; THE SYSTEM SHALL emit
    database spans for Prisma queries with no change to `prisma/schema.prisma`.
15. THE repository SHALL contain `docs/observability/sentry-dashboard.json` with widgets for errors by
    route, top error codes on 5xx, p95 latency by route, DB query p95, LCP, INP, CLS, crash-free
    sessions/users and transactions per minute, and `scripts/sentry-dashboard.mjs`, which creates or
    updates that dashboard reading credentials only from `process.env` (never from env files) and
    supports `--dry-run` without credentials or network.
16. THE repository SHALL document the owner setup in Portuguese (`docs/observability.md`, naming every
    Sentry env var the code reads) and the decision in ADR `docs/decisions/0008-observability-sentry.md`.

## Out of scope

- Session Replay, profiling, Sentry Logs (`Sentry.logger`), user feedback widget.
- Alert rules and uptime/cron monitors as code (the owner may add alerts in the Sentry UI; the doc
  suggests one).
- Reporting best-effort audit-write failures as issues — they are logged (JSON line + breadcrumb) only.
- The Google OAuth callback's swallowed errors (redirect to login) and the `/api/health` 503 path.
- Mapping malformed JSON bodies (`request.json()` SyntaxError → today a 500) to 400 — they will start
  showing up as Sentry issues; fixing that is a separate change.
- Per-route custom spans or a request wrapper for every handler.

## Open questions

None — owner decisions are final (Sentry; dashboard lives in Sentry; the owner creates the project and
sets the Vercel env vars).
