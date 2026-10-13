# Installable app + notification center — Design

## Approach

Two independent pieces that ship together:

1. **Installable app (PWA shell)** — a static `public/manifest.json`, PNG icons in `public/icons/`
   and Apple web-app metadata in the root layout. The session middleware matcher skips them through
   anchored entries — `icons/`, `manifest\.json$` and the favicon `icon\.svg$` (the earlier unanchored
   `manifest.json|icons` also let look-alike paths such as `/iconsx` through) — so browsers can fetch them
   without a cookie. Current Chromium install criteria need HTTPS + a manifest with name, 192/512 icons,
   `start_url` and a standalone `display` — no service worker — so this phase ships **no service
   worker**; spec 010 adds a push-only one (ADR [0011](../../decisions/0011-pwa-web-push.md)). An install
   banner on `/notifications` uses the deferred `beforeinstallprompt` event (Chrome/Edge/Android) or
   shows the manual Safari steps on iOS.
2. **Notification center** — a per-recipient `Notification` row for each event that concerns a member,
   stored with structured `params` (ids, description snapshot, amounts as strings) and rendered by the
   client through i18n, so the text follows the reader's locale and the house currency. Producers:
   - **event-driven**, after the mutation succeeds: `POST /api/expenses` and `POST /api/settlements`
     hand `notifySafely(...)` (an `api-helpers` wrapper with the same never-fail contract as
     `recordActivity`) to Next's `after()` — the response goes out first and the platform keeps the
     function alive until the notices are written, the mechanism the audit writes use (`prisma-audit.ts`);
     the recurring poster (spec 008, framework-free) calls the service inline after each posted period;
   - **scheduled**: a daily Vercel Cron `GET /api/cron/notifications` (`0 12 * * *`, same
     `CRON_SECRET` guard as spec 008, ADR [0010](../../decisions/0010-scheduled-jobs-vercel-cron.md))
     creates recurring due-date reminders, Monday debt reminders, and prunes rows older than 90 days.
     Scheduled notices carry a `dedupeKey`, unique per recipient, so a duplicate run inserts nothing.

A member's per-type switch filters at **creation**: a type that is off produces no row, which is what
makes the same switch govern the center now and push in spec 010 (POC: "the type filter applies to the
center and to push"). The center is scoped like every other screen — the **active house** (ADR
[0002](../../decisions/0002-active-house-cookie-db-membership-authority.md)) — and the bell shows that
house's unread count.

Patterns kept: thin routes, framework-agnostic `src/services/notification.service.ts`, cookie session,
`groupId` from `requireActiveGroup()` only, error codes localized client-side, integer cents for the
debt amount (computed with the existing `balanceService.aggregate` + `applySettlements`).

### Producers and recipients

| Type | Trigger | Recipients | `params` | `dedupeKey` |
| --- | --- | --- | --- | --- |
| `EXPENSE_NEW` | `POST /api/expenses` (actor = session user); recurring posting (actor null, `recurring: true`) | payer ∪ participants with share > 0, minus the actor | `{ expensePublicId, description, amount, recurring }` | — |
| `PAYMENT_RECEIVED` | `POST /api/settlements` (actor = the member who recorded it) | `toUserId`, unless it is the actor | `{ settlementPublicId, fromUserId, amount }` — `fromUserId` is the payer: any member may record a payment between two others, so the payer is not always the actor | — |
| `RECURRING_DUE` | daily job: the first unskipped upcoming period of an unpaused rule has `dueOn` = tomorrow in the rule's timezone | the rule's payer | `{ recurringExpensePublicId, description, amount, dueOn }` | `RECURRING_DUE:<ruleId>:<period>` |
| `DEBT_REMINDER` | daily job, Mondays (UTC) only: member balance < 0 in a house | that member | `{ amount }` (absolute, 2-decimal string) | `DEBT_REMINDER:<groupId>:<ISO week, e.g. 2026-W41>` |

Common filter in `notificationService.create(...)`: drop the actor; keep only **active** members of
the event's house (`leftAt` null, account not deleted); drop members whose preference for the type is
off; insert with `createManyAndReturn({ data, skipDuplicates: true })` — the returned rows are the ones
actually inserted (spec 010 pushes exactly those). CSV imports call nothing (bulk; out of scope).

