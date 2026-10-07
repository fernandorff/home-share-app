# Web Push notifications — Design

## Approach

Standard Web Push (Push API + VAPID, RFC 8030/8291/8292) with the `web-push` library on the server and
a hand-written, push-only service worker (`public/sw.js`) on the client — ADR
[0011](../../decisions/0011-pwa-web-push.md). The `Notification` rows from spec 009 stay the source of
truth: `notificationService.create` already returns exactly the rows it inserted (after the actor,
active-member and preference filters, and dedupe), and this spec adds one call at its end —
`schedulePush(rows)` — that sends a privacy-reduced copy of each row to the recipient's devices **after**
the response (Next `after()`), so a slow or failing push service never touches the request that
produced the notice. In the cron jobs the same call runs inside the cron request's `after()`.

Everything is env-guarded like Sentry (ADR [0008](../../decisions/0008-observability-sentry.md)):
without the three VAPID variables the service worker is not registered, the push card is hidden, the
routes answer 503 and `schedulePush` is a no-op. The three go together or not at all: with only one or
two set (non-empty after trim), `next.config.ts` stops the build — and `next dev` — with an error that
names the missing variables, never a value (`vapidConfigProblem(env)` in `src/lib/push/config.ts`). A
partial set would otherwise inline the public key (switch shown, worker registered) while the server
refused every subscription with 503.

Per-device opt-in: the switch "Receive on this device" asks for permission only on tap (a user gesture,
required by iOS and recommended everywhere), subscribes, and `POST`s the subscription with the device's
current app locale. Push text is rendered on the server **per subscription** in that locale with
next-intl's `createTranslator` and a dedicated `Push` namespace — no amounts, no notes (POC risk:
"the text shows on the lock screen"); the full text with amounts stays in the in-app center.

### Payload (≤ 4 KB, encrypted aes128gcm by `web-push`)

```json
{ "title": "Casa Bolitas", "body": "Bruno added “Electricity”", "url": "/expenses?house=0192…", "tag": "EXPENSE_NEW:0192…" }
```

| Type | `body` (en; rendered in the subscription's locale) |
| --- | --- |
| `EXPENSE_NEW` | "{actor} added “{description}”" |
| `EXPENSE_NEW` + `recurring` | "“{description}” was posted automatically" |
| `PAYMENT_RECEIVED` | "{actor} recorded a payment to you" |
| `DEBT_REMINDER` | "You have an open balance to settle" |
| `RECURRING_DUE` | "“{description}” is due tomorrow" |
| test | "Notifications are working on this device" |

`title` = house name, at most 40 characters; `description` at most 60; `actor` = the actor's current
display name (deleted account → the anonymized name; unknown or automatic → `Push.someone`), at most 40
(a Google name has no length limit). Characters are graphemes (`Intl.Segmenter`): a flag, a ZWJ family
or a letter with its accents is never split, and a cut keeps max − 1 of them plus "…". A grapheme has no
length limit of its own (stacked combining marks), so each text also stays within 8 UTF-16 units per
allowed character: the three texts together stay under the 4 KB Web Push limit in the worst case
(pinned for every type and locale in `payload.test.ts`). `url` = `notificationHref(type)` (spec
009) + `?house=<group publicId>`. `tag` = `<type>:<group publicId>` so a burst of the same kind from the
same house replaces the previous banner instead of stacking (POC risk: "too many notices → muted").
Send options: `TTL: 86400`, `urgency: 'normal'`, `vapidDetails` from env, `timeout: 10000` ms.

The test push (criterion 10) is user-scoped, so it names no house: `{ title: "Home Share", body:
Push.TEST, url: "/notifications", tag: "TEST" }`, in each subscription's locale.

### Service worker (`public/sw.js`, ~60 lines, plain JS, no build step)

- `install` → `self.skipWaiting()`; `activate` → `clients.claim()`.
- `push` → parse JSON (fallback: generic "Home Share" title, no body); `showNotification(title, { body,
  tag, renotify: true, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url } })`
  inside `event.waitUntil` (`renotify` only with a tag: the newer notice replaces the older banner and
  still alerts); then `postMessage({ type: 'push' })` to open clients — the app's provider re-reads the
  bell's count and bumps its `returnCount`, so an open Notices list reloads too (`noticeReceived`).
- `notificationclick` → close; the payload's `url` is used only when it resolves to this origin **and**
  protocol (a `blob:` URL carries the app's origin inside it), else `/notifications`; find a
  same-origin client → `focus()` + `navigate(url)`, else `clients.openWindow(url)`.
- `pushsubscriptionchange` (Firefox) → resubscribe with the old subscription's `applicationServerKey`,
  else the key in the worker's own URL (`/sw.js?k=<key>`: Firefox can fire the event without the old
  subscription), and `POST` it as JSON without a locale — the worker cannot know the app's, so the server
  keeps a known row's and a new row starts in `en` until the next app load re-registers it (same-origin
  `fetch` carries the session cookie); best effort — the on-load sync covers other browsers.
