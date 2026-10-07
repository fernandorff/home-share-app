# Installable PWA with a static manifest; notices in Postgres; optional standard Web Push from a push-only service worker

- Status: accepted
- Date: 2026-10-04
- Specs: [009 — Installable app + notification center](../specs/009-pwa-notification-center/design.md),
  [010 — Web Push](../specs/010-web-push/design.md)

**Decision:** Home Share is installable through a static `public/manifest.json` and PNG icons (paths the
middleware already lets through); notices live in a per-recipient `Notification` table that is the source
of truth; push is an optional, best-effort copy sent with the standard Push API + VAPID (`web-push`, exact
pin) from a hand-written, push-only service worker (`public/sw.js` — no fetch handler, no cache), to
allow-listed push-service hosts only, with lock-screen text that carries no amounts or notes and is
rendered in the device's locale.

## Context and Problem Statement

The app is used from phone browsers; nobody learns about a new expense, a payment or tomorrow's rent
unless they open it (POC "Avisos e app instalável"). The POC lists the risks: iPhone push works only for
an installed app (iOS 16.4+); too many notices get the app muted; a service-worker cache can serve a stale
app; the lock screen shows the text, so amounts are sensitive. Constraints: strict CSP (`connect-src
'self'`), serverless runtime, cookie session (ADR 0001), privacy-first handling of housemates' data
(ADR 0008), and a session middleware that redirects cookie-less requests to the login page.

## Decision Drivers

- No third party receives household data beyond the encrypted push transport the browsers mandate.
- Work on Android, desktop and installed iPhone apps without vendor SDKs or CSP changes.
- Never strand users on an old app version.
- Notices must survive push failures and respect per-type switches identically in-app and on the device.
- Off by default: no keys, no push, nothing else changes.

## Considered Options

1. **Static manifest + `Notification` table + standard Web Push (VAPID, `web-push`) + hand-written
   push-only service worker** — ✅ chosen.
2. Serwist / next-pwa (Workbox) — ❌ precaching/offline is not wanted; a bundler plugin to keep compatible
   with Turbopack; precache invalidation is exactly the "stuck on an old version" risk the POC names.
3. Firebase Cloud Messaging JS SDK — ❌ a Google project, an SDK bundle and a wider `connect-src` for what
   the standard Push API already does (FCM is Chrome's push service underneath anyway; Safari, Firefox
   and Edge use their own).
4. Push SaaS (OneSignal and similar) — ❌ a third-party script, CSP changes, and notice content plus user
   ids at another processor (LGPD; same reasoning that kept errors in a scrubbed Sentry, ADR 0008).
5. Center only, no push — ❌ leaves the actual problem (nobody opens the app) unsolved.
6. E-mail notices — ❌ needs an e-mail provider and verified addresses (e-mail is optional in this app);
   a v2 candidate.
7. `app/manifest.ts` (served as `/manifest.webmanifest`) — ❌ that path is not excluded from the
   middleware matcher, and manifest fetches carry no cookie → redirected to login; `/manifest.json`,
   `/icons` and `/sw.js` are already excluded.
8. Notices rendered as stored text — ❌ frozen in one language and currency format; structured `params`
   are rendered by the reader's client (center) or per device locale (push).

## Decision Outcome

- **Install (spec 009)**: `public/manifest.json` (`display: standalone`, `start_url: /expenses`, 192/512
  and maskable icons generated from `src/app/icon.svg`), Apple web-app metadata in the root layout, an
  install banner driven by `beforeinstallprompt` (manual steps on iOS). No service worker in this phase:
  current Chromium install criteria do not require one.
- **Notices (spec 009)**: one row per recipient and house, created after the producing action succeeds
  (never failing it); a per-user switch per type filters at creation, so "off" means off in the center and
  on the device; scheduled notices dedupe on `(userId, dedupeKey)`; 90-day retention; not audited
  (personal data — Activity › Detailed is visible to the whole house).