Tap targets (`notificationHref(type)` in `src/lib/notifications.ts`, shared with spec 010):
`EXPENSE_NEW` → `/expenses`, `PAYMENT_RECEIVED` and `DEBT_REMINDER` → `/balances`, `RECURRING_DUE` →
`/recurring`.

## Data model

Additive only (one enum, two tables, back-relations).

```prisma
enum NotificationType {
  EXPENSE_NEW
  PAYMENT_RECEIVED
  DEBT_REMINDER
  RECURRING_DUE
}

// One notice for one recipient in one house (spec 009). Personal data, not house activity:
// excluded from the audit extension (SKIP_MODELS) — Activity › Detailed is readable by every member.
model Notification {
  id        Int              @id @default(autoincrement())
  publicId  String           @unique @db.Uuid
  userId    Int // recipient
  groupId   Int
  type      NotificationType
  actorId   Int? // who caused it; null = automatic (cron / recurring rule)
  params    Json // render parameters: ids, description snapshot, amounts as 2-decimal strings
  dedupeKey String? // scheduled producers only; unique per recipient (NULLs never collide)
  readAt    DateTime?
  createdAt DateTime         @default(now())

  user  User  @relation("NotificationRecipient", fields: [userId], references: [id], onDelete: Cascade)
  actor User? @relation("NotificationActor", fields: [actorId], references: [id], onDelete: SetNull)
  group Group @relation(fields: [groupId], references: [id], onDelete: Cascade)

  @@unique([userId, dedupeKey])
  @@index([userId, groupId, createdAt])
}

// Only overrides are stored; a missing row means the type's default (on).
model NotificationPreference {
  userId    Int
  type      NotificationType
  enabled   Boolean
  updatedAt DateTime         @updatedAt

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@id([userId, type])
}
```

Back-relations: `User.notifications Notification[] @relation("NotificationRecipient")`,
`User.notificationsCaused Notification[] @relation("NotificationActor")`,
`User.notificationPreferences NotificationPreference[]`, `Group.notifications Notification[]`.

`SKIP_MODELS` in `src/lib/prisma-audit.ts` gains `Notification` and `NotificationPreference`. Users
are soft-deleted (BL-23), so `deleteAccount` deletes both explicitly inside its transaction.

## API contract

All center routes: `requireActiveGroup()`; every query filters `userId = session.userId` **and**
`groupId = check.groupId`; ids in paths are `publicId`s.

```ts
interface AppNotification {
  publicId: string
  type: 'EXPENSE_NEW' | 'PAYMENT_RECEIVED' | 'DEBT_REMINDER' | 'RECURRING_DUE'
  actorId: number | null      // resolved to a name client-side with the session's members (incl. ex-members)
  // Implemented as a discriminated union on `type` (src/lib/types.ts), each variant with only its own params:
  // EXPENSE_NEW { description, amount, recurring } · PAYMENT_RECEIVED { fromUserId, amount } (payer)
  // DEBT_REMINDER { amount } · RECURRING_DUE { description, amount, dueOn }. Stored publicIds are not typed.
  params: { description?: string; amount: string; recurring?: boolean; dueOn?: string; fromUserId?: number }
  read: boolean
  createdAt: string           // ISO
}
```

| Method & path | Body | Success | Errors |
| --- | --- | --- | --- |
| `GET /api/notifications?filter=unread` | — | `200 { notifications: AppNotification[] (≤ 50, newest first), unreadCount, groupId }` | 401, 403 `NO_GROUP` |
| `GET /api/notifications/unread-count` | — | `200 { count, groupId }` | 401, 403 |
| `PATCH /api/notifications/{publicId}` | `{ read: true }` | `200 { unreadCount }` (idempotent) | 400 `NOTIFICATION_PATCH_INVALID`, 404 `NOTIFICATION_NOT_FOUND` |
| `POST /api/notifications/read-all` | — | `200 { unreadCount: 0 }` | 401, 403 |
| `DELETE /api/notifications/{publicId}` | — | `200 { unreadCount }` | 404 `NOTIFICATION_NOT_FOUND` |
| `GET /api/notification-preferences` | — | `200 { preferences: Record<NotificationType, boolean> }` | 401 |
| `PUT /api/notification-preferences` | `{ type, enabled }` | `200 { preferences }` | 400 `NOTIFICATION_PREF_INVALID` |
| `GET /api/cron/notifications` | header `Authorization: Bearer $CRON_SECRET` | `200 { ok: true, dueReminders, debtReminders, pruned, failed, remaining }` | 401 `CRON_UNAUTHORIZED` |

