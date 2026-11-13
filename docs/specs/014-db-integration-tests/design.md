# Database integration tests (tenant isolation) — Design

Origins: `file:line` = read in the code at `main` `887c3a8` on 2026-11-13; _(inference)_ = deduced, not run or
measured. Paths without a folder are under `server/src/`.

## Approach

**Where the tests live.** The server is a binary-only crate (no `lib.rs`), so `server/tests/*.rs` cannot import
`app` or `AppState`. The suite is an in-crate module, `server/src/db_tests/`, declared in `main.rs` as
`#[cfg(all(test, feature = "db-tests"))] mod db_tests;` with `[features] db-tests = []` in `server/Cargo.toml`.
An in-crate test that needs a database already exists (`main.rs:190-207`).

**How a test calls the server.** Each test builds its own state and router, exactly as `main()` does
(`main.rs:179-184`):

- `AppState { pool: pool(&cfg), keys: Arc::new(Keys::new("test-secret")), vapid: None }`, with `cfg` from
  `Config::from_env` (`config.rs:26`) fed `DATABASE_URL = TEST_DATABASE_URL`, `JWT_SECRET = "test-secret"`,
  `DATABASE_POOL_MAX = 4`. `pool` is private to the crate root (`main.rs:84`); a child module can call it
  _(inference: Rust privacy rules)_.
- `app(state, <a directory that does not exist>, false)`: API routes never touch the web directory
  (`static_files.rs:122-123`).
- Requests go through `tower::ServiceExt::oneshot` (`tower` with `util`, `server/Cargo.toml:9`; already used at
  `static_files.rs:127`) and bodies are read with `axum::body::to_bytes` (axum 0.8.9, `src/body/mod.rs:48` in the
  crate source). **No new dependency.**

**Who calls.** Users are created by `POST /api/auth/register`, which sets the real session cookie; without an
`x-real-ip`/`x-forwarded-for` header it has no rate limit (`routes/account.rs:44-50,187-191`). Usernames get a
UUID v7 suffix so tests never collide. Houses come from `POST /api/groups`, whose answer carries the join code
(`routes/groups.rs:151`); Bea joins with `POST /api/groups/join`. Expired tokens and tokens signed with another
secret are minted with `Keys::sign` (`auth.rs:58`).

**The fixture** (`two_houses()`) builds A and B through the API, so triggers, audit rows and notices are written as
in production, and returns the cookies and public ids. **The fingerprint** (`fingerprint(group_id)`) reads
`to_jsonb` of every row listed in requirements ("Terms"), each table ordered by the row's text (the `Balance*` tables
and `GroupVersion` have no `id`); a refusal is checked by comparing B's
fingerprint before and after. Positive controls (criterion 22) run after the refusal; destructive ones (a delete)
run last in their test.

**The handler list.** One `const` entry per handler (method, path template, guard: none, bearer, session, house)
drives criteria 5–8. A test counts the `routes::<module>::<fn>` handler references inside `app()` in
`include_str!("../main.rs")` and fails when the list length differs (criterion 10).

**One database per run.** Every test seeds its own uniquely named people and houses and cleans nothing up; the CI
database is thrown away with the job.

**CI** (`.github/workflows/ci.yml`, job `check`): the job already starts `postgres:16-alpine` (`ci.yml:19-34`) and
installs Node and Prisma (`ci.yml:42`). Two changes:

```yaml
      - run: npx prisma migrate deploy
        env:
          DATABASE_URL: postgresql://postgres:postgres@localhost:5432/homeshare_test
      # replaces the current `cargo test` line (ci.yml:62): unit tests and the database suite in one run
      - run: cargo test --manifest-path server/Cargo.toml --features db-tests
        env:
          TEST_DATABASE_URL: postgresql://postgres:postgres@localhost:5432/homeshare_test
```