- No `fetch` listener, no `caches` — nothing can serve a stale app (POC risk).

Registered by `syncPush` (`src/lib/push/client.ts`) with
`navigator.serviceWorker.register('/sw.js?k=<VAPID public key>', { scope: '/', updateViaCache: 'none' })`,
only when push is configured and supported. Registrations are keyed by scope: a browser that registered
`/sw.js` before (without a key, or with an older one) keeps its single registration and subscription and
only installs the worker from the new URL. `src/components/app/ServiceWorkerRegistrar.tsx` has two parts,
both rendering nothing: `PushSync` (needs only the session and the locale) sits in the `(app)` layout
**before** the onboarding gate — a member without a house yet syncs, or releases a shared browser's
subscription, too — as the same first child in both branches, so creating or joining a house keeps it
mounted; `PushMessageListener` (worker messages → `noticeReceived`) sits inside `NotificationsProvider`,
which needs a house. The middleware matcher skips `/sw.js` only, anchored (`sw\.js$`): `/sw.jsx`,
`/sw.js/x` and `/swXjs` stay gated, while `/sw.js?k=…` passes (the query is not part of the path). The
production CSP needs no change (`worker-src` falls back to `script-src 'self'`; the browser's connection to its push
service is not subject to the page CSP; the worker's own `fetch` is same-origin).

### Client sync (`src/lib/push/client.ts`)

- `pushSupport()` → `'unconfigured' | 'unsupported' | 'ios-needs-install' | 'ok'`
  (`serviceWorker` + `PushManager` + `Notification`; iOS detection reuses `isIos`/`isStandalone` from
  spec 009).
- Per-device owner marker in `localStorage` (`homeshare.push.owner` = the member's `publicId`), written
  only after the subscription's `POST` succeeded (a failed `POST` unsubscribes the browser again and
  leaves no marker), cleared when they turn push off; all access in try/catch. Fail-closed: a marker
  that cannot be read, or could not be written, counts as "not this member's" — the next load releases
  the subscription instead of re-registering it.
- Turn on (`subscribePush`, straight from the tap): the permission prompt is the first thing awaited (iOS
  shows it only inside a user gesture); then register the worker, reuse a subscription made with the
  current key (one made with another key is dropped as below), `POST`, mark the device.
- Turn off (`unsubscribePush`): the row first — a failed `DELETE` rejects and push stays on — then the
  marker, then the browser's `unsubscribe()` (best effort: with the marker gone, the next load releases
  it anyway).