`groupId` in the two reads is the house the server answered for — the one `requireActiveGroup()` resolved
from the cookie, as the numeric id `useSession().activeGroup.id` holds. Another tab can switch the house
(the cookie moves) while this tab still shows the previous one: the bell (`notifications-context.tsx`) and the
page drop an answer whose `groupId` differs from the active house (`answeredForOtherHouse` in
`src/lib/notification-view.ts`) and re-read the session (`useSession().refresh`), so the screen follows the
cookie (ADR 0002) instead of listing house B's notices under house A.

Preferences are per user (all houses) and use `requireSession()` only. The cron route reuses
`requireCron` from spec 008, `dynamic = 'force-dynamic'`, `maxDuration = 60` and the same 30 s deadline as
the posting job: both scheduled producers take it, check it between units (rules, houses) and report the
units left over as `remaining`; units that threw are logged with ids only and counted in `failed`; prune
always runs (one statement). `vercel.json` `crons`
gains `{ "path": "/api/cron/notifications", "schedule": "0 12 * * *" }` (09:00 in Brasília; Hobby
window 12:00–12:59 UTC). Changed routes: `POST /api/expenses` and `POST /api/settlements` (one
`after(() => notifySafely(...))` each, after `recordActivity`, so the 201 never waits for the notices;
response shapes unchanged).

## UI

- **PWA files** — `public/manifest.json`:

  ```json
  {
    "id": "/",
    "name": "Home Share",
    "short_name": "Home Share",
    "description": "Shared household expenses, split right.",
    "start_url": "/expenses",
    "scope": "/",
    "display": "standalone",
    "background_color": "#f2f0e9",
    "theme_color": "#16140f",
    "icons": [
      { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
      { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
      { "src": "/icons/maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
    ]
  }
  ```

  `public/icons/{icon-192,icon-512,maskable-512,apple-touch-icon}.png` are rendered from
  `src/app/icon.svg` by `scripts/generate-pwa-icons.mjs` (`@resvg/resvg-js`, exact-pinned
  devDependency, prebuilt binaries; maskable = the glyph at 80 % on a full-bleed `#16140f` square so
  launchers can crop it). Run once, PNGs committed. `src/app/layout.tsx` `metadata` adds
  `manifest: "/manifest.json"`, `appleWebApp: { capable: true, title: "Home Share", statusBarStyle:
  "default" }`, `icons: { apple: "/icons/apple-touch-icon.png" }` (the existing `viewport.themeColor`
  stays).
- **Install logic** — `src/lib/install-prompt.ts`: a module store for the deferred
  `beforeinstallprompt` event (captured by `src/components/app/InstallPromptCapture.tsx`, mounted once in
  the ROOT layout `src/app/layout.tsx` — login soft-navigates into the app, so an event fired on `/auth/*`
  would be lost if the capture lived only in `(app)`; read through `useSyncExternalStore` with a constant
  server snapshot). An event fired before hydration (a slow phone) is kept by `EARLY_INSTALL_CAPTURE_SCRIPT`,
  an inline script first in the root layout's `<body>` (like `SCROLLBAR_GUTTER_SCRIPT`): it calls
  `preventDefault()` and stores the event on `window.__hsBip` (an early `appinstalled` as `window.__hsInstalled`);
  `startInstallPromptCapture` adopts them once, detaches the script's listeners (`window.__hsBipStop`) and removes
  the globals, so a later event is handled by the store alone. Also: a `promptUsed` flag (the one-time prompt was used or came back unavailable: the card
  then shows its body without an Install button and the sheet's Android tab shows the manual browser-menu
  step, instead of the "this browser can't install" text, which stays for browsers that never offer it), `appinstalled` listener, pure `isIos(userAgent, maxTouchPoints)`
  (incl. iPadOS reporting "Macintosh"), `isStandalone()` (`display-mode: standalone` or
  `navigator.standalone`), and the 30-day "Not now" stamp in `localStorage`
  (`homeshare.installDismissedUntil`, every access in try/catch).
