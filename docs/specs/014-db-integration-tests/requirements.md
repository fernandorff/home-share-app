# Database integration tests (tenant isolation) — Requirements

Origins: `file:line` = read in the code at `main` `887c3a8` on 2026-11-13; _(inference)_ = deduced, not run or
measured. Paths without a folder are under `server/src/`.

## Problem

Since ADR 0014 (Rust-only repo, single branch, CI deploys) the service tests that ran against a real database left
with the Next app (commit `a811304`, `src/services/tenant-isolation.test.ts`, 3,278 lines on pglite). `cargo test`
runs unit tests only (`.github/workflows/ci.yml:62`) and a merge to `main` deploys to production, so nothing
automated stops a route edit that drops a `groupId` filter. ADR 0014 calls this "the first test debt to pay".

## User story

As the owner of Home Share, I want CI to prove on a real Postgres that a member of one house can never read or
change another house's data through any `/api/*` route, so that a missing house filter fails the PR instead of
reaching production on merge.

## Acceptance criteria (EARS)

Each criterion must be verifiable by a test (or a single curl) in ~10 seconds.

Terms used below:

- **Fixture**: house A (Alice admin, Bea member) and house B (Bob admin, Bea member), built through the API. Alice
  is a member of A only. Each house has one of each: expense split with Bea and tagged with a custom category
  named `Shared` (both houses own a `Shared` category), settlement with Bea, purchased shopping item linked to that
  expense, recurring rule, and Bea's notice for the expense. B also has a custom category, platform and payment
  method whose names A does not have (the "B-only tags").
- **Fingerprint of a house**: every row of the 16 tables with a `groupId` column (`prisma/schema.prisma`) for that
  house, its `Group` row, and the child rows reached through its parents (`ExpenseParticipant`,
  `ShoppingItemExpense`, `RecurringExpenseOccurrence`).
- **Handler counts** (`main.rs:99-152`, 51 paths, 70 method handlers): 48 take `ActiveHouse` (house handlers), 14
  take only `Session`, 8 take neither (health, login, register, logout, Google ×2, cron ×2). Of the 14, five live
  under `/api/auth`, which the gate treats as public (`main.rs:61`).

### Harness

1. WHEN `cargo test --manifest-path server/Cargo.toml --features db-tests` runs, THE SUITE SHALL send every
   request through the real router `app()` (`main.rs:97-161`) in-process (gate `main.rs:64-72`, `Session` and
   `ActiveHouse` extractors and handlers unchanged), against a Postgres whose schema comes only from
   `prisma/migrations` (balance triggers included, `prisma/migrations/2_precomputed_balances/migration.sql:84-152`).
2. WHEN `TEST_DATABASE_URL` is unset, its host is not `localhost`, `127.0.0.1` or `::1`, or its database name does
   not end in `_test`, or `SENTRY_DSN` is set (`observability.rs:49`), THE SUITE SHALL fail before opening any
   connection, naming the variable and never its value.
