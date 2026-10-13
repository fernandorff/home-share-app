# Installable app + notification center — Requirements

Phase 1 of the "Notices + installable app" POC
(`screenshots/loop-2026-09-27/artefato/pocs/avisos-e-app.html`). Phase 2 — Web Push to the device —
is [spec 010](../010-web-push/requirements.md). Depends on [spec 008](../008-recurring-expenses/requirements.md)
for the recurring due-date reminder (criterion 7) and the "posted automatically" notice (criterion 5).

## Problem

The app only exists when someone remembers to open the browser. Nobody learns that a new expense came
in, that a payment arrived or that rent is due tomorrow, and balances age without anyone looking.

## User story

As a household member, I want to install Home Share on my phone's home screen and have one place that
lists what happened that concerns me — with an on/off switch per kind of notice — so that I stay on top
of the house's money without checking every screen.

## Acceptance criteria (EARS)

Each criterion must be verifiable by a test (or a single curl) in ~10 seconds.

**Installable app**

1. THE SYSTEM SHALL serve `/manifest.json` and every icon it references without a session (no redirect
   to login), with `name` and `short_name` "Home Share", `id` "/", `start_url` "/expenses", `scope` "/",
   `display` "standalone", `theme_color`, `background_color`, and PNG icons of 192×192 and 512×512 plus
   a 512×512 `maskable` one; THE root layout SHALL link the manifest and declare an apple-touch-icon
   (180×180) and Apple web-app metadata (title, capable).
2. WHEN the browser fires `beforeinstallprompt` and the app is not running standalone, THE SYSTEM SHALL
   show an install banner on `/notifications` whose "Install" button calls the deferred `prompt()`;
   WHEN the visitor taps "Not now", THE SYSTEM SHALL hide the banner on that device for 30 days.
3. WHEN the visitor uses Safari on iPhone/iPad and the app is not running standalone, THE SYSTEM SHALL
   offer the manual steps (Share → Add to Home Screen → Add) instead of a native prompt; WHILE the app
   runs standalone, THE SYSTEM SHALL show no install banner and the Preferences card SHALL read
   "Installed".

**Producing notices**

4. WHEN a member creates an expense through `POST /api/expenses`, THE SYSTEM SHALL create one
   `EXPENSE_NEW` notice in that house for each active member who is its payer or a participant with a
   share greater than zero, except the member who created it. CSV imports SHALL create none.
5. WHEN a recurring rule posts an expense (spec 008), THE SYSTEM SHALL create `EXPENSE_NEW` notices
   marked `recurring` for the payer and every participant with a share greater than zero (no author to
   exclude).
6. WHEN a member records a settlement through `POST /api/settlements` whose recipient is another active
   member, THE SYSTEM SHALL create one `PAYMENT_RECEIVED` notice for the recipient.
7. WHEN the daily notices job runs, THE SYSTEM SHALL create one `RECURRING_DUE` notice for the payer of
   every unpaused recurring rule whose next unskipped period is due tomorrow in the rule's timezone, at
   most once per (rule, period).
8. WHEN the daily notices job runs on a Monday (UTC), THE SYSTEM SHALL create one `DEBT_REMINDER` for
   each active member whose balance in a house (expenses and recorded payments) is below zero, with the
   amount owed, at most once per member, house and ISO week.
9. WHILE a notice type is turned off for a member, THE SYSTEM SHALL create no notice of that type for
   that member (the switch governs the center and, in spec 010, push). Every type defaults to on.
10. WHEN a notice is created, THE SYSTEM SHALL never fail, slow down or roll back the action that
    produced it: a notice failure is logged and the action still succeeds.

**Reading notices**

11. WHEN a member requests `GET /api/notifications` (optionally `?filter=unread`), THE SYSTEM SHALL
    return at most 50 of that member's notices for the active house, newest first, plus `unreadCount`;
    notices of other members or other houses SHALL never be returned.
12. WHEN a member marks a notice read (`PATCH /api/notifications/{publicId}` `{ "read": true }`), marks
    all read (`POST /api/notifications/read-all`) or deletes one (`DELETE /api/notifications/{publicId}`),
    THE SYSTEM SHALL change only that member's notices in the active house; another member's or another
    house's id SHALL get 404 `NOTIFICATION_NOT_FOUND`.
13. WHEN a member requests `GET /api/notification-preferences`, THE SYSTEM SHALL return every type with
    its effective value; WHEN they send `PUT` `{ "type", "enabled" }`, THE SYSTEM SHALL store it and
    return the updated map; an unknown type or a non-boolean SHALL get 400 `NOTIFICATION_PREF_INVALID`.
14. WHILE signed in, THE SYSTEM SHALL show a bell with the active house's unread count in the header on
    mobile and desktop (hidden count at zero), refreshed on load, house switch, window focus and after
    read/delete actions; tapping it opens `/notifications`.
15. WHILE on `/notifications`, THE SYSTEM SHALL show two tabs — Notices (All/Unread filter, "Mark all
    read", items grouped Today / Yesterday / Earlier with an icon, the localized text with amounts in
    the house currency, the relative time and type, an unread dot, tap = mark read and open the related
    screen, and a remove button) and Preferences (one switch per type with its description, and the
    "App on home screen" card) — in all 4 locales, with 44 px touch targets.
16. WHILE rendering a notice, THE SYSTEM SHALL show the actor's current display name (an ex-member or
    deleted account resolved exactly like Activity) and phrase automatic notices without an actor
    ("“Rent” was posted automatically").

**Jobs and lifecycle**

17. WHEN a request to `GET /api/cron/notifications` lacks `Authorization: Bearer <CRON_SECRET>`, THE
    SYSTEM SHALL respond 401 and create nothing; running the job twice on the same day SHALL create no
    duplicate notice.
18. WHEN the daily notices job runs, THE SYSTEM SHALL delete notices older than 90 days.
19. WHEN a member deletes their account, THE SYSTEM SHALL delete their notices and notice preferences.
20. WHEN a notice or a notice preference is written, THE SYSTEM SHALL NOT record an `EntityRevision`
    (personal data never reaches Activity › Detailed, which every member of the house can read).

## Out of scope

- Web Push to devices, the per-device switch, the test notice and the service worker — spec 010.
- Quiet hours (POC toggle): needs a per-user timezone and deferred delivery — v2 (the phone's own Do
  Not Disturb covers it meanwhile).
- Shopping-list notices (new item / purchased): highest-volume event, needs batching to avoid the
  "too many notices → muted" risk the POC names — v2.
- Budget notices: the budget feature does not exist yet — v2 with it.
- Notices for expense edits/deletes, or "a payment you made was recorded".
- Per-house preferences, e-mail notices, digests/grouping, app icon badge (Badging API).
- Offline mode and response caching.
- Opening the specific expense from a notice (opens the list screen), real-time updates
  (WebSocket/SSE), a localized manifest name.

## Open questions

None — every decision was taken with the recommended option (owner instruction) and is recorded in
[design.md › Alternatives considered](design.md#alternatives-considered) and ADRs
[0010](../../decisions/0010-scheduled-jobs-vercel-cron.md) and [0011](../../decisions/0011-pwa-web-push.md).