- **Components** — `src/components/notifications/InstallBanner.tsx` (POC banner: icon, "Install Home
  Share", Install / Not now), `src/components/notifications/InstallSheet.tsx` (bottom sheet: Android
  native prompt path or the 3 iOS steps), `src/components/notifications/NotificationItem.tsx` (the avatar —
  actor, payer, or ↻ "Home Share" for automatic notices — stands for the type, whose label sits in the meta
  line; earlier draft: icon per
  type, text, "{relative time} · {type label}", unread dot, row button = mark read + navigate, ✕ remove),
  `src/components/notifications/NotificationPreferences.tsx` (type switches with descriptions + "App on
  home screen" card; spec 010 adds the push card on top).
- **Page** — `src/app/(app)/notifications/page.tsx`: title "Notices" + unread badge, install banner,
  segmented tabs Notices / Preferences, All/Unread filter, "Mark all read", day groups
  (`groupByDay(items, now)` in `src/lib/notifications.ts`, browser-local dates), empty state ("All
  caught up" stamp), limit notice at 50. Optimistic read/remove with rollback + toast on failure.
- **Bell** — `src/components/app/NotificationBell.tsx` in the `AppChrome` header, visible on mobile
  (before the drawer button) and desktop (before the user menu): 44 px target below `md`, 34 px from `md`
  (accepted deviation: the compact desktop header, where a 44 px button would grow it and shift the R3-08
  sidebar), `aria-label` with the count, badge hidden at 0. Count from `src/lib/notifications-context.tsx` (`NotificationsProvider`,
  mounted in `src/app/(app)/layout.tsx` inside the session) — refreshed on mount, active-house change,
  `visibilitychange`/`focus`, and by the page after read/remove.
- Amounts render through the existing money formatter with the active house currency; the actor name
  through the same display-name helper Activity uses (`src/lib/members.ts`).

### i18n keys (en/pt/es/fr)

`Notifications.*` (the bell's accessible name is `bellCount`; `bell` is kept in the 4 locales but unused —
keys are never removed; the page is reached from the bell, not from the sidebar list): `title` "Notices", `subtitle` "What happened in the house that concerns you",
`bell` "Notices", `bellCount` "{count, plural, =0 {No unread notices} one {# unread notice} other {#
unread notices}}", `tabs.notices` "Notices", `tabs.preferences` "Preferences", `filter.all` "All",
`filter.unread` "Unread", `markAllRead` "Mark all read", `group.today` "Today", `group.yesterday`
"Yesterday", `group.earlier` "Earlier", `unreadDot` "unread", `remove` "Remove notice", `allCaughtUp`
"All caught up", `emptyAll` "No notices here.", `emptyUnread` "No unread notices.", `limitNotice`
"Showing the 50 most recent.", `loadError` "Couldn't load your notices", `automatic` "Home Share",
`text.EXPENSE_NEW` "{actor} added “{description}” {amount}", `text.EXPENSE_NEW_RECURRING`
"“{description}” was posted automatically: {amount}", `text.PAYMENT_RECEIVED` "{payer} paid you
{amount}" (payer = `params.fromUserId`, resolved like the actor), `text.DEBT_REMINDER` "You owe {amount} in this house", `text.RECURRING_DUE` "“{description}”
is due tomorrow: {amount}", `types.EXPENSE_NEW.label` "New expense", `types.EXPENSE_NEW.description`
"When someone adds an expense you take part in", `types.PAYMENT_RECEIVED.label` "Payment received",
`types.PAYMENT_RECEIVED.description` "When someone records a payment to you",
`types.DEBT_REMINDER.label` "Debt reminder", `types.DEBT_REMINDER.description` "On Mondays, while you
owe money in the house", `types.RECURRING_DUE.label` "Recurring due dates",
`types.RECURRING_DUE.description` "The day before a recurring bill you pay is due", `prefsTypes` "Types
of notice", `toast.removed` "Notice removed.", `toast.allRead` "All marked as read.", `toast.prefOn`
"{label}: on.", `toast.prefOff` "{label}: off.", `install.bannerTitle` "Install Home Share",
`install.bannerBody` "Opens full screen, without the browser bar.", `install.install` "Install",
`install.notNow` "Not now", `install.notNowToast` "No problem. You can install later in Preferences.",
`install.sheetTitle` "Install the app", `install.android` "Android", `install.iphone` "iPhone",
`install.iosIntro` "Safari has no install prompt; it takes three taps:", `install.iosStep1` "Tap Share
(the square with an arrow) in Safari's bar.", `install.iosStep2` "Choose Add to Home Screen.",
`install.iosStep3` "Tap Add.", `install.iosDone` "I've added it", `install.installedStamp` "Installed",
`install.installedBody` "The icon is on your home screen. The app opens without the browser bar.",
`install.cardTitle` "App on home screen", `install.cardBody` "Opens full screen, without the browser
bar", `install.cardInstalled` "Installed: opens full screen", `install.unsupported` "Install isn't offered
here — use your browser's menu, or Share › Add to Home Screen on iPhone." (final review, owner-recommended
neutral copy: Chrome itself shows it whenever it is not offering the prompt, so it names no browser; earlier
"This browser can't install apps — use Chrome, Edge, or Safari on iPhone"). Added during implementation (fallbacks the list
lacked): `actionError`, `prefError`, `prefsLoadError`, and `install.androidMenu` (the sheet's Android manual-install step, used when
the one-time prompt is no longer available).