3. WHEN `cargo test` runs without `--features db-tests`, THE SYSTEM SHALL compile no database test and pass with no
   database (today's local gate unchanged).
4. WHEN a PR to `main` runs job `check`, THE CI SHALL migrate a throwaway `homeshare_test` database on the job's own
   Postgres service and run the suite there with the feature on; a failing test fails the job. THE CI SHALL never
   point the suite at `secrets.DATABASE_URL`, at the `shadow` database (Prisma wipes it, `ci.yml:20-21`) or at a
   local `homeshare_dev`.

### Auth basics

5. WHEN a request carries no `homeshare_session`, a garbage token, an expired token or a token signed with another
   secret, THE SYSTEM SHALL answer each of the 57 gated handlers (the 48 house handlers plus the 9 session-only
   handlers outside `/api/auth`) with 401 and the exact body `{"error":"Not authenticated"}` (no `code`,
   `main.rs:69`), and the fingerprints of A and B SHALL not change.
6. WHEN a request without a valid session reaches one of the 5 session handlers under `/api/auth`
   (`POST logout-all`, `POST password`, `GET|PATCH|DELETE me`), THE SYSTEM SHALL answer 401 `NOT_AUTHENTICATED`
   (`auth.rs:99-101`).
7. WHEN a member calls `POST /api/auth/logout-all` and then sends the old cookie to any of the 62 session handlers,
   THE SYSTEM SHALL answer 401 `SESSION_REVOKED` with a `Set-Cookie` that clears `homeshare_session`
   (`auth.rs:107-113`), and the member's house fingerprint SHALL not change.
8. WHEN a signed-in user with no active membership calls any of the 48 house handlers, THE SYSTEM SHALL answer 403
   `NO_GROUP` (`house.rs:41-43`).
9. WHEN `GET /api/cron/recurring-expenses` or `GET /api/cron/notifications` is called without
   `Authorization: Bearer <CRON_SECRET>`, THE SYSTEM SHALL answer 401 `CRON_UNAUTHORIZED` (`routes/jobs.rs:21-26`)
   and no fingerprint SHALL change.
10. WHEN a new handler is added to `app()` without an entry in the suite's handler list, THE SUITE SHALL fail
    (the list has exactly one entry per handler in `main.rs`).

### Tenant isolation (fixture)

11. WHEN Alice (active house A) calls one of the 20 handlers that take a house row's id with an id of B
    (expense GET/PUT/DELETE/history; settlement DELETE; category, platform and payment-method DELETE; shopping item
    PUT/DELETE/toggle/expenses; recurring rule PATCH/DELETE and skip PUT/DELETE; notice PATCH/DELETE; member
    DELETE/PATCH with Bob's id), THE SYSTEM SHALL answer 404 with the code listed in the design, and B's
    fingerprint SHALL not change.
12. WHEN Alice sends B's people, tags or expenses inside a body (expense create/update with Bob as payer or
    participant or with a B-only tag; settlement with Bob; recurring rule create/patch with Bob as payer; shopping
    links to B's expense; bulk delete of B's expense ids; CSV import with `payerId` Bob or a B-only platform),
    THE SYSTEM SHALL refuse with the status and code listed in the design, and B's fingerprint SHALL not change.
13. WHEN Alice bulk-deletes a list that mixes A's and B's expense ids, THE SYSTEM SHALL answer 200 with `deleted`
    equal to A's count, and B's fingerprint SHALL not change (`routes/expense_more.rs:42,53`).
14. WHEN Alice's body to create an expense, settlement, shopping item, category or recurring rule carries `groupId`
    set to B, THE SYSTEM SHALL ignore it and write into A (these handlers read only their own fields:
    `expense_input.rs:61-148`, `routes/settlements.rs:104-132`, `routes/shopping.rs:138`, `routes/tags.rs:106`,
    `routes/recurring.rs:321-329`); WHEN a body carries `expectedGroupId` set to B (expense create/update, recurring
    rule create/patch, shopping links), THE SYSTEM SHALL answer 409 `STALE_GROUP` and write nothing
    (`routes/expense_writes.rs:29-38`, `routes/recurring.rs:216-220`, `routes/shopping.rs:272-276`).
15. WHEN Alice calls the 14 list, aggregate and export handlers (`GET` balances, expenses with
    `includePayerTotals` and `includeMonthTotals`, expenses/export, settlements, shopping-items,
    categories?counts=true, platforms, payment-methods, recurring-expenses, activity, revisions, notifications,
    notifications/unread-count, groups/active/members), THE SYSTEM SHALL return no B public id, no B-only person,
    no B description and no B notice, and every count and total SHALL equal A's rows only.
16. WHEN Alice runs a house-wide write in A (clear purchased items, read all notices, change the currency,
    regenerate the join code, delete a custom category whose name B also uses on its expenses), THE SYSTEM SHALL
    change only A: B's fingerprint, currency, join code and tagged expenses SHALL stay as they were.
17. WHILE members of A create, edit and delete expenses and settlements, THE SYSTEM SHALL keep the `ETag` and body
    of B's `GET /api/balances` unchanged.
18. WHEN Alice sends `homeshare_group` set to B, THE SYSTEM SHALL answer as house A (`GET
    /api/groups/active/members` returns `groupId` A, lists hold A's rows, a new expense lands in A), never as B
    (`house.rs:44`).
19. WHEN Alice calls `POST /api/groups/active` with B's id, THE SYSTEM SHALL answer 403 and set no `homeshare_group`
    cookie (`routes/groups.rs:185-188`); WHEN she calls `POST /api/groups/join` with a code that matches no house,
    THE SYSTEM SHALL answer 404 `INVALID_CODE` and create no membership.
20. WHILE Bea's active house is A, THE SYSTEM SHALL leave her B notices out of A's notice list and unread count,
    and answer 404 `NOTIFICATION_NOT_FOUND` when she marks or deletes one of them (`routes/notifications.rs:90-97,109-115`).
21. WHEN a member leaves B or is removed from B, THE SYSTEM SHALL from then on answer B's ids with 404 (or 403
    `NO_GROUP` when they have no other house) and SHALL have deleted their B notices (`routes/groups.rs:351`).
22. WHEN any refusal in criteria 11–21 is checked, THE SUITE SHALL also send the matching request as a member of
    the row's own house and expect success, so a 404 can only come from house scoping, not from a broken request.
23. WHEN Bob calls `DELETE /api/push-subscriptions` with Alice's endpoint (her row seeded in SQL, since register
    answers 503 without VAPID keys, `routes/push.rs:95-97`), THE SYSTEM SHALL leave Alice's row in place
    (`routes/push.rs:146`).

