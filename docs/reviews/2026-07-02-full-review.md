# Revisão completa — Home Share (bugs + engenharia)

**Data:** 2026-07-02 · Fluxo: ultracode + workflows (map→find→verify adversarial→síntese). Fase 2: 6 finders + 4 revisores (Fable). Fase 3: 26 céticos adversariais (Opus 4.8).

## Placar
- Bugs verificados adversarialmente: **25 CONFIRMED, 1 PARTIAL, 0 REFUTED** (crit/high/med)
- Bugs low (não-refutados, óbvios): 18
- Sugestões de engenharia: 35

---

## 🔴 CRÍTICO

### Unauthenticated account takeover: POST /api/auth/set-password sets a password on ANY password-null user by username, with no proof of ownership
**Arquivo:** `src/services/auth.service.ts:64` · **Veredito:** CONFIRMED

Traced the full unauthenticated path end-to-end; every link holds. middleware.ts:5,11-14 — PUBLIC_API_PREFIXES=['/api/auth','/api/health'] and pathname.startsWith('/api/auth') short-circuits to NextResponse.next(), so /api/auth/set-password is reached with NO session check. set-password/route.ts:7-34 — the handler validates only password length (validatePassword), calls authService.setInitialPassword(username,password), and on status 'ok' immediately signSession({userId: result.user.id,...}) and response.cookies.set(SESSION_COOKIE, token) — no requireSession, no ownership/OTP token. auth.service.ts:64-74 — setInitialPassword's ONLY gate is `if (user.password !== null) return {status:'invalid'}`; there is no googleId guard, so any account with password===null is writable by anyone who supplies its username. auth.service.ts:96-124 — findOrCreateGoogleUser creates every Google user with `password: null` (line 118) and never sets it later, making all Google accounts permanently claimable; login comment (line 54) confirms legacy users are also null. The username precondition is weak: uniqueUsernameFromEmail (line 78) derives usernames deterministically from the email local-part, group.service.ts:87,94 returns username in member lists to co-members, and login/route.ts:18-20 returns {requiresPasswordSetup:true} (HTTP 200) before any bcrypt check, oracle-confirming which usernames are null-password. Concrete exploit: unauthenticated POST /api/auth/set-password {"username":"victim","password":"attacker"} → bcrypt written to victim's row → session cookie issued as victim → full control of victim's houses/expenses. No guard refutes this; the flow's stated 'legacy first access' intent does not restrict it. Critical unauthenticated account takeover confirmed as described.

**Fix:** Require proof of ownership before issuing a session from set-password: gate the first-password flow behind either requireSession or a one-time out-of-band token, never sign a session from an unauthenticated set-password call, and explicitly refuse when user.googleId != null (Google accounts must never be claimable via password). Also make login return a uniform generic response instead of pre-auth requires_password_setup to close the enumeration oracle.

---

## 🟠 HIGH (6)

- **Despesas page fetches the group's ENTIRE expense history (pageSize=100000) on every mount and after every single mutation, with payload growing unboundedly**
  - `src/app/(app)/despesas/page.tsx:115` · CONFIRMED
  - Fix: Bound the default load server-side: either add cursor/keyset infinite scroll with a sane page size (e.g. 100-500) driven by scroll position, or default the initial query to the current month by pushing the date-range/payer filters into the /api/expenses query (add a date `where` clause in expense.service.ts:list). Keep reload() but have it re-fetch only the visible window rather than the entire history. Optionally lower the route's Math.min cap from 100_000 to a realistic max.

- **GET /api/balances loads the group's entire expense history with participant+user joins to compute a handful of aggregate numbers**
  - `src/app/api/balances/route.ts:14` · CONFIRMED
  - Fix: Replace the row-hydrating findMany with SQL aggregates: `prisma.expense.groupBy({ by: ['payerId'], where: { groupId }, _sum: { amount } })` for credits and `prisma.expenseParticipant.groupBy({ by: ['userId'], where: { expense: { groupId } }, _sum: { amount } })` for debits (Decimal sums are lossless → cents math stays exact), and compute byMonth/byCategory via a `$queryRaw` with date_trunc / unnest(categorias). Bound settlementService.list (paginate the payments history).

