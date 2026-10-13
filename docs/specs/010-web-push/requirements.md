# Web Push notifications — Requirements

Phase 2 of the "Notices + installable app" POC
(`screenshots/loop-2026-09-27/artefato/pocs/avisos-e-app.html`). Builds on
[spec 009](../009-pwa-notification-center/requirements.md): every notice created there is the source
of truth; push is an optional copy of it sent to the member's devices.

## Problem

The notification center still needs someone to open the app. The value the POC promises — hearing
about a new expense, a payment or tomorrow's rent where you are — needs a push to the phone, opt-in per
device, without exposing amounts on a lock screen.

## User story

As a household member, I want to turn on push notifications on each of my devices so that the notices
from my center reach my lock screen, with no amounts shown there and a tap that opens the right screen.

## Acceptance criteria (EARS)

Each criterion must be verifiable by a test (or a single curl) in ~10 seconds.

1. WHILE any of `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` or `VAPID_SUBJECT` is unset, THE
   SYSTEM SHALL hide the push controls, register no service worker, accept no subscription (503
   `PUSH_NOT_CONFIGURED`) and send no push — the notification center keeps working. IF one or two of
   them are set (non-empty after trim) but not all three, THE SYSTEM SHALL refuse to build or start
   (`next.config.ts`), with an error that names the missing variables and no value.
2. THE SYSTEM SHALL serve `/sw.js` without a session; the service worker SHALL show a notification for
   each `push` event from its payload and, on click, focus an open app window (navigating it) or open a
   new one at the payload's `url` (this origin and protocol only; anything else opens the notification
   center); it SHALL NOT register a `fetch` handler or use the Cache API.
3. WHEN a member turns on "Receive on this device" (a user gesture), THE SYSTEM SHALL request
   notification permission, subscribe with the VAPID public key (`userVisibleOnly: true`) and store the
   subscription (endpoint, keys, the device's current app locale) for that member via
   `POST /api/push-subscriptions`; WHILE the browser has not answered the permission request yet, THE
   SYSTEM SHALL NOT show push as on. WHEN they turn it off, THE SYSTEM SHALL delete the subscription via
   `DELETE /api/push-subscriptions` first (a failed delete leaves push on) and then unsubscribe the
   browser.
4. WHEN `POST /api/push-subscriptions` receives an endpoint that is not `https:` or whose host is not an
   allow-listed push service (equal to, or a subdomain of, `fcm.googleapis.com`,
   `push.services.mozilla.com`, `push.apple.com` or `notify.windows.com`), keys that are not base64url
   of the expected length (`p256dh` 65 bytes, `auth` 16 bytes), or a locale outside en/pt/es/fr, THE SYSTEM SHALL respond 400 `PUSH_SUBSCRIPTION_INVALID` and store nothing (a missing locale is
   accepted: a known subscription keeps its own). WHEN a push write (`POST`/`DELETE
   /api/push-subscriptions`, `POST /api/notifications/test`) is not `application/json`, THE SYSTEM SHALL
   respond 415 `UNSUPPORTED_MEDIA_TYPE` and change nothing.
5. WHEN an endpoint already stored for another member is registered, THE SYSTEM SHALL move it to the
   current member (one owner per endpoint); WHEN a member would exceed 10 subscriptions, THE SYSTEM
   SHALL delete their oldest one. `DELETE` SHALL only remove a subscription the caller owns (idempotent).
6. WHEN spec 009 inserts a notice for a member who has subscriptions, THE SYSTEM SHALL send one Web
   Push per subscription after the producing response is sent, with the JSON payload
   `{ title, body, url, tag }` rendered in that subscription's locale, where `title` is the house name,
   `body` contains no amount and no notes, `url` is the notice's screen plus `?house=<house publicId>`,
   and `tag` is `<type>:<house publicId>`; with TTL 24 h.
7. WHEN the push service answers 404 or 410 for a subscription, THE SYSTEM SHALL delete that
   subscription; any other failure SHALL be logged (endpoint host only, no keys) and never retried, and
   no push failure SHALL fail or delay the action that produced the notice.
8. WHEN the app loads — or its language changes — with notification permission granted and a browser
   subscription that this signed-in member created on this device (per-device owner marker), THE SYSTEM
   SHALL re-register it (refreshing owner and locale), also for a member who has no house yet; IF the
   marker is missing, names another member or cannot be read, THE SYSTEM SHALL unsubscribe it and leave
   push off;
   IF the subscription was made with a different VAPID key, THE SYSTEM SHALL delete its stored row and
   resubscribe with the current key.
9. WHEN a member's `sessionVersion` is incremented (logout, password change, account deletion), THE
   SYSTEM SHALL delete all of that member's push subscriptions in the same transaction; a registration
   carrying the version of a session revoked meanwhile SHALL store nothing and answer 401
   `SESSION_REVOKED`. WHEN the password change succeeds, THE SYSTEM SHALL re-register the device that
   made it, without a prompt.
10. WHEN a member taps "Send test notice", THE SYSTEM SHALL send a test push to all their subscriptions
    and respond `{ sent, failed }`; with no subscription → 409 `NO_PUSH_SUBSCRIPTION`; push not
    configured → 503 `PUSH_NOT_CONFIGURED`; not JSON → 415 `UNSUPPORTED_MEDIA_TYPE`; more than one test
    per 10 s → 429 `RATE_LIMITED` (the button waits 10 s after each answer).
11. WHILE the browser cannot receive push — including Safari on iPhone/iPad when the app was not opened
    from the Home Screen — THE SYSTEM SHALL explain why instead of the switch (iOS: "add to Home Screen
    first", with a link to the install steps); WHILE permission is `denied`, THE SYSTEM SHALL show
    "Blocked in the browser settings" and never prompt.
12. WHEN the app opens from a push whose `house` differs from the active house, THE SYSTEM SHALL switch
    to that house through the membership-checked `POST /api/groups/active` before showing the screen;
    IF the member no longer belongs to that house, the active house SHALL stay unchanged.
13. THE SYSTEM SHALL never return a subscription's keys from any API, write a `PushSubscription` to
    `EntityRevision`, or log keys or full endpoints — nor send push-service URLs beyond their origin to
    Sentry (events, breadcrumbs, spans).

## Out of scope

- Quiet hours, per-device type preferences, push for expense edits/deletes — v2.
- Retries, a delivery queue, delivery receipts or analytics.
- Rich notifications (action buttons, images), app icon badge.
- Apple's Declarative Web Push format; e-mail fallback.
- Offline support or any caching in the service worker.

## Open questions

None — every decision was taken with the recommended option (owner instruction) and is recorded in
[design.md › Alternatives considered](design.md#alternatives-considered) and ADR
[0011](../../decisions/0011-pwa-web-push.md).
