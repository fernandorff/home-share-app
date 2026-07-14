# One-time migrations (historical record)

## 2026-07-14 — Legacy expense synchronization

Imported expenses added to the still-active legacy `la-casa-das-bolitas` database after the
initial Home Share migration, then reconciled the Home Share household to the exact legacy expense
count and total. The script defaults to a rollback-only dry run, takes both URLs exclusively from
the environment, locks the target expense tables during its short transaction, and refuses to
commit unless expense ids, totals, payer totals, and participant sums validate exactly.

- [sync-legacy-expenses-2026-07-14.mjs](sync-legacy-expenses-2026-07-14.mjs)

## 2026-07-11 — Portuguese → English database rename

Applied to prod on 2026-07-11 as part of the English-only migration. **Already executed —
never run again.** Kept as the record of how the rename was done and verified.

- [rename-db-to-english.sql](rename-db-to-english.sql) — 8 table + ~54 column renames
  (metadata-only `ALTER … RENAME`).
- [rename-db-to-english.followup.sql](rename-db-to-english.followup.sql) — 53 constraint/
  index/sequence renames, **generated** by pairing old/new names via their definitions.
- [generate-followup.mjs](generate-followup.mjs) — generator + verifier: builds two
  in-process pglite DBs (old schema + renames vs. fresh @map-free schema) and asserts the
  final catalogs are byte-identical, so the build's `prisma db push` is a no-op.
- [rehearse-rename.mjs](rehearse-rename.mjs) — the offline rehearsal (catalog diff).
- [apply-rename-prod.mjs](apply-rename-prod.mjs) — applied both SQL files to prod in ONE
  transaction (the breakage window only opens at COMMIT), immediately before the deploy.
- [prisma.rehearse.config.ts](prisma.rehearse.config.ts) / [schema.english.prisma](schema.english.prisma) —
  rehearsal wiring; the schema variant is what became `prisma/schema.prisma`.

Paths inside the scripts still say `scripts/…` — that's where they lived when they ran.