- **Login endpoint is an unauthenticated oracle: reveals whether a username exists AND whether it is takeover-eligible (password-null)**
  - `src/app/api/auth/login/route.ts:18` · CONFIRMED
  - Fix: Do not disclose password-setup state pre-authentication. Either return a uniform generic 401 for the password-null case (and drive first-access via an authenticated/token-gated flow), or at minimum require the same bcrypt-timed path so password-null accounts are indistinguishable from invalid-credential responses. Combine with rate limiting on /api/auth/*.

- **Expense rows/cards open the detail modal via onClick only — no tabIndex, role, or key handler, so keyboard users cannot view an expense at all**
  - `src/app/(app)/despesas/page.tsx:928` · CONFIRMED
  - Fix: Make the row's primary content a real button or give the row role="button" tabIndex={0} plus an Enter/Space onKeyDown that calls onView; alternatively (lowest-risk) add a "Ver detalhes" MenuItem to RowMenu (lines 1035-1039) that calls a new onView prop, so the detail modal is reachable from the already keyboard-accessible ⋯ menu. Also restore focus to the opener on modal close.

- **CSV export writes amounts with an unquoted comma decimal separator into a comma-separated file, producing a structurally corrupt CSV whose re-import silently truncates cents**
  - `src/services/expense.service.ts:277` · CONFIRMED
  - Fix: Emit a dot-decimal amount so the field contains no separator: `const amountStr = Number(e.amount).toFixed(2)` (drop the .replace) — parseMoneyValue already handles "26.50" via its hasDotDecimal branch, so the round-trip stays correct and the CSV is structurally valid. Alternatively wrap it in escapeCSV / quote it, but dot-decimal is cleaner for Excel/Sheets too.

- **Compras page never refetches when the active house changes, showing the previous house's shopping list indefinitely (lead (a) CONFIRMED)**
  - `src/app/(app)/compras/page.tsx:58-71` · CONFIRMED
  - Fix: Make the fetch depend on the active house. Replace the hand-rolled load/useEffect with useFetch<{ items: ShoppingItem[] }>("/api/shopping-items") (already keys on activeGroup?.id and discards stale responses), or minimally: pull activeGroup from useSession() and add activeGroup?.id to the load effect deps (keeping load's request-counter/stale-response guard). Mutations (add/toggle) already call load(), so only the group-change refetch is missing.

---

## 🟡 MEDIUM (19)

- **Modal always passes aria-describedby={undefined}, stripping Radix's Dialog.Description association — modal descriptions (e.g. "cannot be undone" delete warning) are never announced** — `src/components/ui/Modal.tsx:29` (PARTIAL)
  - Fix: Suppress the attribute only when there is no description so Radix can wire the association otherwise. Replace line 29 `aria-describedby={description ? undefined : undefined}` with a conditional spread on Dialog.Content: `{...(description ? {} : { "aria-describedby": undefined })}` (pass aria-describedby={undefined} only when !description; otherwise let Radix set aria-describedby={descriptionId}).
- **listWithCounts in all three tag services issues 1+N expense.count queries, each an unindexed array-contains scan (no GIN index on the String[] columns)** — `src/services/category.service.ts:13` (CONFIRMED)
  - Fix: Replace the per-tag count loop with one aggregate query per dimension, e.g. `SELECT tag, count(*) FROM "Expense", unnest(categorias) AS tag WHERE "groupId" = $1 GROUP BY tag` via $queryRaw, then map counts onto the tag list (0 for unseen tags). Optionally add GIN indexes on the three array columns if per-tag server-side filtering is ever added.
- **List view renders every expense TWICE — a desktop table row AND a mobile card are always mounted, with CSS hiding one — doubling render and DOM cost for all N rows** — `src/app/(app)/despesas/page.tsx:707` (CONFIRMED)
  - Fix: Gate rendering on a client `matchMedia("(min-width: 768px)")` hook so only the active variant (desktopRows OR mobileCards) is mounted, keeping the CSS `hidden`/`md:table` classes as a no-JS fallback. Apply the same to the by-person view's per-month table vs ul. This halves both React reconciliation and DOM node count for the list.
- **Google OAuth links a Google identity to an existing account by email without checking email_verified** — `src/services/auth.service.ts:99` (CONFIRMED)
  - Fix: In exchangeCodeForProfile (google-oauth.ts:54) read `email_verified` from the userinfo JSON and only pass `email` through when `email_verified === true` (else undefined). Then findOrCreateGoogleUser's link-by-email branch (auth.service.ts:99-107) will naturally skip unverified emails; identity remains keyed on `sub`/googleId.
- **No rate limiting on any auth endpoint (login, register, set-password, Google)** — `src/middleware.ts:5` (CONFIRMED)
  - Fix: Add per-IP + per-username throttling/lockout to the /api/auth/login, register, and set-password handlers (e.g. an Upstash/Redis or in-memory sliding-window limiter invoked at the top of each route, returning 429 after N failures), since Next middleware alone can't easily key on request body. At minimum backoff on repeated failed login/set-password attempts.
- **By-person desktop table's ⋯ row-action button is opacity-0 until mouse hover — it receives keyboard focus while fully invisible** — `src/app/(app)/despesas/page.tsx:666` (CONFIRMED)
  - Fix: Add a focus reveal to the span's class list: `group-focus-within:opacity-100` (or `has-[:focus-visible]:opacity-100`) alongside the existing `group-hover:opacity-100 max-md:opacity-100 pointer-coarse:opacity-100`.
- **"payment" tag tone fails WCAG AA contrast in BOTH themes (3.94:1 retro-mono, 3.49:1 bolitas) for its 11.2px text; selected payment chips also fail** — `src/app/globals.css:33` (CONFIRMED)
  - Fix: Darken the payment token to ~#75591f (default, globals.css:33) and ~#7a5c0e (bolitas, globals.css:73) to reach ~5:1 for text-pay-on-pay-soft; this also lifts the selected chip (text-paper on bg-pay) above 4.5:1. Separately nudge the bolitas --color-plat (#4f6f86, line 71) slightly darker to clear the 4.29:1 marginal case.
- **All form labels and column headers use --color-faint via .label-mono at 10.9px — ~3.0:1 contrast, far below AA** — `src/app/globals.css:182` (CONFIRMED)
  - Fix: In .label-mono (globals.css:182) swap `color: var(--color-faint)` for a darker token such as `var(--color-ink-soft)` (7.09:1 default / 5.86:1 bolitas, both AA-pass), keeping --color-faint only for genuinely decorative text. Verify the few call sites that intentionally re-tint (e.g. despesas/page.tsx:489 text-stamp, :727/:740 hover:text-ink) still override as intended.
- **Expense form has no error announcement: invalid state only silently disables the submit button, per-field errors are never rendered, and the async formError has no role="alert"** — `src/components/expenses/ExpenseFormModal.tsx:320` (CONFIRMED)
  - Fix: Wire Field's `error` to the control: generate an errorId, render the error `<p id={errorId} role="alert">`, and pass `aria-describedby={errorId}`/`aria-invalid` down to the child input (via context or cloneElement). In ExpenseFormModal, pass `error` to the amount/payer/description Fields (e.g. show "Informe o valor" when totalCents<=0 after a submit attempt) instead of only disabling the button, and add `role="alert"` (or aria-live="assertive") to the line-576 formError paragraph so server errors are announced.
- **In selection mode on mobile, tapping the card body does nothing — the only toggle target is the 16x16px checkbox** — `src/app/(app)/despesas/page.tsx:987` (CONFIRMED)
  - Fix: In selection mode, make the card body div's onClick call toggle(e.publicId) (via SelectionContext) instead of undefined, or wrap the card in a `<label>` around the checkbox so the whole ~full-width card is the tap target; keep the visual checkbox as the state indicator.
- **Per-member custom-split amount inputs have no label or aria-label — screen readers announce an unnamed edit field per member** — `src/components/expenses/ExpenseFormModal.tsx:472` (CONFIRMED)
  - Fix: Add aria-label={t("amountOf", { name: m.name })} to the value-mode Input at line 472, mirroring the percentOf slider at line 536 (and add the amountOf key to the four message files).
- **API accepts amounts/participant shares with more than 2 decimals; validation rounds with float toCents while Postgres Decimal(10,2) rounds the decimal string, so stored participants no longer sum to the stored amount — the zero-sum balance invariant breaks permanently** — `src/lib/api-helpers.ts:227` (CONFIRMED)
  - Fix: In validateExpenseInput (and validateSettlementInput) reject non-cent inputs, e.g. add after the amount checks: `if (Math.round(amount*100) !== fromCents(toCents(amount))*100 ...)` — simplest robust form: reject when `toCents(x)/100 !== Number(x.toFixed(2))` for amount and every participant.amount; OR normalize the returned data by round-tripping through fromCents(toCents(x)) before it reaches the service, so validation and Postgres see the identical value. equalSplit already emits clean 2-decimal shares, so normalizing `amount` alone fixes the splitEqually variant.
- **Saldos page has no stale-response guard: a slow in-flight /api/balances response from the previous house overwrites the new house's balances after switching** — `src/app/(app)/saldos/page.tsx:39-54` (CONFIRMED)
  - Fix: Add the same guard the other pages use: inside the effect, track ordering and drop stale results. Minimal patch — move the fetch into the effect with an `alive` flag (mirroring atividade/page.tsx), e.g. `useEffect(() => { let alive = true; setLoading(true); (async () => { try { const res = await api.get<BalancesResponse>("/api/balances"); if (alive) setData(res); } catch (err) { if (alive) toast(...); } finally { if (alive) setLoading(false); } })(); return () => { alive = false; }; }, [activeGroup?.id]);` — and keep a separately-callable `load` (or a reqId) for the onSaved/refresh paths. Or replace with `useFetch<BalancesResponse>("/api/balances")`.
- **Despesas page keeps payer filters, person tab, and selection state when the active house changes, producing wrong/empty views in the new house** — `src/app/(app)/despesas/page.tsx:121-137` (CONFIRMED)
  - Fix: In the existing activeGroup?.id-keyed effect (page.tsx:149-166), also reset the leaked UI state on house change: clearFilters(), setPersonTab(null), setSelected(new Set()), setSelectionMode(false). (Note: the stale bulk-delete already fails safely with a 404/error toast rather than deleting cross-tenant, but the reset removes the confusing empty/wrong views and the misleading selection count.)
- **Expense text search matches raw i18n tag keys instead of the labels the user sees, so searching a visible tag name (e.g. 'Mercado') excludes those expenses** — `src/app/(app)/despesas/page.tsx:182` (CONFIRMED)
  - Fix: In the filtered useMemo (line 182), build the haystack with translated labels for the three tag arrays (reuse tagLabel: e.categories.map((c) => tagLabel("category", c)).join(" "), same for platform/payment), and normalize both the haystack and q with a fold helper: s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase(). Apply the same normalization to q at line 172.
- **Editing a custom-split expense and toggling to 'by percent' silently re-seeds percentages to equal; saving then rewrites the stored split (e.g. 70/30 becomes 50/50)** — `src/components/expenses/ExpenseFormModal.tsx:185-190` (CONFIRMED)
  - Fix: In the open effect, when editing a non-equal split, derive the initial percent map from the participants' actual amounts instead of always calling equalPercents. E.g. compute pct[m.id] = round(participantCents/totalCents*100) and adjust the largest remainder(s) so the integers sum to exactly 100; only fall back to equalPercents for the new-expense (no expense) branch. Alternatively, re-derive percent from `custom`/participants at the moment the user switches to 'percent' mode in subToggle.
- **SessionProvider.refreshMembers has no stale-response guard, so rapid house switching can leave `members` from the wrong house across every page** — `src/lib/session.tsx:38-48` (CONFIRMED)
  - Fix: Mirror the useFetch pattern in refreshMembers: add a `const membersReqId = useRef(0)` and inside refreshMembers do `const id = ++membersReqId.current;` then only commit (`setMembers`/`setMembers([])`/`setMembersLoading(false)`) when `membersReqId.current === id`. Even simpler given the route already returns groupId: capture the target group id and only commit when `data.groupId === activeGroupId` (latest).
- **Saldos 'by category' breakdown labels every custom-category bucket as 'Uncategorized' because the label helper falls back to t('uncategorized') instead of the raw tag name** — `src/app/(app)/saldos/page.tsx:111` (CONFIRMED)
  - Fix: In saldos/page.tsx:111-112 change catLabel to reserve the uncategorized label only for the empty bucket and fall back to the raw name for customs: `const catLabel = (c: string) => !c ? t("uncategorized") : tcat.has(`category.${c}`) ? tcat(`category.${c}`) : c;` (mirrors despesas/page.tsx:236 and ExpenseDetailModal.tsx:32).
- **CSV export ignores the user's locale entirely: raw i18n keys in tag columns, hardcoded English headers, hardcoded pt-BR date format and comma decimals, hardcoded pt filename** — `src/services/expense.service.ts:273` (CONFIRMED)
  - Fix: Thread the request locale into exportToCSV: in export/route.ts call getLocale()/getTranslations() and pass them (plus locale) to exportToCSV. In exportToCSV, translate default-tag keys via the Expenses.category/platform/payment messages (custom names — those not in the DEFAULT_* / EXPENSE_CATEGORIES sets — pass through unchanged), translate the header row, and format date (toLocaleDateString(locale)) and amount with the locale's decimal separator; localize the filename too. Minimal alternative: keep the fixed pt-BR numeric/date format but at least map the default tag keys through the pt messages so no slugs leak.

---

## ⚪ LOW (18)

- [PERFORMANCE] All 4 Google font families are always loaded even though each theme uses only 2, shipping ~2 unused font families on every page — `src/app/layout.tsx:22`
- [PERFORMANCE] Expense list payload carries vestigial legacy columns (category, platformId, platformIds) plus notes/createdAt/updatedAt for every row, inflating the already fetch-all response ~15-20% — `src/services/expense.service.ts:69`
- [SECURITY / TENANT ISOLATION] POST /api/platforms accepts an unbounded platform name (missing length validation present on sibling routes) — `src/app/api/platforms/route.ts:31`
- [SECURITY / TENANT ISOLATION] Shopping-item name has no length limit on create or update — `src/app/api/shopping-items/route.ts:25`
- [SECURITY / TENANT ISOLATION] bulk-delete accepts an unbounded publicIds array (no max count) — `src/app/api/expenses/bulk-delete/route.ts:14`
- [UX / MOBILE / A11Y] Touch targets across the despesas toolbar and rows are 26-38px: the ⋯ row menu, filter/tag chips, and header selectors are all below the 44px minimum — `src/app/(app)/despesas/page.tsx:1029`
- [UX / MOBILE / A11Y] Modal close button aria-label is hardcoded pt-BR "Fechar" (and LanguageSelector trigger hardcodes English "Language") despite full 4-locale i18n with an existing Common.close key — `src/components/ui/Modal.tsx:51`
- [UX / MOBILE / A11Y] Sortable column headers expose sort state only via ▲/▼/↕ glyphs — no aria-sort on <th>, so screen readers can't tell the current sort column or direction — `src/app/(app)/despesas/page.tsx:721`
- [MONEY/CENTS CORRECTNESS] validateExpenseInput/validateSettlementInput never check that amount is a number, so non-numeric JSON amounts pass validation and blow up as a generic 500 in Prisma instead of a 400 — `src/lib/api-helpers.ts:198`
- [MONEY/CENTS CORRECTNESS] splitRatio rounds each participant's percentage independently, so the displayed ratio can sum to 99 or 101 instead of 100 — `src/app/(app)/despesas/page.tsx:903`
- [CORRECTNESS] Deleting a single expense (or reloading) never prunes the `selected` set, so the selection counter, confirm dialog, and bulk-delete result disagree — `src/app/(app)/despesas/page.tsx:358-371`
- [CORRECTNESS] By-person month grouping and date display use the viewer's local timezone while the range filter uses the UTC date slice, shifting expenses across day/month boundaries for viewers at large UTC offsets — `src/app/(app)/despesas/page.tsx:271-272`
- [CORRECTNESS] Header house switcher discards the switchGroup promise without a catch, so a failed switch is completely silent (and an unhandled rejection) — `src/components/app/AppChrome.tsx:96`
- [I18N COMPLETENESS] Shared Modal close button has hardcoded pt-BR aria-label="Fechar" although Common.close exists in all 4 locales — `src/components/ui/Modal.tsx:51`
- [I18N COMPLETENESS] Four emitted API error codes have no ApiErrors message in any locale (NAME_REQUIRED, NAME_TOO_LONG, INVALID_PLATFORM, INVALID_PAYMENT), so users get only a generic toast — `src/lib/api-helpers.ts:120`
- [I18N COMPLETENESS] LanguageSelector's own aria-label is hardcoded English "Language" although Common.language exists in all locales — `src/components/app/LanguageSelector.tsx:30`
- [I18N COMPLETENESS] Root layout metadata description is hardcoded English for all locales — `src/app/layout.tsx:38`
- [I18N COMPLETENESS] Two parallel pt-BR-hardcoded formatting helpers are dead code left behind by the i18n migration (lib/date.ts entirely; formatDateBR/formatBRL/formatSigned in lib/format.ts) — `src/lib/date.ts:15`

---

## 🔧 Backlog de engenharia (você decide)

| Impacto | Esforço | Risco | Sugestão |
|---|---|---|---|
| high | small | low | Fix stale shopping list after switching houses (missing activeGroup dependency) |
| high | small | low | Unify page data-loading on useFetch — fixes the stale-house bug in compras |
| high | small | low | Fix POST /api/platforms validation drift (typeof guard, PLATFORM_NAME limit, error codes) |
| high | medium | low | Close the activity-feed blind spots: bulk-delete and CSV import leave no usable audit trail |
| high | medium | low | Collapse the 6 tag route files into one parameterized factory (lib/tag-routes.ts) |
| medium | small | low | Migrate saldos + atividade hand-rolled loads to useFetch (kills a stale-response race) |
| medium | small | low | Collapse the 7 filter useStates into one ExpenseFilters state object |
| medium | small | low | Replace the silent tag-catalog effect in despesas with useFetch + error toast |
| medium | small | low | Deduplicate tag option-building and the i18n label fallback (4 copies across 3 files) |
| medium | small | low | POST /api/platforms: add type + length validation to match categories/payment-methods |
| medium | small | low | Move the balances computation out of the route handler into a service |
| medium | small | low | Merge MultiChips into ChipMultiSelect as one shared component |
| medium | small | low | Extract shared tag option-list builder and tag-label hook (used 3x and 4x) |
| medium | small | low | Delete the dead legacy formatting layer: lib/date.ts (whole file) + 4 dead functions in lib/format.ts + 3 in lib/currency.ts |
| medium | small | low | Prune ~21 dead i18n keys across all 4 locale files (removed pagination, platform-rename/move, and old select-based filters) |
| medium | medium | low | Move the list-row cluster (SelectionContext + ExpenseRow/Card + RowMenu) to components/expenses/ — pure file move |
| medium | medium | low | Extract ByPersonView from despesas page (~170 lines, no perf coupling) |
| medium | medium | low | Replace listWithCounts 1+N per-tag counts with one aggregate query per dimension |
| low | small | low | Merge MultiChips and ChipMultiSelect into one toggle-chip component |
| medium | medium | medium | Align the Platform model with Category/PaymentMethod: unique(groupId,name), required groupId, cascade |
| low | small | low | Retire the unused server-side pagination/sort surface of GET /api/expenses |
| low | small | low | Simplify import route body parsing to the one format the client sends |
| medium | medium | medium | Align Platform schema with Category/PaymentMethod: add @@unique([groupId, name]) and Group relation |
| medium | medium | medium | Unify the 3 tag services via a makeTagService factory, fixing the 1+N counts query once |
| low | small | low | Register the NAME_REQUIRED / NAME_TOO_LONG codes in the ApiErrors i18n namespace |
| low | small | low | Extract the duplicated T12:00:00 local-noon date parsing in api-helpers |
| medium | medium | medium | Drop vestigial Expense columns (category, platformId, platformIds) and fix the vacuous test that references one |
| low | small | low | Remove the unused EMPTY_FILTERS export (or actually use it) in ExpenseFiltersModal |
| low | small | low | Delete scripts/repair-wave1.mjs — one-off data repair whose job is done |
| low | small | low | Remove design-samples/ (496K, 8 HTML mockups) from the repo — the retro-mono decision is already made and shipped |
| low | small | low | Adopt a disposal policy for docs/superpowers/specs (2 untracked + 1 committed dated implementation specs) |
| low | small | low | Trim two micro dead spots: Stamp's never-used 'stamp' tone and lib/insights.ts's never-imported duplicate interfaces |
| medium | large | medium | Decide the fate of the dual audit systems (AuditLog manual feed vs EntityRevision automatic trail) — document now, consolidate later |
| low | medium | medium | Extract the custom-split editor from ExpenseFormModal (only if the form keeps growing) |
| low | medium | medium | Drop the three vestigial Expense columns (category, platformId, platformIds) |

### Detalhes das sugestões top

**Fix stale shopping list after switching houses (missing activeGroup dependency)** (i:high/e:small/r:low)
- Confirmed lead (a). compras/page.tsx:58-67 defines `load` with deps `[toast]` and the effect at :69-71 runs on `[load]` only — `activeGroup?.id` never appears, so `POST /api/groups/active` house switches leave the previous house's items rendered until a manual mutation. Concrete failure: open /compras in House A, switch to House B via the header — House A's items stay on screen; checking one even toggles a House-A item while the cookie points at House B. saldos/page.tsx:54 and atividade/page.tsx:42 both key their effect on `activeGroup?.id`; compras is the only outlier. Minimal fix (one dependency added) is simplicity-compliant; full useFetch migration is blocked here anyway because the page mutates `items` optimistically (toggle at :92-96, remove at :151).

**Unify page data-loading on useFetch — fixes the stale-house bug in compras** (i:high/e:small/r:low)
- Three loading patterns coexist for the same job. compras/page.tsx:58-71 hand-rolls `load = useCallback(..., [toast])` + `useEffect(..., [load])` with NO activeGroup dependency — switching houses leaves the previous house's shopping list on screen until a manual refresh (verified: nothing in the effect chain references activeGroup). saldos/page.tsx:39-54 hand-rolls the same thing correctly but needs an `eslint-disable-next-line react-hooks/exhaustive-deps` to do it. Meanwhile lib/use-fetch.ts already exists, keys on `activeGroup?.id`, and guards stale responses with a reqId counter — despesas/page.tsx:114 already uses it. Migrating both pages is a net code DELETION plus a real cross-tenant-display bug fix, so it strengthens (not violates) simplicity-first.

**Fix POST /api/platforms validation drift (typeof guard, PLATFORM_NAME limit, error codes)** (i:high/e:small/r:low)
- Confirmed real defect from clone drift. platforms/route.ts:29-33 reads `const { name } = body; if (!name || !name.trim())` while categories/route.ts:30-40 and payment-methods/route.ts:30-40 do `typeof body?.name === 'string' ? body.name.trim() : ''` plus a LIMITS check. Concrete failures today: (1) POST {"name": 5} throws TypeError on `name.trim()` → generic 500 instead of 400; (2) a direct POST with a 100k-char name is accepted and persisted (Prisma String → TEXT, no DB limit; LIMITS.PLATFORM_NAME=80 exists in lib/constants.ts:7 but is only enforced client-side via TagManager's maxLength). Copying the 10 lines from categories/route.ts is the minimum fix and violates nothing in simplicity-first — it restores parity, not new abstraction.

**Close the activity-feed blind spots: bulk-delete and CSV import leave no usable audit trail** (i:high/e:medium/r:low)
- Single expense delete records an AuditLog entry AND gets a per-row EntityRevision snapshot (prisma-audit.ts:125-129, `delete returns the removed row`). But bulk-delete/route.ts has no recordActivity call (grep confirms only 7 routes call it; bulk-delete and import are absent), and expenseService.bulkDelete uses deleteMany, which prisma-audit.ts:136-142 logs as one `bulk:N` marker containing only the where-clause of internal ids — the deleted rows' contents are unrecoverable. Concrete failure: a member bulk-deletes 30 expenses; the house's activity page shows nothing, and the Envers trail can't say what was deleted or for how much. The bulk-delete handler ALREADY does a findMany (route.ts:24-30, `select: { id: true }`) — widening that select and passing rows into recordActivity/changes is a few lines; same one-liner recordActivity for import. No new system, just consistent use of the two that exist.

**Collapse the 6 tag route files into one parameterized factory (lib/tag-routes.ts)** (i:high/e:medium/r:low)
- The 6 route files are line-for-line identical except service singleton, response key, LIMITS constant, and message nouns — and this exact cloning is what produced the platforms validation gap. Concrete shape: `makeTagCollectionRoutes({ service, key: 'categories', nameMax: LIMITS.CATEGORY_NAME, msgs })` returning `{ GET, POST }` and `makeTagItemRoutes({ service, msgs })` returning `{ DELETE }`; each route file becomes `export const { GET, POST } = makeTagCollectionRoutes({...})`. All three services already share the exact same method signatures (list/listWithCounts/create/delete take (groupId, ...)), so the factory needs only a structural interface, no generics gymnastics. This is the TagManager pattern (components/app/TagManager.tsx, used 3x in catalogos/page.tsx) applied server-side — the project already accepted this altitude of abstraction, and rule-of-three is met with a stable domain. Next drift (e.g., someone adds rename to one dimension only) becomes impossible.

**Migrate saldos + atividade hand-rolled loads to useFetch (kills a stale-response race)** (i:medium/e:small/r:low)
- saldos/page.tsx:41-54 and atividade/page.tsx:30-42 each re-implement load/loading/effect-keyed-on-activeGroup that useFetch (lib/use-fetch.ts:21-57) already provides — but WITHOUT its `reqId` stale-response guard (use-fetch.ts:39 `if (reqId.current === id)`). Concrete failure: switch House A→B quickly; the effect fires a second GET /api/balances while the first is in flight, and if A's response resolves last it overwrites B's balances on screen — exactly the class of bug the useFetch docstring says it exists to prevent. despesas and TagManager already use useFetch, so this is convergence to the established pattern, deleting ~15 lines per page, not new abstraction.

**Collapse the 7 filter useStates into one ExpenseFilters state object** (i:medium/e:small/r:low)
- The filter shape already exists as a type + empty constant (ExpenseFiltersModal.tsx:17-35 `ExpenseFilters`/`EMPTY_FILTERS`), yet page.tsx keeps it exploded into 7 useStates (:127-133) and then reassembles it three times: `appliedFilters` useMemo (:211-222), `applyFilters` doing 7 setters (:225-233), `clearFilters` doing 7 resets (:200-208), plus a 7-item dep list on the `filtered` memo (:187) and `activeFilterCount` (:189-196). One `useState<ExpenseFilters>(EMPTY_FILTERS)` makes applyFilters `setFilters(f)`, clearFilters `setFilters(EMPTY_FILTERS)`, `initial={filters}` naturally stable (memo deleted), and chip removal a single `setFilters(prev => ...)` helper — ~40 lines of plumbing removed. Filters are only ever committed atomically (modal apply, clear, chip remove), so a single object is the natural shape, not speculative structure. Zero interaction with the selection perf wiring.

**Replace the silent tag-catalog effect in despesas with useFetch + error toast** (i:medium/e:small/r:low)
- page.tsx:149-166 hand-rolls a triple fetch of /api/platforms, /api/categories, /api/payment-methods with `.catch(() => active && setPlatforms([]))` — failures are silently coerced to empty lists, breaking the app's own error convention (every other load surfaces useApiError via toast, e.g. the expenses load at :116). Concrete failure: /api/categories returns 500 → the filter modal and ExpenseFormModal render only system-default chips; a custom category the user filters by is simply absent with zero feedback, and when editing an expense its custom-category chip isn't visible/toggleable (it survives in the Set but the user can't see why). Three `useFetch` calls (or one combined) restore the reqId guard, the activeGroup keying the manual `[activeGroup?.id]` dep imitates, and the onError toast — while deleting the effect.

**Deduplicate tag option-building and the i18n label fallback (4 copies across 3 files)** (i:medium/e:small/r:low)
- The six options arrays `[...DEFAULT_X.map(k => ({value:k,label:t(`x.${k}`)})), ...custom.map(c => ({value:c.name,label:c.name}))]` are copy-pasted between ExpenseFormModal.tsx:145-156 and ExpenseFiltersModal.tsx:119-130, and the built-in-key-or-raw-name fallback `(ns,v) => t.has(`${ns}.${v}`) ? t(...) : v` is written three times (page.tsx:236 `tagLabel`, page.tsx:885 inside ExpenseTags, ExpenseDetailModal.tsx:32 `lbl`). This encodes the project's core tag rule ('system-default tags are i18n keys, custom tags are DB rows') in four places — adding a default payment method today requires touching all of them in lockstep, and a missed one silently renders the raw key (e.g. 'pix' instead of 'Pix') in one surface only. One small `useTagOptions(platforms, categories, paymentMethods)` hook + one `tagLabel(t, ns, v)` helper in lib is consolidation of existing multi-use code, not speculative abstraction.

**POST /api/platforms: add type + length validation to match categories/payment-methods** (i:medium/e:small/r:low)
- platforms/route.ts:29-33 does `const { name } = body; if (!name || !name.trim())` — no `typeof` check (a JSON body `{"name": 123}` throws TypeError on `.trim()` → generic 500 via handleApiError) and no LIMITS.PLATFORM_NAME check. Its two siblings do it right: categories/route.ts:30-40 and payment-methods/route.ts:30-38 both use `typeof body?.name === 'string' ? body.name.trim() : ''` + a LIMITS length guard with a stable error code. Worse, an over-long platform name gets stored but is then silently unusable: cleanTags (api-helpers.ts:161-172) drops any tag longer than LIMITS.PLATFORM_NAME from expense input. Copying ~8 existing lines restores the codebase's own convention — zero new abstraction.

**Move the balances computation out of the route handler into a service** (i:medium/e:small/r:low)
- balances/route.ts:14-42 is the only GET handler that owns raw prisma access plus a multi-step business composition (findMany with nested payer/participants.user includes → applySettlements(calculateBalances(...)) → simplifyDebts → toCents total → aggregateSpend), directly violating the project's own 'route handlers thin (validate, call service, respond)' rule that every other route follows (expenses, categories, settlements all delegate). Concrete payoff: the composition becomes unit-testable without HTTP plumbing, and it creates the single natural seam to later bound the unbounded full-history findMany (lead d) — e.g. dropping the nested `user` include that balance.ts only needs ids/names from — without touching the handler. It's moving ~25 existing lines behind `balanceService.summary(groupId)`, not adding abstraction.

**Merge MultiChips into ChipMultiSelect as one shared component** (i:medium/e:small/r:low)
- MultiChips (ExpenseFiltersModal.tsx:38-69) is a copy of ChipMultiSelect (ExpenseFormModal.tsx:58-91) with identical className strings; the copy dropped the `tone` prop, so the filters modal already shows visual drift — form chips are color-coded per dimension (CHIP_ON_TONES, border-cat/plat/pay) while filter chips for the same tags are all black. Concrete shape: extract `components/expenses/ChipMultiSelect.tsx` taking `{ options, selected: readonly string[], onToggle, tone?: TagTone }`; the form passes `[...selCategories]` (Set→array, sizes are tens of chips, no perf concern), the filters modal passes its arrays directly and gains `tone` for free. Any future chip styling tweak lands in one file. Two instances, but they render the same domain object side-by-side in the same flow — clarity favors one component, not two.