### The suite bites

24. WHEN one house filter is removed on purpose (for example `AND e."groupId" = $2` in `routes/expenses.rs:69`),
    THE SUITE SHALL fail; checked once by hand, with both outputs (red, then green after restoring) in the PR.

## Out of scope

- Porting the rest of the old Next suite (audit snapshots and sensitive-field markers, notice producers and dedupe,
  push delivery, CSV parsing, recurring posting, membership and last-admin rules, balance arithmetic): it is used
  here only as an inventory of isolation cases.
- Push delivery with VAPID keys (it would send real HTTP to push services), the Google OAuth flow, rate-limit
  timing, Neon TLS (`server/gate/tls-check.sh` covers it), load.
- Privacy between people of the same house (join code shown only to admins, another member's notice) beyond what
  the fixture hits anyway.
- Fixing what the suite finds: each red test becomes its own fix PR.
- Moving the guard into the database (Postgres row-level security).

## Decisions (2026-11-13)

Taken by the owner on 2026-11-13, answering this spec's open questions.

- **CI.** The suite runs in job `check`, on the Postgres service the job already starts (`ci.yml:19-34`), in a
  throwaway `homeshare_test` database migrated with `prisma migrate deploy`. Never the `shadow` database, never
  `secrets.DATABASE_URL`. The CI line `cargo test` is replaced, not added, so there is no second Rust compile. Time
  measured locally on 2026-11-13 (not on a CI runner): `prisma migrate deploy` creating and migrating
  `homeshare_test` 5.6 s, `npx` start included; the built `cargo test --features db-tests` run (unit tests and the
  suite) 7.4–8.0 s with 4 test threads (two runs), the core count of a GitHub-hosted Linux runner _(inference: runner
  size not checked for this repository)_; 14.3 s with 2. The suite's code compiles into the same test binary, so the compile step barely
  grows _(inference)_.
- **Local run.** Documented in the design ("Local run") and in `CLAUDE.md`: a throwaway Postgres container, never
  the docker-compose `homeshare_dev` database.
- **Feature flag.** The suite sits behind the Cargo feature `db-tests`; plain `cargo test` still needs no database.
- **Remove-member message.** The two messages stay as they are (`routes/groups.rs:372-375` "Person not found" for
  an unknown person vs `326-336` "This person is no longer a member of this house" for someone of another house,
  same 404 `MEMBER_NOT_FOUND`); making them equal is a separate fix, later. The suite checks the code, not the
  message, for the member of another house.
