# Observability with Sentry — Tasks

Each task names its exact file(s) and the requirement it satisfies. Order = dependency order.
Implementation plan: `docs/superpowers/plans/2026-10-03-observability-sentry.md`.

- [x] 1. Install `@sentry/nextjs@11.4.0` (exact) and verify Node import + peer ranges — `package.json`,
      `package-lock.json` _Requirements: 1, 14_
- [x] 2. `scrubEvent` / `scrubSpan` / `redactText` / `stripQuery` + tests —
      `src/lib/observability/scrub.ts`, `src/lib/observability/scrub.test.ts` _Requirements: 4, 5_
- [x] 3. Options builder (restrictive `dataCollection`, sampling, `ignoreSpans`) + env-guarded
      `initSentry` + tests — `src/lib/observability/options.ts`, `src/lib/observability/options.test.ts`,
      `src/lib/observability/init.ts`, `src/lib/observability/init.test.ts` _Requirements: 1, 3, 14_
- [x] 4. Request context helpers + middleware stamping + tunnel excluded from the matcher —
      `src/lib/observability/request-context.ts`, `src/lib/observability/request-context.test.ts`,
      `src/middleware.ts`, `src/middleware.test.ts` _Requirements: 11, 12_
- [x] 5. JSON logger with breadcrumbs + tests — `src/lib/logger.ts`, `src/lib/logger.test.ts` _Requirements: 9_
- [x] 6. Observability context (opaque user/house, `captureServerError`) + tests —
      `src/lib/observability/context.ts`, `src/lib/observability/context.test.ts` _Requirements: 6, 8_
- [x] 7. Wire `handleApiError` (5xx captured + logged, 4xx untouched), `requireSession` /
      `requireActiveGroup` context, replace every ad-hoc `console.error` —
      `src/lib/api-helpers.ts`, `src/lib/api-helpers.observability.test.ts`, `src/lib/prisma-audit.ts`,
      `src/services/shopping-item.service.ts`, `src/lib/logger.test.ts` _Requirements: 6, 7, 8, 10_
- [x] 8. SDK entry points + DSN-gated `withSentryConfig` (tunnel, token-gated source maps) + env
      template — `src/instrumentation.ts`, `src/instrumentation-client.ts`, `src/instrumentation.test.ts`,
      `next.config.ts`, `src/lib/observability/next-config.test.ts`, `.env.example` _Requirements: 1, 2, 12, 14_
- [x] 9. Localized GlobalError screen + client user/house context + i18n (4 locales) —
      `src/app/global-error.tsx`, `src/lib/locale-cookie.ts`, `src/lib/locale-cookie.test.ts`,
      `src/lib/session.tsx`, `src/messages/*.json` _Requirements: 8, 13_
- [x] 10. Dashboard as code + sync script + contract test — `docs/observability/sentry-dashboard.json`,
      `scripts/sentry-dashboard.mjs`, `src/lib/observability/dashboard.test.ts` _Requirements: 15_
- [x] 11. Owner checklist (PT) + ADR 0008 + docs contract test — `docs/observability.md`,
      `docs/decisions/0008-observability-sentry.md`, `docs/decisions/README.md`,
      `src/lib/observability/docs.test.ts` _Requirements: 16_
- [x] 12. Verify: `npm run test` + `npx tsc --noEmit` + `npx eslint src` green; QA server without a DSN
      (app unchanged) and with a local stub DSN (events scrubbed, user/house ids, DB and Web Vitals
      spans, no 4xx events) _Requirements: 1, 4, 5, 6, 7, 8, 13, 14_