- **Push (spec 010)**: env-guarded by `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` —
  all three or none: one or two alone stop the build and `next dev` (`next.config.ts`), naming the missing
  variables, since the inlined public key would otherwise show a switch the server refuses (503).
  One `PushSubscription` per browser endpoint (unique; moved to the last member who registers it; at most
  10 per member; all deleted whenever `sessionVersion` is bumped, in the bump's transaction and after it —
  a registration re-reads the version under that row's lock, so one racing a logout stores nothing and
  answers 401), plus a per-device owner marker, written only after the server stored the subscription and
  read fail-closed, so a shared browser never inherits someone else's opt-in. The push writes accept JSON
  only (CSRF: the cookie is SameSite=Lax). Endpoints must be canonical `https:` URLs on
  `fcm.googleapis.com`, `push.services.mozilla.com`, `push.apple.com` or `notify.windows.com` — each the host
  itself or a `.`-subdomain of it, host characters limited to `[a-z0-9.-]` (the server `POST`s to them through
  Node's legacy `url.parse`; an open list, or a host the two URL parsers read differently, would be SSRF);
  every stored endpoint is checked again before each send. Payload `{ title: house name, body: who +
  what + description (≤ 60 characters, grapheme-safe, under the 4 KB limit), url: screen + ?house=, tag:
  type:house }`, TTL 24 h, sent after the response with `after()`; 404/410 delete the subscription; nothing
  is retried. Subscription keys are never returned, logged or written to `EntityRevision`; push-service URLs
  (the device token is in them) reach logs and Sentry as their origin only — one host list
  (`src/lib/push/hosts.ts`) feeds the validator and the scrubber.
- **Service worker**: `push` → `showNotification` (a generic fallback for malformed payloads, because iOS
  requires a visible notification per push; a tag replaces the previous banner of the same kind and
  `renotify` still alerts); `notificationclick` → focus/navigate or open, same origin and protocol only;
  `pushsubscriptionchange` → resubscribe with the old key, else the one in the worker's URL
  (`/sw.js?k=<public key>`); `skipWaiting` + `clients.claim`, registered with `updateViaCache: 'none'`; no
  `fetch` listener and no Cache API — it can never serve stale pages. The middleware skips exactly `/sw.js`
  (anchored). CSP unchanged.
- **iOS**: push is offered only when the app runs from the Home Screen (iOS/iPadOS 16.4+); otherwise the
  UI explains how to add it. Permission is requested only from the member's tap on the switch.

### Consequences

- Good: no vendor SDK, no CSP change, no third party beyond the browsers' own push services (which only
  see encrypted payloads and metadata).
- Good: push failures and expired devices never affect the action or the center; switches behave the same
  everywhere.
- Good: zero offline/caching surface — no stale-version class of bugs.
- Bad: no offline support at all (accepted; out of scope).
- Bad: iPhone users must install the app before they can enable push.
- Bad: best effort — a push lost at the push service or during a function freeze is not retried (the
  center still has the notice).
- Bad: rotating the VAPID keys invalidates every device's subscription until each device reopens the app
  (it then deletes the old row and resubscribes).
- Bad: a session that expires without a logout bumps nothing, so its device keeps receiving the
  amount-free pushes until someone signs in on it again (re-registered or released) or the push service
  expires the subscription.
- Bad: the endpoint allow-list must follow browser vendors if they add a push-service host.

### Confirmation

- `src/lib/pwa-manifest.test.ts` — manifest fields and real PNG icon sizes; `src/middleware.test.ts` —
  `/manifest.json`, `/icons/*`, `/sw.js` reachable without a cookie.
- `src/services/tenant-isolation.test.ts` (real DB, describe "notification center (spec 009 …)"; unit cases with
  Prisma mocked in `src/services/notification.service.test.ts`) — recipients, preference filter, dedupe, scoping.
- `src/lib/push/endpoint.test.ts` — allow-list incl. look-alike hosts; `src/lib/push/payload.test.ts` —
  no amounts or notes in any payload, worst-case size; `src/lib/push/sw-contract.test.ts` — no fetch
  listener, no caches, same-origin targets; `src/lib/push/config.test.ts` +
  `src/lib/observability/next-config.test.ts` — all three VAPID variables or none.
- `src/services/tenant-isolation.test.ts` (real DB, describe "web push (spec 010 …)") — 404/410 deletion,
  ownership moves, cap, deletion on every `sessionVersion` bump, a revoked session's registration stores
  nothing; unit cases with Prisma mocked in `src/services/push.service.test.ts` and
  `src/services/auth.service.test.ts` (same-transaction order).
- `src/lib/push/client.test.ts` — owner-marker rules, key rotation, turn-off order, client import graph;
  `src/lib/observability/scrub.test.ts` — push URLs cut to their origin; the push route tests — 415 on
  non-JSON writes.
