# Observability with Sentry — Design

## Approach

`@sentry/nextjs` **11.4.0** (pinned, exact) on all three runtimes, fully env-guarded, privacy-first.

- **Init.** `src/instrumentation.ts` (`register()`, server + edge) and `src/instrumentation-client.ts`
  (browser) call one helper, `initSentry(env)` (`src/lib/observability/init.ts`), which builds the
  options with the pure `buildSentryOptions(env)` (`src/lib/observability/options.ts`) and calls
  `Sentry.init` **only when a DSN is set**. `onRequestError = Sentry.captureRequestError` captures
  uncaught server-component / route / middleware errors; `onRouterTransitionStart =
  Sentry.captureRouterTransitionStart` gives navigation spans.
- **Build.** `next.config.ts` applies `withSentryConfig` (from `@sentry/nextjs/config` — the v11 entry
  point) **only when a DSN is present at build time**, so a build without Sentry env vars exports exactly
  today's config. Source-map upload is enabled only when `SENTRY_AUTH_TOKEN` exists
  (`sourcemaps.disable: !token`); `telemetry: false`; `tunnelRoute: "/monitoring"`.
- **Server errors.** `handleApiError` (the single catch of all 34 route files) becomes `async`: 4xx
  `ApiError`s are answered as today and never reported; everything else (non-ApiError, or ApiError ≥
  500) is answered as today **and** captured once (`captureServerError`) **and** logged once
  (`logger.error`), correlated by `requestId`. Call sites are untouched (`return handleApiError(...)`
  inside async handlers already returns a promise).
- **Context.** `requireSession` sets the Sentry user to `{ id: publicId }`; `requireActiveGroup`
  (membership query now also selects `group.publicId`) tags `house=<publicId>`. The client
  `SessionProvider` does the same in the browser. Opaque UUIDs only.