`prisma migrate deploy` "applies all pending migrations, and creates the database if it does not exist"
([Prisma CLI reference](https://www.prisma.io/docs/orm/reference/prisma-cli-reference), read 2026-11-13). It is the
same command the deploy job runs on production (`ci.yml:93-95`). Fallback if that ever changes:
`docker exec ${{ job.services.postgres.id }} createdb -U postgres homeshare_test`
([GitHub contexts, `job.services.<id>.id`](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts)).

**Local run** (decision of 2026-11-13: a throwaway Postgres, never the docker-compose `homeshare_dev`). The same
commands are in `CLAUDE.md`. Always pass `DATABASE_URL` inline: `prisma.config.ts` otherwise reads `.env.local` /
`.env`, which may point elsewhere (a variable already set wins over those files).

```sh
docker run -d --rm --name homeshare-test-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:5442:5432 postgres:16-alpine
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5442/homeshare_test npx prisma migrate deploy
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5442/homeshare_test \
  cargo test --manifest-path server/Cargo.toml --features db-tests
docker stop homeshare-test-pg   # --rm removes the container and its data
```

- `prisma migrate deploy` created the missing `homeshare_test` itself (measured 2026-11-13, Postgres 16 in Docker
  on Windows), as CI relies on.
- Use `127.0.0.1`, not `localhost`, with a port published on `127.0.0.1`: on Windows `localhost` tries `::1` first,
  and every new pool connection waited about 2 s before falling back (measured 2026-11-13: one single-query test
  2.15 s with `localhost`, 0.11 s with `127.0.0.1`; the whole run 25.5 s vs 7.9 s with 4 test threads). The
  `localhost` in the CI URLs is a Linux runner, where the service port answers on both _(inference: not measured)_.
- Port 5442 lies outside the ranges Windows reserves on the machine where it was measured
  (`netsh int ipv4 show excludedportrange protocol=tcp`); pick another free one if it is taken.

## Data model

None. The suite reads the schema as the migrations leave it.

## API contract

None changed. What the suite covers, route by route (51 paths, 70 handlers, `main.rs:99-152`):

| Path | Methods | Extractor | How it is scoped |
|---|---|---|---|
| `/api/health` | GET | none | no house data; `?db=1` runs `SELECT 1` (`routes/health.rs:17-30`) |
| `/api/balances` | GET | ActiveHouse | totals and payments `WHERE "groupId" = $1`; process cache keyed by house id (`routes/balances.rs:96-125,169`) |
| `/api/expenses` | GET, POST | ActiveHouse | list `e."groupId" = $1` (`routes/expenses.rs:143-144`); create: payer and participants active in A, tags default or A's, row written with A (`routes/expense_writes.rs:126-129,140`) |
| `/api/expenses/{id}` | GET, PUT, DELETE | ActiveHouse | lookup `publicId AND groupId` (`routes/expenses.rs:69`); update re-locks `id AND groupId` (`routes/expense_writes.rs:214`); delete after the scoped lookup (`routes/expense_writes.rs:274`) |
| `/api/expenses/bulk-delete` | POST | ActiveHouse | select and delete both carry `"groupId"` (`routes/expense_more.rs:42,53`) |
| `/api/expenses/export` | GET | ActiveHouse | `WHERE e."groupId" = $1` (`routes/expense_more.rs:141`) |
| `/api/expenses/import` | POST | ActiveHouse | platform default or A's, payer active in A, rows written with A (`routes/expense_import.rs:88-107,131-133`) |
| `/api/expenses/{id}/history` | GET | ActiveHouse | scoped lookup, then revisions of A (`routes/expense_more.rs:85,91`) |
| `/api/categories`, `/api/platforms`, `/api/payment-methods` | GET, POST | ActiveHouse | list, counts and duplicate check by A; insert with A (`routes/tags.rs:81,85,121,128`) |
| `/api/categories/{id}`, `/api/platforms/{id}`, `/api/payment-methods/{id}` | DELETE | ActiveHouse | scoped lookup; the tag is pulled only from A's expenses (`routes/tags.rs:157,169-182`) |
| `/api/settlements` | GET, POST | ActiveHouse | list by A (`routes/settlements.rs:79`); both people must be (ex-)members of A (`routes/settlements.rs:140-147`) |
| `/api/settlements/{id}` | DELETE | ActiveHouse | scoped lookup (`routes/settlements.rs:198-204`) |
| `/api/groups` | GET, POST | Session | the caller's own active memberships (`routes/groups.rs:100-106`); create makes a new house, caller admin (`routes/groups.rs:119-153`) |
| `/api/groups/join` | POST | Session | **house chosen by the join code** (by design); 20 tries a minute per person (`routes/groups.rs:204,213-215`) |
| `/api/groups/active` | POST | Session | **`groupId` read from the body**, the one exception to "never from the body"; membership checked, else 403 (`routes/groups.rs:178,185-188`) |
| `/api/groups/active/members` | GET | ActiveHouse | `m."groupId" = $1` (`routes/groups.rs:245-249`) |
| `/api/groups/active/members/{userId}` | DELETE, PATCH | ActiveHouse | remove: person looked up across all users, then an active membership in A is required (`routes/groups.rs:372-375,336`); promote: lookup joined to A's active members (`routes/groups.rs:400-408`) |
| `/api/groups/active/currency` | POST | ActiveHouse | `UPDATE "Group" … WHERE "id" = A` (`routes/groups.rs:283`) |
| `/api/groups/active/regenerate-code` | POST | ActiveHouse | same (`routes/groups.rs:307`) |
| `/api/groups/active/leave` | POST | ActiveHouse | the caller's membership in A (`routes/groups.rs:357-360`) |
| `/api/notifications` | GET | ActiveHouse | `"userId" AND "groupId"` (`routes/notifications.rs:44`) |
| `/api/notifications/unread-count` | GET | ActiveHouse | same (`routes/notifications.rs:26`) |
| `/api/notifications/read-all` | POST | ActiveHouse | same (`routes/notifications.rs:70`) |
| `/api/notifications/{id}` | PATCH, DELETE | ActiveHouse | `publicId AND userId AND groupId` (`routes/notifications.rs:90,110`) |
| `/api/notifications/test` | POST | Session | the caller's own subscriptions; 503 without VAPID (`routes/push.rs:156,162`) |
| `/api/notification-preferences` | GET, PUT | Session | per person, no house (`routes/notifications.rs:122,148-151`) |
| `/api/push-subscriptions` | POST, DELETE | Session | per person, no house; register 503 without VAPID; an endpoint registered again moves to the new person, by design (`routes/push.rs:95-97,118-122,146`) |
| `/api/recurring-expenses` | GET, POST | ActiveHouse | list by A (`routes/recurring.rs:268,282`); payer and participants active in A (`routes/recurring.rs:335`) |
| `/api/recurring-expenses/{id}` | PATCH, DELETE | ActiveHouse | `publicId AND groupId`, then payer or admin (`routes/recurring.rs:235,240-242`) |
| `/api/recurring-expenses/{id}/skips/{period}` | PUT, DELETE | ActiveHouse | same lookup (`routes/recurring.rs:524`) |
| `/api/activity` | GET | ActiveHouse | `a."groupId" = $1` (`routes/activity.rs:27`) |
| `/api/revisions` | GET | ActiveHouse | `r."groupId" = $1`; the borrowed `before` also from A (`routes/activity.rs:83,109`) |
| `/api/auth/login`, `/api/auth/register` | POST | none | `User` rows only (`routes/account.rs:152-219`) |
| `/api/auth/logout` | POST | none | clears the cookies (`routes/account.rs:221-223`) |
| `/api/auth/logout-all` | POST | Session | bumps the caller's `sessionVersion` (`routes/account.rs:243-248`) |
| `/api/auth/password` | POST | Session | the caller only (`routes/account.rs:259-289`) |
| `/api/auth/me` | GET, PATCH, DELETE | Session | GET lists the caller's houses, join code only where admin (`routes/account.rs:315-330`); PATCH renames, and a trigger bumps the balance version of every house the caller is in (`prisma/migrations/2_precomputed_balances/migration.sql:141-147`); DELETE leaves every house of the caller (`routes/account.rs:427-437`) |
| `/api/auth/google`, `/api/auth/google/callback` | GET | none | `User` rows only (searched for SQL, not read line by line, `routes/google.rs:160-200`) |
| `/api/cron/recurring-expenses`, `/api/cron/notifications` | GET | bearer `CRON_SECRET` | **every house**, by design (system jobs, `routes/jobs.rs:21-36,58-60`) |
| `/api/shopping-items` | GET, POST | ActiveHouse | list by A; insert with A (`routes/shopping.rs:131,149-150`) |
| `/api/shopping-items/clear-purchased` | DELETE | ActiveHouse | `WHERE "groupId" = $1` (`routes/shopping.rs:247`) |
| `/api/shopping-items/{id}` | PUT, DELETE | ActiveHouse | `publicId AND groupId` (`routes/shopping.rs:104,178,198`) |
| `/api/shopping-items/{id}/toggle` | PATCH | ActiveHouse | same (`routes/shopping.rs:217`) |
| `/api/shopping-items/{id}/expenses` | PUT | ActiveHouse | item scoped (`routes/shopping.rs:293`); expenses `"groupId" = A` (`routes/shopping.rs:307-316`) |

Outside `/api`: `POST /monitoring` (Sentry tunnel, `static_files.rs:91`) and the web app fallback
(`static_files.rs:119-150`) hold no house data.

### Survey findings

- **No isolation gap found by reading.** Every lookup of a house row in the 48 house handlers carries
  `groupId = house.group_id` (table above). The suite is what turns this reading into proof.
- **Session-only handlers that touch house data**, all by design: house switch (`groupId` from the body, membership
  checked), join (by code), list and create houses, `/api/auth/me` GET/PATCH/DELETE, and the two cron routes
  (bearer, every house).
- **Low:** removing a member answers a different message for an unknown person and for a person of another house
  (same 404 `MEMBER_NOT_FOUND`), so a house admin can learn whether a user id exists anywhere
  (`routes/groups.rs:372-375` vs `326-336`). User ids are random UUID v7 values seen only by co-members
  _(inference)_.
- **By design, worth a test:** a `homeshare_group` cookie for a house the person is not in falls back silently to
  their oldest house (`house.rs:44`), so the request is answered as A, not refused.
- **Not read line by line:** push delivery in `push.rs` beyond `schedule` (`push.rs:279-287`), `observability.rs`
  beyond `set_user` and the DSN, the page gate in `static_files.rs`, `routes/jobs.rs` after line 60 (searched for
  `groupId` only), `audit.rs` beyond `sanitize`, `routes/google.rs` and `routes/account.rs:1-139` (searched for SQL
  only), `routes/balances.rs:1-79` (the queries at 93-136 were read), `expense_input.rs` (searched for the body keys
  it reads), `csv.rs` (not opened).

## UI

None.

## Error handling & edge cases

Expected answers for criterion 11 (Alice, active house A, B's id in the path):

- Expense GET, PUT, DELETE, history → 404 "Expense not found" (`routes/expenses.rs:84`,
  `routes/expense_writes.rs:178-180,188,274`, `routes/expense_more.rs:85`). PUT looks the row up before reading
  the body, so any body works.
- Settlement DELETE → 404 "Payment not found in this house" (`routes/settlements.rs:203`).
- Category, platform, payment-method DELETE → 404 "<Label> not found" (`routes/tags.rs:160-163`).
- Shopping item PUT, DELETE, toggle, expenses → 404 "Item not found" (`routes/shopping.rs:98-100`). PUT needs a
  non-empty `name` first (`routes/shopping.rs:171-175`); expenses needs a valid `expenseIds` array first, e.g.
  `{"expenseIds": []}` (`routes/shopping.rs:277-279`).
- Recurring rule PATCH (body `{"paused": true}`), DELETE, skip PUT/DELETE → 404 `RECURRING_NOT_FOUND`
  (`routes/recurring.rs:223-225`); the period must be a valid `YYYY-MM` first (`routes/recurring.rs:517`).
- Notice PATCH (body `{"read": true}`) and DELETE → 404 `NOTIFICATION_NOT_FOUND` (`routes/notifications.rs:20-22`).
  Positive control: the notice's owner (Bea, active in B), never just any member — notices are personal.
- Member DELETE and PATCH (body `{"role": "ADMIN"}`) with Bob's id → 404 `MEMBER_NOT_FOUND`
  (`routes/groups.rs:326-328,408`). Positive control: Bob promotes Bea, then removes Bea, as the last step (removing
  himself is 400 `CANNOT_REMOVE_SELF`, `routes/groups.rs:377-379`).

Expected answers for criterion 12 (B's ids in the body):

- Expense create or update with Bob as payer or a new participant → 400 "Payer or participant is not a member of
  this house" (`routes/expense_writes.rs:126-128,202-205`); with a B-only tag → 400 `INVALID_CATEGORY`,
  `INVALID_PLATFORM` or `INVALID_PAYMENT` (`routes/expense_writes.rs:62-75`). The B-only names must not be system
  defaults (`routes/tags.rs:114-117`).
- Settlement with Bob → 400 "Payer or recipient is not a member of this house" (`routes/settlements.rs:145-147`).
- Recurring rule create, or field patch of A's rule, with Bob as payer → 400 `RECURRING_MEMBER_INACTIVE`
  (`routes/recurring.rs:212,335,448-451`). The patch must carry the rule's `expectedUpdatedAt`, else it stops at 400
  `RECURRING_PATCH_INVALID` first (`routes/recurring.rs:434-436`).
- Shopping links (A's purchased item) to B's expense → 404 `EXPENSE_NOT_FOUND` (`routes/shopping.rs:314-316`).
- Bulk delete of B's ids only → 404 "No expenses found" (`routes/expense_more.rs:48-50`).
- CSV import with `payerId` Bob → 400 "Payer is not a member of this house"; with a B-only platform → 400
  "Invalid platform" (`routes/expense_import.rs:88-107`).

Traps the harness must avoid:

- **Wrong database.** Only `TEST_DATABASE_URL`, local host and a database name ending in `_test` (criterion 2), so
  never `DATABASE_URL`, `shadow` or `homeshare_dev`.
- **Sentry.** The server reports 5xx answers to `SENTRY_DSN` when it is set (`observability.rs:5,49`); the suite
  refuses to start while it is set (criterion 2), so a failing test never reaches the real project.
- **Process-wide state.** The balance cache is keyed by house id and version (`routes/balances.rs:77-78,107,169`)
  and the rate limiter is static (`rate_limit.rs:12`). A second database in the same run would reuse house ids and
  could be served another database's cached body, hence one database per run. Fresh people per test keep the
  join limit (20 a minute per person, `routes/groups.rs:204`) out of the way.
- **Pool size.** `GET /api/balances` holds one connection and asks for five more in parallel
  (`routes/balances.rs:93,111-125`): a pool of 1 would wait forever _(inference)_. Four per test keeps parallel
  tests under Postgres' default of 100 connections _(inference)_.
- **Runtime.** Each `#[tokio::test]` has its own runtime; the pool is built inside the test, never shared through a
  `static` _(inference: deadpool connections run on the runtime that opened them)_.
- **Push.** `vapid: None`: notices are still written, nothing is sent (`push.rs:280`); register and the test
  push answer 503 (`routes/push.rs:95-97,156`). Push routes are covered for auth (criteria 5–7) and for unregister
  scoping with a row seeded in SQL (criterion 23).
- **Cron secret.** Read from the process environment (`routes/jobs.rs:23`), shared by parallel tests; the suite
  never sets it.
- **Recurring rules post at once when due** (`routes/recurring.rs:358,580-592`): take fingerprints after the
  fixture is complete, never inside it.

## Alternatives considered

Where the test database comes from:

- **The Postgres service job `check` already runs (chosen).** Pros: already there (`ci.yml:19-34`), the same
  `postgres:16-alpine` image as local docker-compose; Node and Prisma are already installed in the job, so the
  schema comes from `prisma migrate deploy`, the command production uses; no new dependency. Cons: the suite needs
  `TEST_DATABASE_URL` and a migrated database, so a local run needs a throwaway Postgres container and two commands;
  Postgres 16 in CI vs whatever Neon runs in production _(not checked)_.
- testcontainers (Rust crate). Pros: `cargo test` starts its own Postgres, no variable to set. Cons (rejected): two
  new dev-dependencies, Docker needed on every machine that runs `cargo test`, slower start, and the migrations still
  need Node or a hand-written runner; it duplicates what CI already provides.
- Embedded Postgres binaries (`postgresql_embedded` and similar). Pros: no Docker at all. Cons (rejected): downloads
  binaries at test time, new dependency, version drift from production.
- A throwaway Neon branch per CI run. Pros: the production engine and its TLS path. Cons (rejected): needs a Neon
  API key in CI (absent on PRs from forks), depends on the network, costs money; Neon's TLS path is already covered
  by `server/gate/tls-check.sh`.
- pglite, as the old Next suite did. Pros: in-process, no server. Cons (rejected): JavaScript/WASM, no way to run it
  from the Rust test process.

How the suite is wired:

- `server/tests/` after splitting the crate into `lib.rs` + `main.rs` — rejected: moves every module and
  `AppState` for no gain over an in-crate module.
- `#[ignore]` plus `cargo test -- --include-ignored` — rejected: that also runs the TLS test
  (`main.rs:196-207`), which panics without `TLS_TEST_URL`; a name filter avoids it, but a typo in the filter
  passes CI with zero tests.
- The harness applying `prisma/migrations/*/migration.sql` itself — rejected: a second migration runner that can
  drift from `prisma migrate deploy`.
- Seeding the fixture in SQL — rejected: the API writes triggers, audit rows and notices exactly as production
  does; SQL only for the fingerprint and the push row.
