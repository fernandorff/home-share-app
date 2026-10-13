# Observability via Sentry with privacy-first defaults

- Status: accepted
- Date: 2026-10-03

**Decision:** errors, traces, Web Vitals and release health go to Sentry through `@sentry/nextjs` (exact pin),
initialized only when a DSN is configured, with every data-collection category set explicitly to the
restrictive side and tested `scrubEvent` / `scrubSpan` hooks as the last gate; server logs are JSON lines from
`src/lib/logger.ts`.

## Context and Problem Statement

Unexpected server errors ended as a generic 500 plus a `console.error` kept only in Vercel's short-retention
runtime logs; client crashes were not recorded; there was no latency, database or Web Vitals view. The app
holds housemates' personal data (names, e-mails, shared expenses), so whatever observes it must not export that
data (LGPD). One person runs it on Vercel serverless + Neon.

## Decision Drivers

- Grouped server and client errors with readable stack traces and alerts — without building it.
- Latency per route, database time and Web Vitals in one dashboard.
- No personal data leaves the app, and that guarantee is testable.
- No new always-on infrastructure; works on serverless and keeps the strict CSP.
- Off by default in local/QA/CI: no env var, no change.

## Considered Options

1. **Sentry (`@sentry/nextjs`)** — ✅ chosen: errors + tracing + Web Vitals + release health in one SDK built for
   the App Router (instrumentation hooks, a tunnel for CSP/ad-blockers, source maps); the free tier fits.
2. In-app error table (Postgres `ErrorLog` + admin page) — ❌ records failures in the very database that is often
   the failing part, adds writes and storage on Neon, gives no tracing or Web Vitals, and the dashboard would have
   to be built and maintained.
3. Axiom — ❌ a strong log/event store, but issue grouping, source-mapped stack traces, release health and Web
   Vitals would have to be assembled on top of it.
4. Grafana Cloud (OpenTelemetry → Tempo/Loki + Faro) — ❌ the most moving parts (exporters, collector, frontend
   agent) for one maintainer on serverless; error tracking is not its core.
5. Logs only (JSON logs in Vercel) — ❌ short retention (hours to a day, depending on the plan), no grouping or
   alerting, nothing from the browser.

## Decision Outcome

`@sentry/nextjs@11.4.0`. `initSentry` runs only with `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN`; `next.config.ts`
applies `withSentryConfig` only when a DSN exists, uploading source maps only when `SENTRY_AUTH_TOKEN` exists.
`dataCollection` is fully explicit because v11 removed `sendDefaultPii` and collects cookies, bodies, database
query data and user info by default. `handleApiError` captures only server failures (non-ApiError or ApiError ≥
500); expected 4xx ApiErrors are not issues. Identity is opaque `publicId`s. Browser traffic uses the same-origin
tunnel `/monitoring`, leaving the CSP unchanged. The dashboard is code
(`docs/observability/sentry-dashboard.json` + `scripts/sentry-dashboard.mjs`).

### Consequences

- Good: errors, latency, database time, Web Vitals and crash-free rates in one place, with alerts.
- Good: privacy is enforced by configuration and by unit-tested scrubbers; a DSN-less build is unchanged.
- Bad: a third-party processor receives (scrubbed) telemetry — list it in the privacy notice if one is published.
- Bad: client bundle weight and a fast-moving major version to keep current (11.0.0 shipped 2026-09-23: exact
  pin, upgrade deliberately).
- Bad: dashboard field names track Sentry's evolving datasets; a renamed field needs a JSON edit and a script rerun.

### Confirmation

- `src/lib/observability/scrub.test.ts` — what may leave the app.
- `src/lib/observability/options.test.ts`, `init.test.ts`, `next-config.test.ts`, `src/instrumentation.test.ts` —
  env guard and restrictive options.
- `src/lib/api-helpers.observability.test.ts` — 5xx captured once, 4xx never.
- `src/lib/logger.test.ts` — JSON lines, and no ad-hoc `console.*` left in `src/`.
- `src/lib/observability/dashboard.test.ts` — dashboard coverage; the script reads `process.env` only.