`ApiErrors.*`: `NOTIFICATION_NOT_FOUND`, `NOTIFICATION_PATCH_INVALID`, `NOTIFICATION_PREF_INVALID`.

## Error handling & edge cases

- **Producer failure** never reaches the user: `notifySafely` catches, logs (`logger.error`, no
  params) and returns; it runs in `after()`, so the expense/settlement response is already sent and
  unchanged, and a slow producer never delays it. In the recurring poster the call
  is wrapped the same way (an inline try/catch — services do not import `api-helpers`), after the
  posting transaction commits.
- **Recipient check vs. insert race** (accepted): `create` reads the active recipients, then inserts; a
  member who leaves the house or deletes their account between the two statements can still get that one
  notice. It is unreachable through the API (`requireActiveGroup` never resolves a house they left; a
  deleted account cannot sign in) and pruned within 90 days.
- **Duplicate cron delivery**: reminder inserts collide on `(userId, dedupeKey)` and are skipped.
  Event notices have no dedupe key (each request is one event); a retried client request that creates
  a second expense legitimately creates a second notice.
- **Missed cron day**: that day's due reminders are not sent later (a reminder for a date that already
  passed is noise); a missed Monday skips that week's debt reminder. Posting itself (spec 008) catches
  up independently. The same holds for units a run's deadline leaves over (`remaining` > 0 in the log) —
  always the highest ids, so if `remaining` is ever > 0, rotate the starting unit (ISO week / day of year
  modulo the count) before the same houses miss every Monday.
- **Member left / deleted**: never a recipient (active-member filter). Leaving or being removed
  (`groupService.removeMember`) deletes their notices of that house in the same batch transaction that sets
  `leftAt`, so a rejoin starts with an empty center (final review: the old ones used to come back); if the
  last-admin self-heal then restores the membership, those notices stay gone (rare race, accepted). On account
  deletion their rows and preferences are deleted.
- **Actor renamed/deleted**: names are resolved at read time from the house's member list, so a
  deleted account shows the anonymized name, like Activity.
- **Expense deleted after the notice**: the notice keeps its snapshot; tapping opens `/expenses`
  (the list), never a dead detail link.
