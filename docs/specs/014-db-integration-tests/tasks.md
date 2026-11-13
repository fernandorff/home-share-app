# Database integration tests (tenant isolation) — Tasks

Each task names its exact file(s) and the requirement it satisfies. Order = dependency order.

- [x] 1. Feature flag and module wiring: `[features] db-tests = []`; `#[cfg(all(test, feature = "db-tests"))] mod db_tests;`
      — `server/Cargo.toml`, `server/src/main.rs` _Requirements: 1, 3_
- [x] 2. Harness: start guard (`TEST_DATABASE_URL` local host and `_test` database, `SENTRY_DSN` unset; name the
      variable, never the value), per-test `AppState` (pool max 4, `vapid: None`) and `app()`, request helper over `oneshot` with a cookie jar,
      `register` / `create_house` / `join` helpers, `fingerprint(group_id)` — `server/src/db_tests/mod.rs`
      _Requirements: 1, 2_
      - Done as: `check_env` (a pure function, so criterion 2 has its own test) runs before `crate::pool`, whose bad-URL
        path exits the process. No jar that absorbs `Set-Cookie`: each `User` carries its session and the
        `homeshare_group` cookie is set per request (`in_house`), because create and join both set it.
- [x] 3. Handler list (70 entries: method, path template, guard) and the test that compares its length with the
      handler references in `app()` — `server/src/db_tests/mod.rs` _Requirements: 5, 6, 7, 8, 10_
- [x] 4. Auth basics: no/garbage/expired/foreign-secret cookie, `/api/auth` session handlers, revoked session after
      `logout-all`, no house, cron without bearer — `server/src/db_tests/auth.rs` _Requirements: 5, 6, 7, 8, 9_
- [x] 5. Two-house fixture built through the API, as defined in requirements "Terms" (Alice in A; Bob in B; Bea in
      both; one row of each kind in each house, a `Shared` category in both, B-only tags) — `server/src/db_tests/mod.rs`
      _Requirements: 11–23_
- [x] 6. Foreign id in the path (20 handlers) with positive controls — `server/src/db_tests/isolation.rs`
      _Requirements: 11, 22_
- [x] 7. Foreign ids and `groupId` / `expectedGroupId` in the body, mixed bulk delete, CSV import —
      `server/src/db_tests/isolation.rs` _Requirements: 12, 13, 14, 22_
- [x] 8. Lists, aggregates, export, and B's balances `ETag` while A writes — `server/src/db_tests/isolation.rs`
      _Requirements: 15, 17_
- [x] 9. House-wide writes, foreign `homeshare_group` cookie, switch and join, Bea's two houses, leaving and removal,
      push unregister with a seeded row — `server/src/db_tests/isolation.rs` _Requirements: 16, 18, 19, 20, 21, 22, 23_
- [x] 10. CI: `npx prisma migrate deploy` on `homeshare_test` of the job's service; replace the `cargo test` line
      with `--features db-tests` and `TEST_DATABASE_URL` — `.github/workflows/ci.yml` _Requirements: 4_
- [x] 11. Docs: the gates line ("Nenhum toca banco" no longer holds for CI) and the local run commands from the
      design — `CLAUDE.md` _Requirements: 3, 4_
- [x] 12. The suite bites: remove `AND e."groupId" = $2` from `server/src/routes/expenses.rs:69` locally, run the
      suite (red), restore (green); paste both outputs in the PR — manual, nothing committed _Requirements: 24_
      - Run on 2026-11-13, two variants. Removing the clause literally leaves `$2` bound but unused, so Postgres
        refuses the query ("expected 1 parameters but got 2", 500) and 14 tests fail while building the fixture: red,
        but not a leak. Replacing it with `AND $2::int IS NOT NULL` (the filter gone, the parameter still used) leaks:
        `GET /api/expenses/{B's id}` as Alice answers 200 with B's expense, and 2 tests fail
        (`foreign_ids_in_the_path_are_not_found`, `leaving_or_removal_ends_access`). Restored, 71 passed.
- [x] 13. Verify: `cargo test --manifest-path server/Cargo.toml` green with no database;
      `--features db-tests` green against a local `homeshare_test`; CI green on the PR; every criterion maps to a
      named test (list it in the PR description).
      - Local parts done on 2026-11-13; CI green on the PR (fernandorff/home-share-app#95, 72 passed).

## Criteria → tests

Test names are under `server/src/db_tests/`.

- 1: every test (`server()` builds `app()` like `main()`); the schema comes only from `prisma migrate deploy`.
- 2: `refuses_a_database_that_is_not_a_local_test_one` (and the same check in `server()`).
- 3: the `cargo test` gate without the feature (no test compiles the module).
- 4: `.github/workflows/ci.yml`, job `check`.
- 5, 6: `auth::requests_without_a_valid_session_are_refused`.
- 7: `auth::a_revoked_session_is_refused_everywhere`.
- 8: `auth::a_person_without_a_house_gets_no_group`.
- 9: `auth::cron_routes_need_their_bearer`.
- 10: `the_handler_list_has_one_entry_per_handler_in_app`, `public_entries_are_real_routes`; 7 and 8 also walk the
  list through the real extractors, so a wrong path or method fails there.
- 11: `isolation::foreign_ids_in_the_path_are_not_found`.
- 12: `isolation::foreign_people_tags_and_expenses_in_the_body_are_refused`.
- 13: `isolation::a_mixed_bulk_delete_removes_only_the_own_house_rows`.
- 14: `isolation::a_house_id_in_the_body_never_picks_the_house`.
- 15: `isolation::lists_and_totals_hold_only_the_active_house`.
- 16: `isolation::house_wide_writes_change_only_the_active_house`.
- 17: `isolation::b_balances_stay_put_while_a_writes`.
- 18: `isolation::a_foreign_house_cookie_falls_back_to_the_own_house`.
- 19: `isolation::switching_and_joining_need_a_real_house`.
- 20: `isolation::notices_follow_the_active_house`.
- 21: `isolation::leaving_or_removal_ends_access`.
- 22: the positive controls inside the tests of 11–21.
- 23: `isolation::push_unregister_removes_only_the_callers_row`.
- 24: task 12 (manual).
- Also: `the_fingerprint_lists_every_house_table` keeps the fingerprint's 16 tables equal to the tables that have a
  `groupId` column.
