# Web Push notifications — Tasks

Each task names its exact file(s) and the requirement it satisfies. Order = dependency order.
TDD: in every task the test is written first, run red, then the code makes it green.
Prerequisite: spec 009 merged (`Notification`, `notificationService.create` returning inserted rows,
`notificationHref`, `isIos`/`isStandalone`, Preferences tab, `InstallSheet`).

Ground rules: never run `npm run build`, `next build` or `prisma db push` locally (`.env*` = production
Neon). Additive schema only; after it, only `npx prisma generate`. Tests never reach the network
(`vi.mock('web-push')`). No servers/browsers for implementers — the live check is task 18.

- [x] 1. Dependencies: `web-push@3.6.7` (exact) and dev `@types/web-push@3.6.4` (exact); confirm a Node
      import works — `package.json`, `package-lock.json` _Requirements: 6_
- [x] 2. Additive schema: model `PushSubscription` + `User.pushSubscriptions`; `npx prisma generate` —
      `prisma/schema.prisma` _Requirements: 3, 5_
- [x] 3. Keep subscriptions out of the audit trail, test first: `PushSubscription` in `SKIP_MODELS` —
      `src/lib/prisma-audit.ts`, `src/lib/prisma-audit.test.ts` _Requirements: 13_
- [x] 4. Config guard, tests first: `pushConfig()` (all three vars or null) —
      `src/lib/push/config.test.ts`, `src/lib/push/config.ts` _Requirements: 1_
- [x] 5. Subscription validation, tests first: https + host allow-list (look-alikes rejected), key
      format/length, locale — `src/lib/push/endpoint.test.ts`, `src/lib/push/endpoint.ts` _Requirements: 4_
- [x] 6. Payload builder + `Push` i18n namespace (4 locales), tests first: no amount/notes, locale,
      truncation, `url` with `?house=`, `tag` — `src/lib/push/payload.test.ts`, `src/lib/push/payload.ts`,
      `src/messages/en.json`, `src/messages/pt.json`, `src/messages/es.json`, `src/messages/fr.json`,
      `src/lib/i18n-parity.test.ts` _Requirements: 6_
- [x] 7. Push service, tests first (mocked `web-push`): `register` (upsert, move owner, cap 10),
      `unregister` (own only), `dispatch` (one push per subscription, concurrency 10, 404/410 delete,
      other failures logged with host only), `sendTest` — `src/services/push.service.test.ts`,
      `src/services/push.service.ts` _Requirements: 5, 6, 7, 10, 13_
- [x] 8. `schedulePush` (after() + test fallback `flushPush`) and the call at the end of
      `notificationService.create`, tests first (only inserted rows are pushed; unconfigured → no-op) —
      `src/lib/push/schedule.ts`, `src/services/notification.service.ts`,
      `src/services/notification.service.test.ts` _Requirements: 1, 6, 7_
- [x] 9. Delete all subscriptions on every `sessionVersion` bump (logout, password change, account
      deletion) in the same transaction, tests first — `src/services/auth.service.ts`,
      `src/services/auth.service.test.ts` _Requirements: 9_
- [x] 10. Subscription routes, tests first: `POST`/`DELETE /api/push-subscriptions` (400/401/503,
      idempotent delete) — `src/app/api/push-subscriptions/route.ts`,
      `src/app/api/push-subscriptions/route.test.ts` _Requirements: 1, 3, 4, 5_
- [x] 11. Test-notice route, tests first: `POST /api/notifications/test` (409/429/503/200 `{ sent, failed }`)
      — `src/app/api/notifications/test/route.ts`, `src/app/api/notifications/test/route.test.ts` _Requirements: 10_
- [x] 12. Service worker + contract test first (push, notificationclick, pushsubscriptionchange,
      skipWaiting/claim, fallback notification; no fetch listener, no caches); middleware lets `/sw.js`
      through — `src/lib/push/sw-contract.test.ts`, `public/sw.js`, `src/middleware.test.ts` _Requirements: 2_
- [x] 13. Client helpers, tests first: `pushSupport()`, `urlBase64ToUint8Array`, VAPID key comparison,
      owner marker rules (guarded `localStorage`), subscribe/unsubscribe/sync —
      `src/lib/push/client.test.ts`, `src/lib/push/client.ts` _Requirements: 3, 8, 11_
- [x] 14. Registrar (register `/sw.js` only when configured + supported, on-load sync, bell refresh on
      worker message) mounted in the app layout — `src/components/app/ServiceWorkerRegistrar.tsx`,
      `src/app/(app)/layout.tsx` _Requirements: 1, 2, 8_
- [x] 15. House switch from a push URL, test first for the pure decision (`?house=` known / active /
      unknown) — `src/lib/use-house-param.ts`, `src/lib/use-house-param.test.ts`,
      `src/components/app/AppChrome.tsx` _Requirements: 12_
- [x] 16. Push card in Preferences (states, switch, test button, iOS install link) + remaining i18n keys
      (`Notifications.push.*`, `install.bannerBodyPush`, `ApiErrors`), parity test extended first —
      `src/components/notifications/PushCard.tsx`,
      `src/components/notifications/NotificationPreferences.tsx`,
      `src/components/notifications/InstallBanner.tsx`, `src/messages/*.json`,
      `src/lib/i18n-parity.test.ts` _Requirements: 3, 10, 11_
- [x] 17. Env template + ADR: `NEXT_PUBLIC_VAPID_PUBLIC_KEY=`, `VAPID_PRIVATE_KEY=`, `VAPID_SUBJECT=`
      with Portuguese comments; promote ADR 0011 to `accepted` when this ships — `.env.example`,
      `docs/decisions/0011-pwa-web-push.md` _Requirements: 1_
- [ ] 18. Verify: `npx tsc --noEmit` + `npm run test` + `npx eslint src` green; `npx next build` via CI
      only. Live check on QA with QA-only VAPID keys (design.md › Testing strategy › Live): switch on,
      test notice, another user's expense arrives without the amount, tap opens `/expenses` in the right
      house, switch off removes the row, logout removes all rows. After the owner actions: real Android
      phone and iPhone (installed) receive the test notice _Requirements: 1–13_
