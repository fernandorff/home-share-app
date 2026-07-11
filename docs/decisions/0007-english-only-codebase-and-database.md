# English-only codebase and database

- Status: accepted
- Date: 2026-07-11

**Decision:** everything a developer or agent reads is English — code, comments,
identifiers, API error messages, page URLs, cookie names, and the database schema (no
`@map`; Prisma-default PascalCase tables / camelCase columns). User-facing text lives
ONLY in the i18n catalogs (`src/messages/`, en/pt/es/fr); API errors carry a stable
`code` that the client localizes (`ApiErrors`/`CsvErrors` namespaces).

## Context and Problem Statement

The app started as a personal pt-BR project ("La Casa das Bolitas") and accumulated
Portuguese everywhere: table/column names, error strings, URLs, identifiers, cookie names.
It is now published and distributed with a public repo. What language does the codebase
speak to contributors and to AI agents?

## Decision Drivers

- Public repo: contributors (and their AI tools) can't be assumed to read Portuguese.
- Mixed-language code poisons agent context — an agent greps for "expense" and misses
  `item_compra`, or re-invents a concept the pt name already covered.
- The app was already fully i18n'd for USERS (4 locales) — the pt in the code was
  developer-facing, serving no product purpose.

## Considered Options

1. **Full English (code + DB + URLs + errors-as-codes)** — ✅ chosen.
2. Keep the pt/en mix — ❌ permanent contributor/agent friction that only grows with
   the codebase; the migration cost was lowest *now*.
3. English code but keep pt DB names via `@map` — ❌ raw SQL and psql sessions still
   speak Portuguese; the `@map` layer exists only to preserve the debt.

## Decision Outcome

Executed 2026-07-11 in three deployable waves: (A) English page routes with 308
redirects + `homeshare_*` cookies; (B) ~60 files of strings/comments/identifiers +
structured CSV error codes; (C) DB rename — 119 metadata-only `ALTER … RENAME`
statements applied to prod in one transaction (rehearsed offline against pglite until
the catalog was byte-identical to the `@map`-free schema; record in
[docs/migrations/](../migrations/README.md)).

Intentional survivors: native language names (`Português`, `Français`) in the language
picker, pt CSV header aliases in the parser (old spreadsheets keep importing), non-ASCII
test fixtures, and historical pt data in audit/revision rows.

### Consequences

- Good: one language for contributors, agents, SQL consoles, and logs; grep works.
- Good: user-visible language is now exclusively an i18n concern — adding a locale
  touches only `src/messages/`.
- Bad: existing users were logged out once (cookie rename) and old audit summaries
  remain pt (historical data is not rewritten).
- Bad: API error `message` strings are English fallbacks — clients must localize via
  `code` (the `useApiError` hook already enforces this pattern).

### Confirmation

- CI suite (231 tests) runs against the English schema (pglite boots from it).
- Sweep check: a Unicode scan for pt-accented characters in `src/` (excluding
  `src/messages/`) returns only the intentional survivors listed above.