- **Request context.** The middleware already runs on every page/API request; on pass-through it now
  stamps `x-homeshare-request-id` (Vercel's `x-vercel-id`, else `crypto.randomUUID()`),
  `x-homeshare-path` and `x-homeshare-start`, always overwriting client values.
  `readRequestContext(await headers())` turns them into `{ requestId, route, durationMs }` with the
  route normalized (`UUID`/numeric segments → `:id`, low cardinality for dashboards).
- **Logging.** `src/lib/logger.ts` writes one JSON line per call (`time`, `level`, `msg`, fields,
  serialized error with e-mails redacted) to `console.log` / `console.warn` / `console.error` (Vercel
  keys log level off the stream) and adds a Sentry breadcrumb. It replaces the 5 ad-hoc `console.error`
  calls (`recordActivity` + `handleApiError` in `api-helpers`, both catches in `prisma-audit`, the
  toggle audit catch in `shopping-item.service`).
- **Client crashes.** `src/app/global-error.tsx` captures the error and renders a localized screen; the
  browser SDK's global handlers catch the rest.
- **Dashboard as code.** `docs/observability/sentry-dashboard.json` + `scripts/sentry-dashboard.mjs`
  (create-or-update by title through the Sentry API, `process.env` only).

Existing patterns kept: route handlers stay thin, services stay free of Next imports (the logger and
the SDK are framework-agnostic libraries), cookie auth (ADR 0001) and active-house rules (ADR 0002) are
read, never changed.

## Compatibility (verified 2026-10-03 against npm + the SDK's MIGRATION.md)

| Item | Requirement of `@sentry/nextjs@11.4.0` | This repo | OK |
| --- | --- | --- | --- |
| Next.js | peer `^14.0 \|\| ^15.0.0-rc.0 \|\| ^16.0.0-0` | 16.1.4 (Turbopack build) | ✅ |
| React | `@sentry/react` peer `17.x \|\| 18.x \|\| 19.x` | 19.2.3 | ✅ |
| Node | `>=20.19 <22 \|\| >=22.12 <23 \|\| >=23.2` | local 25.5; Vercel 20.x/22.x/24.x | ✅ |
| TypeScript | ≥ 5.0.4 | ^5 | ✅ |
| Prisma | `prismaIntegration` default-on; v6/v7 need **no** `previewFeatures`; v11 installs a global tracing helper that Prisma reads at runtime (driver adapters emit `prisma:client:db_query`) | Prisma 7.7 + `@prisma/adapter-pg`, `prisma-client` generator | ✅ no schema change |

v11 breaking changes this design accounts for: `sendDefaultPii` **removed** and replaced by
`dataCollection` whose defaults are now **permissive** (cookies, bodies, DB query data, user info) →
set explicitly; span streaming is the default → `beforeSendTransaction`/`ignoreTransactions` no-op →
scrub with `beforeSendSpan`, drop with `ignoreSpans`; scope tags are not copied to spans (error tags
still work); `withSentryConfig` moved to `@sentry/nextjs/config`; the tunnel route now passes through
the middleware → exclude it in the matcher; browser sessions hit by an uncaught error are recorded as
`unhandled` (not `crashed`), which flattens crash-free rates; Web Vitals are sent as spans. 11.0.0
shipped on 2026-09-23 — hence the exact pin. No blocker found.

## Data model

None. No Prisma schema or generator change (no `previewFeatures`), no migration.

## API contract

No endpoint, request or response shape changes; no new error codes.

- New internal request headers set by the middleware (never trusted from the client):
  `x-homeshare-request-id`, `x-homeshare-path`, `x-homeshare-start` (epoch ms).
- `/monitoring` exists only when Sentry is enabled: a `withSentryConfig` rewrite (with `o`/`p` query
  params) to the SaaS ingest host. The middleware matcher excludes it, so unauthenticated pages (login)
  can report too.

## Privacy (LGPD)

| Layer | Setting |
| --- | --- |
| SDK collection (`dataCollection`) | `userInfo: false`, `cookies: false`, `httpBodies: []`, `urlQueryParams: false`, `databaseQueryData: false`, `queues: false`, `stackFrameVariables: false`, `genAI`/`graphQL` off, headers allowlist (request: `user-agent`, `content-type`, `content-length`, `accept-language`; response: `content-type`, `content-length`) |
| `beforeSend` → `scrubEvent` | structural removals (cookies, body, env, query string, non-allowlisted headers, user → `{ id }`, breadcrumb URL queries; `PrismaClient*` exception values cut to their last line, because the "Invalid `prisma.x()` invocation" dump prints the query arguments) + deep walk (sensitive keys → `[Filtered]`, `redactText` on every string: e-mails, session/group cookie values, bearer tokens, JWTs, and the body snippet a JSON parse error echoes — `"not json a"... is not valid JSON`). Skips `sdkProcessingMetadata` (SDK-internal, never serialized, may hold live scope objects). |
| `beforeSendSpan` → `scrubSpan` | query strings stripped from name/URL attributes; cookie/authorization/`url.query`/`user.*`/`client.address` attributes dropped; `redactText` on string attributes |
| Identity | user = house member `publicId` (UUID); tag `house` = house `publicId` |
| Logs | e-mails redacted in error messages/stacks |
| Sentry project (owner, UI) | "Prevent storing IP addresses" on; default server-side data scrubbing on |

`scrubEvent` mutates and returns the event it receives (Sentry's documented `beforeSend` pattern):
deep-cloning would have to copy SDK-internal objects and a throwing `beforeSend` drops the event. It
is otherwise pure — no I/O, no SDK import (types only), idempotent.

## Tags and fields (what the dashboard queries)

| Name | Where | Value |
| --- | --- | --- |
| `route` | error tag, log field | normalized path, e.g. `/api/expenses/:id` |
| `http_status` | error tag (string), log `status` (number) | `500`, `503`, … |
| `api_error_code` | error tag, log `code` | `ApiError.code` when present |
| `request_id` | error tag, log `requestId` | `x-vercel-id` or UUID |
| `house` | error tag (scope) | house `publicId` |
| `user.id` | error user | member `publicId` |
| `durationMs`, `sentryEventId` | log only | elapsed since middleware stamp (approximate: edge vs function clocks); event id when the SDK is on |

## Sampling and spans

`tracesSampleRate` = env value when a number in [0, 1]; otherwise 0.1 when the environment is
`production`, 1.0 elsewhere. Environment = `VERCEL_ENV` (server) / `NEXT_PUBLIC_VERCEL_ENV` (browser,
Vercel exposes it to Next.js builds), falling back to `NODE_ENV`. `ignoreSpans: [/\/api\/health/]`
drops the keep-warm cron (BL-15). No Session Replay.

## CSP and ad-blockers

The production CSP has `connect-src 'self'`. Chosen: the SDK tunnel `/monitoring` (same-origin) —
the CSP stays untouched and ad-blockers that block `*.sentry.io` don't drop events. Rejected: adding
`https://*.ingest.sentry.io` (and the region host) to `connect-src` — widens the CSP and is defeated by
ad-blockers. Cost: tunnel traffic is a Vercel rewrite (proxied, no function code of ours). The tunnel
only applies to SaaS DSNs (`o<id>.ingest[.<region>].sentry.io`), which is what the owner uses.

## Dashboard

`docs/observability/sentry-dashboard.json` — title `Home Share — System health`, 9 widgets on the
6-column grid: transactions per minute (`spans`, `epm()` by `span.op`, `is_transaction:true`);
crash-free sessions/users (`metrics`, `crash_free_rate(session|user)`); errors by route
(`error-events`, `route` + `transaction`); top error codes on 5xx (`error-events`, `api_error_code` +
`error.type`, `http_status:5*`); p95 latency by route (`spans`, `p95(span.duration)` by `transaction`,
`span.op:http.server`); DB query p95 (`spans`, `span.category:db` by `span.description`); LCP / INP /
CLS p75 (`spans`, `p75(measurements.lcp|inp|cls)`). `scripts/sentry-dashboard.mjs` resolves the
project id, finds the dashboard by exact title (`GET …/dashboards/?query=`), then `PUT`s (widgets
replaced) or `POST`s. Field names follow Sentry's spans (EAP) dataset; if Sentry rejects a widget, the
script prints the API error and the JSON is the single place to fix it.

## UI

- `src/app/global-error.tsx`: replaces the root layout, so it has no `NextIntlClientProvider`; it reads
  the `locale` cookie (`localeFromCookie`) and lazy-loads only that locale's messages (one chunk per
  locale, fetched only on a crash). Same look as `not-found.tsx`. New keys `GlobalError.title`,
  `GlobalError.description`, `GlobalError.reload` in en/pt/es/fr.
- `src/lib/session.tsx`: two effects set the Sentry user/house from `me.user.publicId` and
  `activeGroup.publicId`. No visible change.

## Error handling & edge cases

- No DSN: `Sentry.init` never runs; `captureServerError` sees no client and returns `undefined` (no
  `sentryEventId` in logs); breadcrumbs/tags hit an unbound scope and go nowhere.
- `headers()` outside a request (tests, scripts) throws → caught → empty context; the response is
  unchanged.
- Forged `x-homeshare-*` headers are overwritten by the middleware; values are validated on read
  (request id `^[\w.:-]{1,128}$`, path must start with `/`, start must be in the past).
- Malformed JSON bodies throw `SyntaxError` → 500 today → will be captured (out of scope to change).
- `/monitoring` with no DSN: no rewrite → 404 (it used to redirect to login).

## Alternatives considered

- In-app error table + admin page — rejected: writes errors into the database that may be the failing
  part, no tracing/Web Vitals, and a dashboard to build and maintain (ADR 0008).
- Axiom, Grafana Cloud, logs-only — rejected in ADR 0008.
- `@sentry/nextjs@10.76.0` (mature v10 line, `sendDefaultPii` defaults) — rejected: a new integration
  would start on a line that only receives fixes and would need the v11 migration soon; v11's
  permissive defaults are neutralized by the explicit `dataCollection` and covered by tests.
- Dynamic `import()` of the SDK to keep it out of bundles when disabled — rejected: production always
  has the DSN, and a late init misses early errors.
- Client sample rate derived from `SENTRY_TRACES_SAMPLE_RATE` through `next.config` `env` — rejected:
  config indirection; two optional vars are explicit.