- **House switch while on `/notifications`**: the page reloads for the new house; the bell follows the
  active house. A switch in **another tab** moves the cookie only: the next read answers with the other
  `groupId`, which the bell and the page drop before re-reading the session (API contract above).
- **Install**: `beforeinstallprompt` is absent in Firefox desktop and Safari macOS → banner hidden,
  Preferences card says install isn't offered here (browser menu / iPhone Share path); the event is
  single-use → after `prompt()` the stored event is cleared; `appinstalled` hides the banner. An event fired
  before hydration is kept by the root layout's inline script and adopted at the capture's start.

## Security & tenant isolation

- Reads and writes always filter by the session user **and** the server-resolved active house;
  `publicId` lookups are compound (`{ publicId, userId, groupId }`) → another member's or house's notice
  is a 404, indistinguishable from a missing one.
- Recipients come only from active members of the house where the event happened; `params` only carry
  data the recipient can already see in that house (description, amount).
- Notices and preferences are not written to `EntityRevision` (they are personal and Detailed is
  visible to every member).
- The cron route is cookie-less but bearer-guarded (shared `requireCron`), returns counts only.
- Bounds: 50 notices per list, 90-day retention, one notice per event per recipient, at most one
  reminder per (rule, period) and per (member, house, ISO week).
- PWA files are public static assets with no user data; the manifest's `start_url` still goes through
  the session middleware.

## Testing strategy

TDD per task.