- On app load (`PushSync`) and again whenever the app language changes, so the device's pushes follow it
  — once per member + locale per mount (a ref, not module state: StrictMode's double effect never syncs
  twice, while signing in again remounts the tree and syncs again): register the worker; then, only if
  permission is `granted` and `getSubscription()` returns one — marker ≠ current member →
  `unsubscribe()` (a shared browser never inherits someone else's opt-in); key ≠ current VAPID public
  key (compare `subscription.options.applicationServerKey`) → unsubscribe, `DELETE` the old row (best
  effort: a push service may answer a key mismatch with 403, which would never delete it) and subscribe
  again; otherwise `POST` it (refreshes owner + locale; this is also how devices come back after a
  logout deleted all subscriptions, criterion 9). Never prompts.
- After a password change (which deleted every subscription of the account, criterion 9) the account
  page calls `syncPush` once the answer arrived: this device keeps its session (the route re-signed its
  cookie) and its permission, so it re-registers at once, without a prompt; the other devices do on
  their next sign-in.
- House switch from a push URL: `src/lib/use-house-param.ts`, used in `AppChrome`: if `?house=` names a
  house in `me.user.groups` other than the active one → `switchGroup(id)` (membership-checked server
  side), then `router.replace` without the parameter; unknown/left house → just drop the parameter.
  While the switch is pending, `<main>` shows a spinner instead of the other house's screen.

## Data model

Additive only (one table, one back-relation).

```prisma
// One browser push subscription per device (spec 010). Holds a per-subscription secret (`auth`):
// excluded from the audit extension (SKIP_MODELS) and never returned by any API.
model PushSubscription {
  id        Int      @id @default(autoincrement())
  userId    Int
  endpoint  String   @unique // push-service URL; https and allow-listed host only
  p256dh    String // base64url, 65-byte P-256 public key
  auth      String // base64url, 16-byte auth secret
  locale    String   @default("en") // app locale of the device at (re)registration
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
}
```

`User.pushSubscriptions PushSubscription[]`. `SKIP_MODELS` += `PushSubscription`.

## API contract

| Method & path | Auth | Body | Success | Errors |
| --- | --- | --- | --- | --- |
| `POST /api/push-subscriptions` | `requireSession` | JSON `{ endpoint, keys: { p256dh, auth }, locale? }` | `201 { ok: true }` (upsert by `endpoint`; owner, keys and locale refreshed — without `locale` a known row keeps its own, a new row starts in `en`) | 503 `PUSH_NOT_CONFIGURED`, 415 `UNSUPPORTED_MEDIA_TYPE`, 400 `PUSH_SUBSCRIPTION_INVALID`, 401 `SESSION_REVOKED` (a logout or password change committed meanwhile; the revoked cookie is dropped) |
| `DELETE /api/push-subscriptions` | `requireSession` | JSON `{ endpoint }` | `200 { ok: true }` (idempotent; only the caller's row; also while push is unconfigured — a device can always clean up) | 415 `UNSUPPORTED_MEDIA_TYPE`, 400 `PUSH_SUBSCRIPTION_INVALID` |
| `POST /api/notifications/test` | `requireSession` | JSON (nothing read; the client sends `{}`) | `200 { sent, failed }` | 503 `PUSH_NOT_CONFIGURED`, 415 `UNSUPPORTED_MEDIA_TYPE`, 429 `RATE_LIMITED` (1 per 10 s per user, `src/lib/rate-limit.ts`), 409 `NO_PUSH_SUBSCRIPTION` |

Order: 401 → 503 → 415 → body (400) or rate limit (429). Push being off is answered before anything is
read; a refused non-JSON request never spends the member's test bucket. CSRF: the session cookie is
SameSite=Lax, so a sibling subdomain still sends it — a form or a no-cors fetch cannot send
`application/json` (`isJsonRequest` / `notJson` in `src/lib/api-helpers.ts`), and `lib/api` sends `{}`
with that content type even for a POST without a body.

Validation (`src/lib/push/endpoint.ts`): `new URL(endpoint)` with protocol `https:`, length ≤ 1024, the
canonical form only (the string equals the parsed `href`), no credentials, no port, host equal to or
ending in `.` + one of `fcm.googleapis.com`, `push.services.mozilla.com`, `push.apple.com`,
`notify.windows.com` (allow-list: the server will `POST` to this URL — an open list would be SSRF), host
characters `[a-z0-9.-]` with no empty label (web-push sends through Node's legacy `url.parse`, which must
read the same host as the WHATWG parser). The host list is `PUSH_SERVICE_HOSTS` in
`src/lib/push/hosts.ts`, shared with the Sentry/log scrubbing. `p256dh` / `auth` are exactly 87 / 22
base64url characters decoding to 65 / 16 bytes; `locale ∈ LOCALES` when present.
Push routes are user-scoped (no house): a subscription belongs to a person, and each push carries its
own house in `title`, `url` and `tag`.

Server modules:

- `src/lib/push/config.ts` — `pushConfig()` (trimmed env, `null` unless all three are set);
  `vapidConfigProblem(env)` (the missing names when one or two are set, else `null` — used by
  `next.config.ts`).
- `src/lib/push/hosts.ts` — `PUSH_SERVICE_HOSTS` / `isPushServiceHost`: the one host list, used by the
  endpoint validator and by `src/lib/observability/scrub.ts`, which cuts every push-service URL to
  `https://<host>/[Filtered]` in Sentry events, breadcrumbs, spans and log text (the device token is the
  URL's path or query; the scheme-less pattern is built from the same list).
- `src/lib/push/payload.ts` — `buildPushPayload({ notification, locale, houseName, housePublicId,
  actorName })` → `{ title, body, url, tag }`; loads `src/messages/<locale>.json` `Push` namespace.
- `src/services/push.service.ts` — `register(userId, sessionVersion, input)` (an interactive transaction:
  `SELECT "sessionVersion" … FOR UPDATE` on the member's row, then upsert + cap 10; a session older than
  the row writes nothing, commits, and throws 401 `SESSION_REVOKED` — the route drops the cookie),
  `unregister(userId, endpoint)`, `deleteAllForUser(userId, db)`, `dispatch(rows)` (load recipients'
  subscriptions, house names and actor names in one pass; send with bounded concurrency 10 via
  `Promise.allSettled`; every stored endpoint is re-validated before its send — rows outlive validator
  changes — and a rejected one is deleted like an expired one and counted in one `push endpoint
  rejected` `{ count }` warning; 404/410 → delete; others → `logger.warn('push delivery failed')` with
  the endpoint host and `statusCode`, or, without a status, a `reason` — Node's error code or
  `request_failed` — never the endpoint or web-push's message), `sendTest(userId)`. Imports
  `web-push` (exact pin `3.6.7`, `@types/web-push` `3.6.4` dev) — Node runtime only.
- `src/lib/push/schedule.ts` — `schedulePush(rows)`: no-op when unconfigured or empty; `after(() =>
  pushService.dispatch(rows))`, falling back to a tracked promise outside a request (tests) with
  `flushPush()` — the same pattern as `prisma-audit`'s deferred writes.
- `src/services/notification.service.ts` — `create` calls `schedulePush(inserted)` last.
- `src/services/auth.service.ts` — the three `sessionVersion: { increment: 1 }` sites (logout, password
  change, account deletion) also run `pushSubscription.deleteMany({ where: { userId } })` in the same
  transaction, after the bump (logout's single update becomes a `$transaction([...])`): every path takes
  the member's row first, the lock `register` waits on. `POST /api/auth/logout` still clears the cookies
  when the revocation fails, and logs `logout: session revocation failed`.

## UI

- `src/components/notifications/PushCard.tsx`, at the top of the Preferences tab (spec 009's
  `NotificationPreferences`): title "Receive on this device", status line, `role="switch"` button
  (44 px), "Send test notice" button. States (`src/lib/push-view.ts`): on / off / off — the browser will
  ask / asking — just turned on while the browser's prompt (or Chrome's quiet chip) is still open: the
  permission is still `default`, so the switch shows a pending position, never `aria-checked`, and the
  status says to answer the browser / blocked in the browser settings / this browser can't receive
  notifications / on iPhone add to the Home Screen first (link opens spec 009's `InstallSheet` on the
  iPhone tab). Hidden when push is unconfigured. "Send test notice" is enabled only while on — never
  while asking, nor while a toggle is in flight (turning on with permission granted shows on before the
  `POST` lands); after each answer it waits 10 s (the server's window; its limiter counts refused taps
  too), with a non-live countdown hint, `aria-disabled` so it keeps focus; a 429 reads as a wait (info
  toast), not a failure.
- The install banner copy from spec 009 gains "and receives the house's notices" once push is
  configured (`install.bannerBodyPush`).
- `src/components/app/ServiceWorkerRegistrar.tsx` (`PushSync` + `PushMessageListener`, no UI) and
  `src/lib/use-house-param.ts` as above.

### i18n keys (en/pt/es/fr)

`Notifications.push.title` "Receive on this device", `push.statusOn` "On for this device",
`push.statusOff` "Off for this device", `push.statusAsk` "Off — the browser will ask for permission", `push.statusAsking` "Turning on — answer
the browser's permission request",
`push.statusDenied` "Blocked in the browser settings — allow notifications for this site",
`push.statusUnsupported` "This browser can't receive notifications", `push.statusIosInstall` "On
iPhone, add the app to the Home Screen first", `push.iosHowTo` "How to add it", `push.test` "Send test
notice", `push.testHint` "Sends a sample notice to all your devices.", `push.testWait` "{seconds, plural,
one {You can send another in # second.} other {You can send another in # seconds.}}", `push.testError`
"Couldn't send the test notice — please try again", `push.toastOn` "Push is on for
this device.", `push.toastOff` "Push is off. The center still receives notices.", `push.toastDenied`
"Blocked. The browser won't ask again.", `push.toastTestSent` "{sent, plural, one {Sent to # device}
other {Sent to # devices}}{failed, plural, =0 {} other {, # failed}}.", `install.bannerBodyPush` "Opens
full screen, without the browser bar, and receives the house's notices."

`Push.*` (server-rendered, amount-free): `EXPENSE_NEW` "{actor} added “{description}”",
`EXPENSE_NEW_RECURRING` "“{description}” was posted automatically", `PAYMENT_RECEIVED` "{actor}
recorded a payment to you", `DEBT_REMINDER` "You have an open balance to settle", `RECURRING_DUE`
"“{description}” is due tomorrow", `TEST` "Notifications are working on this device", `someone`
"Someone" (actor fallback).

`ApiErrors.*`: `PUSH_SUBSCRIPTION_INVALID`, `PUSH_NOT_CONFIGURED`, `NO_PUSH_SUBSCRIPTION`,
`UNSUPPORTED_MEDIA_TYPE`, `SESSION_REVOKED` (`RATE_LIMITED` exists).

## Error handling & edge cases

- **Expired/revoked subscription** (user cleared site data, uninstalled the PWA, revoked permission):
  the push service answers 404/410 → row deleted. 413 (payload too large) cannot happen with the
  truncations; 429/5xx from the push service → logged, dropped (no retry; the center has the notice).
- **Push after the request**: `after()` keeps the function alive until `dispatch` resolves (bounded by
  the route's duration limit); a crash there only loses the push.
- **Several houses**: `title`, `url` and `tag` carry the house; tapping switches to it (criterion 12).
- **Shared browser**: the owner marker prevents member B from inheriting member A's opt-in; the server
  also moves an endpoint to whoever registers it last.
- **Logout**: bumps `sessionVersion`, which signs out every device, so all subscriptions are deleted;
  devices whose owner marker matches re-register on the next sign-in without asking again (permission
  is per site and already granted). A register racing the logout reads the version under the row lock
  and stores nothing (401 `SESSION_REVOKED`).
- **Password change**: same deletion; the device that changed it re-registers right away (above).
- **Session expiry without logout** (the cookie's 7 days): nothing bumps `sessionVersion`, so the
  device's subscription stays and keeps receiving the (amount-free) pushes until the next sign-in on it
  re-registers it — or releases it, if another member signs in. Accepted: the lock-screen copy carries
  no amounts or notes, and a push service expires an abandoned subscription on its own (404/410).
- **VAPID key rotation**: every subscription becomes invalid at the push services; the on-load sync
  detects the key mismatch, deletes the old row and resubscribes; devices not opened stop receiving
  until opened.
- **Partial VAPID config**: refused at build / `next dev` start (Approach), never a half-working switch.
- **iOS**: Web Push only for apps added to the Home Screen (iOS/iPadOS 16.4+), permission only from a
  tap inside the installed app, notifications must always be shown (`userVisibleOnly`) — the worker
  shows one for every push, including the fallback for a malformed payload.
- **Service worker update**: `skipWaiting` + `clients.claim` + `updateViaCache: 'none'`; the worker has
  no cache, so an update can never strand a user on an old app version.

## Security & tenant isolation

- **SSRF**: subscription endpoints are user-supplied URLs the server `POST`s to → https + push-service
  host allow-list, validated on every register.
- **Secrets**: `VAPID_PRIVATE_KEY` server-only env (never `NEXT_PUBLIC_`); subscription `auth`/`p256dh`
  never returned, never in `EntityRevision` (`SKIP_MODELS`), never logged (logs carry the endpoint
  host and status or reason only). Push-service URLs are cut to their origin in Sentry and log text
  (`scrub.ts`, same host list): the SDK's outgoing-request breadcrumbs and spans would otherwise carry
  the device token.
- **CSRF**: the three push writes accept `application/json` only (415 otherwise) — a same-site form must
  neither register an endpoint under the victim nor fire test pushes at their devices.
- **Ownership**: a subscription row has exactly one owner; `DELETE` filters by `userId`; register moves
  the endpoint to the caller; `sessionVersion` bumps delete all of a user's rows.
- **Content privacy**: payloads are end-to-end encrypted to the browser (push services see only
  metadata), and the lock-screen text carries no amounts or notes; recipients and house scoping are
  inherited from spec 009 (active members of the event's house only).
- **Abuse**: test push rate-limited; at most 10 subscriptions per user; dispatch concurrency bounded.
- The house switch from a push URL goes through `POST /api/groups/active`, which checks membership
  (ADR 0002) — the URL parameter never grants access.

## Testing strategy

TDD per task; `web-push` is mocked with `vi.mock('web-push')` (no network in tests).

- **Unit** — `src/lib/push/endpoint.test.ts` (each allowed host, look-alike hosts such as
  `fcm.googleapis.com.evil.test`, `http:`, IP literals, oversize, bad keys/locale);
  `src/lib/push/payload.test.ts` (no digits of the amount and no notes in `title`/`body` for every type,
  locale pt vs en, grapheme truncation and the worst-case size, `url` with `?house=`, `tag`);
  `src/lib/push/config.test.ts` (any var missing → null; `vapidConfigProblem` all-or-none) and
  `src/lib/observability/next-config.test.ts` (the config refuses to load with one or two set);
  `src/lib/push/client.test.ts` (`urlBase64ToUint8Array`, key comparison, marker rules with a throwing
  `localStorage`, sync/subscribe/unsubscribe order and rejections, and an import-graph guard that sees
  every import form); `src/lib/push-view.test.ts` (card states incl. asking); `public/sw.js` contract
  test `src/lib/push/sw-contract.test.ts` (runs the file in a VM: `push`, `notificationclick`,
  `pushsubscriptionchange` with the `?k=` fallback, same-origin + protocol targets, no `fetch` listener
  and no `caches`); `src/lib/observability/scrub.test.ts` (push-URL redaction).
- **Integration (real DB)** — one `describe` in `src/services/tenant-isolation.test.ts`, the only file
  that may open the shared pglite DB (a second file races it), with `web-push` mocked: register upsert +
  owner move + cap 10; unregister only own; a notice insert pushes once per subscription with the right
  locale; 410 and 404 delete; 500 keeps the row and logs the host only; only inserted notices push;
  logout, password change and account deletion delete the member's subscriptions; a register with a
  revoked session's version answers 401 and stores nothing (its transaction commits write-free). A
  failed transaction desyncs the shared connection, so no real-DB case fails one: rollback and
  same-transaction semantics are pinned with Prisma mocked in `src/services/push.service.test.ts`,
  `src/services/auth.service.test.ts` and `src/services/notification.service.test.ts` (`create`
  schedules exactly the inserted rows).
- **Routes** — `src/app/api/push-subscriptions/route.test.ts` (400/401/415/503, `SESSION_REVOKED` drops
  the cookie, DELETE idempotent), `src/app/api/notifications/test/route.test.ts` (409/415/429/503/200 and
  the check order), `src/app/api/auth/logout/route.test.ts` (a failed revocation is logged, the cookies
  still cleared); `src/middleware.test.ts`: `/sw.js` (and `/sw.js?k=…`) passes without a cookie,
  `/sw.jsx` and the like stay gated.
- **i18n** — `src/lib/i18n-parity.test.ts` extended with `Push` and the new `Notifications.push.*` keys.
- **Live (QA)** — localhost is a secure context, so push works on `homeshare-qa` with QA-only VAPID keys
  in the QA launcher env: Chrome/Edge → Preferences → switch on → "Send test notice" arrives; a second QA
  user adds an expense → banner without the amount; DevTools › Application › Service Workers shows
  `/sw.js` active with no fetch handler. Real devices on production after the owner actions.

## Owner actions

1. **VAPID keys** — run `npx web-push generate-vapid-keys` once on your machine (prints a public and a
   private key). Keep the private key in your password manager.
2. **Vercel env vars (Production)** — `NEXT_PUBLIC_VAPID_PUBLIC_KEY` = public key;
   `VAPID_PRIVATE_KEY` = private key (mark **Sensitive**); `VAPID_SUBJECT` =
   `https://homeshare.fernandorffdev.com` (or `mailto:` an address you read — push services use it to
   contact the sender). Set all three or none: one or two alone fail the build, naming the missing ones.
   Preview: leave unset (push off) or use a **separate** key pair. Redeploy: the
   `NEXT_PUBLIC_` value is inlined at build time.
3. **Do not rotate the keys casually** — rotating invalidates every device's subscription; devices
   resubscribe automatically the next time the app is opened.
4. **Schema** — apply the additive `PushSubscription` table to production with the deliberate
   `prisma db push` step (README › Deploy) before this code reaches Production.
5. **Privacy notice** (if one is published) — list the browsers' push services (Google FCM, Apple Push,
   Mozilla Push, Microsoft WNS) as carriers of encrypted notification messages.
6. **Real-device check** — Android Chrome: Preferences → switch on → test notice. iPhone (iOS 16.4+):
   add to the Home Screen, open from the icon, switch on, test notice.

## Alternatives considered

Each line: the chosen option first, then what was rejected and why (see also ADR 0011).

- **Transport** — standard Web Push + VAPID with `web-push`. Rejected: Firebase Cloud Messaging SDK
  (Google project, SDK bundle, CSP `connect-src` widening — and FCM is already Chrome's push service
  under the standard API); a push SaaS such as OneSignal (third-party script, CSP changes, notice
  content and user ids at another processor — LGPD, same reasoning as ADR 0008).
- **Service worker** — hand-written, push-only. Rejected: Serwist / next-pwa (Workbox precaching we do
  not want, a bundler plugin to keep compatible with Turbopack, and precache invalidation is the
  "stuck on an old version" risk the POC names).
- **Lock-screen content** — who + what + description, no amounts or notes. Rejected: the full center
  text (amounts on a lock screen — the POC's explicit risk); a fully generic "You have a new notice"
  (useless, so people turn it off).
- **Where the text is rendered** — server, per subscription locale. Rejected: the worker fetching the
  text after each push (a network round trip that can fail while iOS requires a notification to be
  shown for every push); one server-side language for everybody.
- **Delivery timing** — `after()` the response, no retries. Rejected: awaiting pushes inside the request
  (a slow push service would slow expense creation); a queue/outbox with retries (infrastructure for a
  best-effort copy of a notice the center already holds).
- **Subscription ownership** — one row per endpoint, moved to the last registrant, all deleted on
  `sessionVersion` bumps, plus a per-device owner marker. Rejected: rows per (user, endpoint) (two
  people on a shared browser would both receive each other's notices); keeping subscriptions across
  logout (a signed-out device would keep showing house notices).
- **Endpoint validation** — host allow-list. Rejected: accept any https URL (SSRF from our server to
  arbitrary hosts).
- **Push routes' scope** — the user, not the active house. Rejected: per-house subscriptions (a device
  wants notices from every house its owner belongs to; each payload already names its house).
