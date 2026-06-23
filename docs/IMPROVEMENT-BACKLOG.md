# Home Share — Improvement Backlog

Consolidated from: product audit (53 findings), engineering audit (35 findings), and a live + exhaustive
API smoke test (20 checks). Live runtime findings in `.audit-live-findings.md`.

## A. Data repairs (the REAL copied data is currently wrong — low risk, high trust)
- **A1** Balances don't reconcile (−18¢): 18 legacy expenses round each half UP (40,93 → 20,47+20,47). One-time
  re-split (largest-remainder) of any expense whose participant sum ≠ amount.
- **A2** Platforms orphaned: 7 platforms have wrong/null `groupId` → `/api/platforms` empty → can't pick a platform
  on new expenses. Re-point them to the active group. (New platforms already get correct groupId.)
- **A3** House has null `joinCode` → admin can't invite. Generate a code (+ UI: admin w/ no code → "Gerar código").

## B. Correctness bugs (small, low-risk; confirmed live)
- **B1** Custom split accepts NEGATIVE participant shares (inverts who-owes-whom). → reject < 0.
- **B2** Duplicate participants → raw 500 P2002 **and 500 bodies leak server file paths + Prisma internals**. → 400 + sanitize all 500s.
- **B3** Empty participants + splitEqually=false → silent all-members equal split. → require ≥1.
- **B4** Amount > 99.999.999,99 (Decimal(10,2)) → raw 500 overflow. → upper-bound validation.
- **B5** Pagination `page=abc/pageSize=-5` → 500. → clamp/guard.
- **B6** `/saldos` "Total de despesas" sums outstanding credit, not spend (shows R$0 when settled). → sum expense amounts.
- **B7** Platform delete self-replacement → silent platform loss on its expenses. → reject self-replacement.
- **B8** joinByCode check-then-create race → 500 on double-tap. → upsert / catch P2002.
- **B9** CSV import bypasses description(200)/notes(1000) limits + unchecked cross-group platformId. → validate per row.
- **B10** Typed `ApiError` so service not-found returns 404 (not 500) with a translatable `code`.

## C. Design polish (on-brand retro-mono; low risk)
- **C1** Unified `PageHeader` (real H1) across all screens (despesas/plataformas use a tiny h2 today).
- **C2** Settled "QUITADO" stamp on /saldos when balance == 0 (uses the unused Stamp rubber-stamp).
- **C3** Shared `.focus-ring` on all icon/menu/toggle triggers (keyboard a11y).
- **C4** Replace emoji/₪ empty-state icons with mono glyphs / the existing SVG icons.
- **C5** Carry `.paper-grain` texture into the logged-in app (esp. the /saldos "extrato" card).
- **C6** By-person row menu reachable on touch (today hover-only → unusable on mobile).
- **C7** Currency-aware amount label in the expense form (hardcoded "R$").
- **C8** Toasts announced to screen readers (aria-live) + glyph so type isn't color-only.

## D. Features (new functionality / fields)
- **D1 ★ Settle up / record payments** — Settlement entity + balance integration + history. THE #1 gap: debts never
  clear today. (needs migration; additive, low risk)
- **D2 ★ Edit history / audit log** (user requested) — track create/edit/delete of expenses (who, when, what changed),
  shown as "Histórico" on the expense. Extensible to other entities. (needs migration)
- **D3** Expense search + filter bar (text, person, platform, date range) — client-side first.
- **D4** Per-expense participant selection (split among a subset of members).
- **D5** Expense categories (groceries/rent/utilities) + spending breakdown.
- **D6** Show split/participants at a glance on each row (payload already has them).
- **D7** createdById on Expense (who logged it, vs payer).
- Later: recurring expenses, receipt URL, monthly insights, soft-delete/Lixeira, member nicknames, shopping quantity.

## E. Engineering (architecture / performance / tests)
- **E1** Reusable `useFetch` hook (fixes saldos stale-on-house-switch + compras stale closure; removes 4 copies).
- **E2** Trim list endpoint to omit the participant graph (biggest payload cut, zero UI change).
- **E3** Cache Intl formatters + memoize SessionProvider value + slim Money's context read (~600 cells).
- **E4** Cache Prisma on globalThis in PROD + tune Neon pool (prod connection-exhaustion risk). 
- **E5** `LIMITS` single source of truth (front/back drift) + delete dead i18n-migration code.
- **E6** Localize backend validation/admin errors via `code` (today they degrade to a generic toast).
- **E7** Tests: `validateExpenseInput`, `money`/mask round-trip, services (split + tenant isolation), balance edges.
- **E8** Decompose 659-line DespesasPage; single-layout render; React.memo rows (perf headroom).
- **E9** Balance via DB aggregate; CSV batch writes; bulk-delete in one query.

---

## Recommended sequencing (waves)
- **Wave 1 — Correctness & trust** (A1–A3, B1–B10, E4, E1, E5, E7-core): fix the real data, kill every bug found,
  shore up prod stability + add the core money tests. Low risk, makes the app trustworthy.
- **Wave 2 — Killer features** (D1 Settle up, D2 Edit history): the #1 gap + your explicit ask.
- **Wave 3 — Usability & polish** (D3 search/filter, C1–C8 design cluster, D6 split-at-a-glance).
- **Wave 4 — Depth** (D4 participants, D5 categories, E2/E3/E8 perf, then recurring/insights/receipts…).

Each wave: implemented with tests + verified live (desktop+mobile) + presented for you to validate (accept/reject).