- **Unit** — `src/lib/notifications.test.ts`: `notificationHref`, `groupByDay` (today/yesterday/earlier
  around midnight), `isoWeek` (year boundaries: 2026-12-31 → 2026-W53, 2027-01-04 → 2027-W01).
  `src/lib/install-prompt.test.ts`: `isIos` (iPhone, iPad, iPadOS "Macintosh" + touch, Android, desktop),
  dismissal window (29 vs 31 days, storage throwing), early capture (the inline script run on a fake window,
  adoption once, no double handling). `src/lib/notification-view.test.ts`: `answeredForOtherHouse`.
  `src/lib/prisma-audit.test.ts`: `WRITE_OPS` equals Prisma's write actions (`satisfies
  Record<Prisma.PrismaAction, …>`). `src/lib/pwa-manifest.test.ts`: manifest fields;
  every icon file exists and its PNG IHDR width/height equal `sizes`; apple-touch-icon is 180×180.
- **Integration** — real-DB cases in `src/services/tenant-isolation.test.ts` (describe "notification center
  (spec 009 …)"; the only file allowed to open the shared pglite DB), unit cases with Prisma mocked in
  `src/services/notification.service.test.ts`: expense recipients (author
  excluded, zero-share participant excluded, ex-member excluded, payer included); recurring posting →
  payer included and `recurring: true`; settlement recipient (self-recorded → none); preference off →
  no row; due reminder exactly the day before in America/Sao_Paulo (and not two days before, not when
  skipped or paused); debt reminder only on Mondays and once per ISO week; second job run inserts
  nothing; prune deletes > 90 days only; list/mark/delete scoped (other user / other house → 404 or
  unaffected); account deletion removes rows and preferences; leave/kick removes that house's notices only
  (a refused leave keeps them); `createManyAndReturn`/`updateManyAndReturn` on an audited model write one
  revision per returned row, while `SKIP_MODELS` still write none.
- **Routes** — `src/app/api/notifications/**/route.test.ts` (codes and scoping),
  `src/app/api/notification-preferences/route.test.ts`, `src/app/api/cron/notifications/route.test.ts`
  (401 cases, counts), `src/app/api/expenses/route.test.ts` and `src/app/api/settlements/route.test.ts`
  (`after` faked: the 201 comes before the producer runs, a never-settling producer does not hold it, a
  throwing one still yields 201 and is logged); `src/middleware.test.ts`: `/manifest.json`,
  `/icons/icon-192.png` and `/api/cron/notifications` pass without a cookie.
- **i18n** — `src/lib/i18n-parity.test.ts` (from spec 008) extended with `Notifications`.
- **Live (QA)** — on `homeshare-qa` (127.0.0.1:3100, QA Docker DB rebuilt offline + reseeded): two
  QA users; user A adds an expense → user B's bell shows 1 and the notice; toggling "New expense" off
  → next expense creates nothing; cron curl twice with the QA secret → reminders once. Install: Chrome
  DevTools › Application › Manifest shows no installability errors on localhost; the real Android and
  iPhone install happens on production (owner action 3).

## Owner actions

1. **Schema** — apply the additive schema (`NotificationType` enum, `Notification`,
   `NotificationPreference`) to production **before** this code reaches Production, after spec 008's
   schema (same procedure as spec 008's owner actions: `prisma migrate diff --from-config-datasource
   --to-schema prisma/schema.prisma --script` against the direct URL; this spec adds exactly 1 `CREATE TYPE`,
   2 `CREATE TABLE`, 3 `CREATE [UNIQUE] INDEX` and 4 `ADD CONSTRAINT … FOREIGN KEY`, no DROP/RENAME/ALTER
   COLUMN; then `prisma db push` and the `--exit-code` check). Agents never touch the production database.
2. **Cron** — no new secret: the job reuses `CRON_SECRET` from spec 008 (it must already be set). After
   the deploy, Vercel › Settings › Cron Jobs lists `/api/cron/notifications` (`0 12 * * *`); press
   **Run** once and check the counts in the log.
3. **Install check on real devices** (production HTTPS domain): Android Chrome → `/notifications` →
   Install; iPhone Safari → Share → Add to Home Screen. Both should open full screen at `/expenses`. On the
   iPhone also confirm the Share button location in the current iOS Safari matches `install.iosStep1`, and
   that an iOS < 16.4 device opens the icon without Safari UI (`apple-mobile-web-app-capable`).

## Alternatives considered

Each line: the chosen option first, then what was rejected and why.

- **Center scope** — the active house, like every screen (ADR 0002). Rejected: a cross-house inbox
  (needs house labels per row and a house switch on every tap, and breaks "every screen is the active
  house").
- **Notice content** — structured `params` rendered client-side with i18n. Rejected: storing rendered
  text (frozen in the author-side language and currency format; cannot follow a locale change).
- **Where notices are produced** — explicit calls in the two routes and the recurring poster, behind
  `notifySafely`. Rejected: a Prisma extension hook on writes (implicit; would also fire for CSV imports
  and cannot tell author from recipients); Postgres triggers (logic outside the codebase, no session
  actor — ADR 0005's objection); an outbox table + worker (another moving part with only a daily cron).
- **What a switch does** — "off" = no notice of that type (center and push alike, per the POC).
  Rejected: hide-only filtering (rows written for nothing, and push would need a second filter).
- **Preference scope** — per user, all houses. Rejected: per house (more UI for a rare need — v2).
- **Debt reminder cadence** — Mondays, at most once per ISO week. Rejected: the POC's literal "owed for
  more than 3 days" (needs per-member debt-start state or as-of-date balance recomputation); daily
  (the "too many notices → muted" risk); on every balance change (duplicates `EXPENSE_NEW`).
- **Due-date reminder recipient** — the rule's payer (the person who pays the bill). Rejected: every
  participant (they already get `EXPENSE_NEW` when it posts).
- **Manifest** — static `public/manifest.json` (skipped by the middleware matcher's anchored
  `manifest\.json$`). Rejected:
  `app/manifest.ts` (served at `/manifest.webmanifest`, which the matcher does not exclude — manifest
  fetches carry no cookie and would be redirected to login).
- **Service worker in this phase** — none. Rejected: a no-op worker "for installability" (not required
  by current Chromium criteria; lifecycle/update risk with no feature behind it).
- **Unread count freshness** — load, focus, house switch and own actions. Rejected: interval polling
  (function invocations all day for a badge); SSE/WebSocket (long-lived connections on serverless).
- **Icons** — PNGs rendered from `icon.svg` by a committed script. Rejected: hand-exported files (not
  reproducible); `next/og` icon routes (gated by the middleware, a function call per fetch).
- **Retention** — 90 days. Rejected: forever (unbounded table); 30 days (too short to look back over a
  month).
