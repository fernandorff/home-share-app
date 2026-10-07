# UI Test Loop · Round 1 Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 72 "a corrigir" findings of round 1 of the UI test loop (desktop 1440, notebook 1093, phone 390/360; EN/PT/ES/FR; Default and Bolitas skins) without changing product behavior that needs a decision.

**Architecture:** Most findings are presentation bugs in the design system (`src/components/ui`) and in the pages under `src/app/(app)`; a few are logic gaps (expense history ignores the split, equal-split detection uses current members, Activity misses events, CSV errors have no code). Logic changes are test-first (Vitest, pure functions in `src/lib` / services). Presentation changes are verified by round 2 of the loop (prints + automatic layout measurements + functional checks in `screenshots/loop-2026-09-27`).

**Tech Stack:** Next.js 16 App Router, React 19, Tailwind v4 (CSS-first, `@layer`), Radix Dialog/DropdownMenu, next-intl (EN/PT/ES/FR), Prisma 7 + Postgres, Vitest.

**Spec:** `screenshots/loop-2026-09-27/achados.json` (84 findings; this plan covers every entry with `"estado": "a corrigir"`) and the visual report `screenshots/loop-2026-09-27/RELATORIO.html`. Mobile rules come from `docs/specs/003-mobile-navigation-drawer/requirements.md` (criterion 7: primary buttons, icon buttons and segmented controls ≥ 44px tall below 768px; removable chips ≥ 32px).

## Global Constraints

- English in all code, comments, identifiers and URLs; UI text only through `src/messages/{en,pt,es,fr}.json` (every new key in all 4 files).
- `cn()` in `src/components/ui/cn.ts` only joins strings (no tailwind-merge): two utilities for the same CSS property do NOT override by class order. Never rely on "the later class wins".
- Money stays integer cents (`lib/currency`); comparisons are exact.
- Mobile-first; animations stay behind `prefers-reduced-motion`.
- `npm run test` (vitest) must stay green; `npx tsc --noEmit` clean; `npx eslint src` must not gain errors (1 pre-existing error in `src/app/auth/login/page.tsx:33`).
- **No commits** (the owner commits later, on a branch he chooses). Leave changes unstaged.
- Never touch the Neon databases in `.env` / `.env.local`. The loop runs against the Docker container `homeshare-qa-pg` (127.0.0.1:55432) through the QA dev server on 127.0.0.1:3100.
- Out of scope (need a product decision, see `achados.json` "decidir"): B5 server month totals, B9, B10 promote admin, U21, I7, I11, I12, D3, D4, D5, D6, T8.

---

### Task 1: Design-system color precedence, contrast and layout stability

Findings: **A6** (label-mono overrides colors), **U3** part (Money ignores passed color), **A2** (primary hover 3.88:1), **A4** (error banner 4.496:1), **A5** (Bolitas platform chip 4.29:1), **A7** (11.2px text), **U14** (scrollbar layout shift).

**Files:**
- Modify: `src/app/globals.css` (`.label-mono` block inside `@layer utilities`, Bolitas theme tokens, `html` rules)
- Modify: `src/components/ui/Money.tsx`
- Modify: `src/components/ui/Button.tsx:9,18`
- Modify: `src/components/ui/Stamp.tsx:58` (Tag)
- Modify: `src/app/auth/login/page.tsx:67`, `src/app/auth/register/page.tsx` (error banner)

- [ ] **Step 1:** Move `.label-mono` out of `@layer utilities` into `@layer components` (keep the same declarations). Then `grep -rn "label-mono" src --include=*.tsx` and inspect every element that combines `label-mono` with a `text-*` size or color utility: with the move, the utility now wins. Keep the ones that intend a color (`text-debt`, `text-stamp-text`, `text-credit`, `text-faint`) and remove any size utility whose new effect would differ from the old 0.75rem look.
- [ ] **Step 2:** `Money.tsx`: apply the default tone only when the caller did not pass a color:
  ```tsx
  const hasColor = /\btext-(ink|ink-soft|faint|debt|credit|stamp|stamp-text|paper)\b/.test(className ?? "");
  const tone = hasColor ? undefined : signed ? (n > 0 ? "text-credit" : n < 0 ? "text-debt" : "text-ink") : "text-ink";
  ```
- [ ] **Step 3:** `Button.tsx` primary: `hover:bg-stamp hover:border-stamp` → `hover:bg-stamp-text hover:border-stamp-text` (the token comment in `globals.css:26` already says stamp-text is the AA-safe companion behind light text).
- [ ] **Step 4:** Login and register error banner: `text-debt` → `text-stamp-text` (same `bg-stamp-soft`). Verify ratio ≥ 4.5 with the script in Step 7.
- [ ] **Step 5:** Bolitas theme: darken `--color-plat` so `--color-plat` on `--color-plat-soft` is ≥ 4.5:1 (currently #4f6f86 on #e0e8ee = 4.29). Pick the closest hue that passes (compute with Step 7), mirroring what was already done for `--color-pay`.
- [ ] **Step 6:** Text floor 12px (project rule BL-22): `Tag` `text-[0.7rem]` → `text-[0.75rem]`; `Button` size `sm` `text-[0.7rem]` → `text-[0.75rem]`. Add `html { scrollbar-gutter: stable; }` in `globals.css` (base layer) so pages with and without a scrollbar, and modals that lock scroll, keep the same x positions.
- [ ] **Step 7:** Contrast check (run, paste the numbers in the task report):
  ```bash
  node -e 'const L=h=>{const c=[1,3,5].map(i=>parseInt(h.slice(i,i+2),16)/255).map(v=>v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4));return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2]};const r=(a,b)=>{const x=L(a),y=L(b);return ((Math.max(x,y)+0.05)/(Math.min(x,y)+0.05)).toFixed(2)};for(const [a,b] of process.argv.slice(1).map(s=>s.split(":")))console.log(a,b,r(a,b))' "#b23a22:#f7e6e1" "<new plat>:#e0e8ee" "#f4efe6:#b23a22"
  ```
- [ ] **Step 8:** `npx tsc --noEmit` and `npm run test` green.

### Task 2: Toasts and modal layering

Findings: **U1** (toast covers modal footers and takes taps), **U2** (stacked dialog overlay below the first modal), **U8** (long words overflow dialogs), **A9** (✕ focus ring hugging the corner).

**Files:**
- Modify: `src/components/ui/Toast.tsx:37-49`
- Modify: `src/components/ui/Modal.tsx:38,71-81`
- Modify: `src/app/globals.css`

- [ ] **Step 1:** Toast container gets a stable hook class (`toast-region`) and toasts stop taking pointer events (they have no interactive content): remove `pointer-events-auto` from the toast item.
- [ ] **Step 2:** While any dialog is open, the toast region moves to the top edge (so it never sits over a sheet footer):
  ```css
  @layer components {
    body:has([role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]) .toast-region {
      top: 1rem;
      bottom: auto;
    }
  }
  ```
- [ ] **Step 3:** `Modal.tsx` overlay `z-40` → `z-50`. All overlays and contents then share z-50 and stack by portal order (overlay1 < content1 < overlay2 < content2), so a confirmation dims the modal under it.
- [ ] **Step 4:** Modal body (`min-h-0 flex-1 overflow-y-auto p-4`) adds `[overflow-wrap:anywhere]` so unbroken strings wrap instead of creating horizontal scroll.
- [ ] **Step 5:** Close button: keep a ≥ 44×44 hit area but keep the focus ring inside the header: replace `-m-4 p-4` with a size-based box, e.g. `-mr-2 -mt-2 grid h-11 w-11 place-items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink`.
- [ ] **Step 6:** Loop check (round 2): J5 duplicate category, J6 regenerate code, J2 conflict — toasts at the top, footer visible; J2 "guarda-descartar" shows the form dimmed; J4 "confirmar-excluir-item" has no `rolagemHorizontal`/`passaDaBorda`.

### Task 3: App chrome, navigation, 404 and public layout

Findings: **A1** (sidebar `aria-current`), **D1** (header name 112px), **T3** (`@username` uppercased), **D20** (drawer left edges), **U9** (404), **D18** + **D23** (auth layout), **A3** part (Google button 41px, onboarding "log out" 62×18), **D19** (onboarding actions misaligned).

**Files:**
- Modify: `src/components/app/AppChrome.tsx:69-93,121-136`
- Modify: `src/components/app/MobileNavDrawer.tsx` (panel paddings)
- Create: `src/app/not-found.tsx`
- Modify: `src/app/auth/layout.tsx`
- Modify: `src/components/auth/GoogleButton.tsx`, `src/components/app/Onboarding.tsx`
- Modify: `src/messages/{en,pt,es,fr}.json` (new `NotFound` namespace)

- [ ] **Step 1:** Sidebar `<Link>`: add `aria-current={isActive(href) ? "page" : undefined}` (same predicate that paints the item).
- [ ] **Step 2:** User menu trigger name: `max-w-28` → `max-w-48` and `title={name}`; the `@username` menu label renders inside `<span className="normal-case">` so the login handle keeps its real case.
- [ ] **Step 3:** Drawer: one horizontal padding for the title, the user block, the "Active house" label and the links (measure: x of each left edge equal).
- [ ] **Step 4:** `src/app/not-found.tsx` (server component): paper background, brand "HOMESHARE", title + one line of text + link to `/expenses`, all via `getTranslations("NotFound")`. Keys: `title` ("Page not found"), `description` ("This address doesn't exist or has moved."), `back` ("Back to expenses") — translated in PT/ES/FR.
- [ ] **Step 5:** `auth/layout.tsx`: the language selector is part of the flow (top row, right-aligned) instead of absolutely positioned, and the card is anchored to the top (fixed top padding) instead of vertically centered, so the form does not jump when the error banner appears.
- [ ] **Step 6:** Mobile touch floors: Google link `min-h-11`; onboarding "log out" `min-h-11 px-3` (compact on `md:`); onboarding cards use `flex flex-col` with the action pinned to the bottom (`mt-auto`) so "Create house" and "Join" align.
- [ ] **Step 7:** Loop checks: J7 desktop "barra lateral expõe o item ativo (aria-current)" passes; J7 "pagina-404" print shows the branded page; J1 celular prints without selector overlap.

### Task 4: Auth pages — translated errors and password field

Findings: **I2** (error stays in the old language), **U15** (password placeholder dots), **T7** (username hint breaks inside ". - _").

**Files:**
- Modify: `src/app/auth/login/page.tsx`, `src/app/auth/register/page.tsx`
- Modify: `src/messages/{en,pt,es,fr}.json` (`Auth.usernameHint`)

- [ ] **Step 1:** Store what the error IS, not its text: `const [error, setError] = useState<{ key: string } | { api: unknown; fallbackKey: string } | null>(null)` and render with `t(...)` / `apiErr(...)` at render time, so switching language re-translates it. Keep `role="alert"` and the existing `?error=` query handling (store its key).
- [ ] **Step 2:** Remove the `placeholder` from both password inputs (keep label + hint).
- [ ] **Step 3:** `Auth.usernameHint` (4 locales): write the allowed symbols as one unbreakable group using no-break spaces, e.g. EN `"3–30 characters: lowercase letters, numbers and . - _"`.
- [ ] **Step 4:** Loop checks: J1 "cadastro-pt/es/fr" show the error in the new language.

### Task 5: Expense history shows split changes (B1)

**Files:**
- Modify: `src/lib/audit-diff.ts`
- Test: `src/lib/audit-diff.test.ts`
- Modify: `src/components/expenses/ExpenseDetailModal.tsx` (history rendering of the new field)
- Modify: `src/messages/{en,pt,es,fr}.json` (history field label `participants` → "Split")

**Interfaces:**
- Produces: `buildExpenseHistory` emits `{ field: "participants", from: SplitShare[] | null, to: SplitShare[] }` where `type SplitShare = { userId: number; name: string; amount: string }` (sorted by `userId`).

- [ ] **Step 1: Write the failing test** (append to `src/lib/audit-diff.test.ts`):
  ```ts
  it('records a split change between two revisions', () => {
    const base = { description: 'Dinner', amount: '100', categories: [], platforms: [], paymentMethods: [], date: '2026-09-21', notes: null, payerId: 1 }
    const p = (a: string, b: string) => [
      { userId: 2, amount: b, user: { id: 2, name: 'Bruno' } },
      { userId: 1, amount: a, user: { id: 1, name: 'Ana' } },
    ]
    const history = buildExpenseHistory([
      { id: 1, action: 'CREATE', actorName: 'Ana', createdAt: '2026-09-27T10:00:00Z', after: { ...base, participants: p('70', '30') } },
      { id: 2, action: 'UPDATE', actorName: 'Ana', createdAt: '2026-09-27T10:05:00Z', after: { ...base, participants: p('50', '50') } },
    ])
    expect(history[0].changes).toEqual([{
      field: 'participants',
      from: [{ userId: 1, name: 'Ana', amount: '70' }, { userId: 2, name: 'Bruno', amount: '30' }],
      to: [{ userId: 1, name: 'Ana', amount: '50' }, { userId: 2, name: 'Bruno', amount: '50' }],
    }])
  })

  it('does not report a split change when only participant row ids changed', () => {
    const row = (id: number) => ({ id, userId: 1, amount: '100', user: { id: 1, name: 'Ana' } })
    const history = buildExpenseHistory([
      { id: 1, action: 'CREATE', actorName: 'Ana', createdAt: '2026-09-27T10:00:00Z', after: { amount: '100', participants: [row(10)] } },
      { id: 2, action: 'UPDATE', actorName: 'Ana', createdAt: '2026-09-27T10:05:00Z', after: { amount: '100', participants: [row(11)] } },
    ])
    expect(history[0].changes).toEqual([])
  })
  ```
  (Adapt the `RawRevision` literal shape to the existing tests in the same file.)
- [ ] **Step 2:** Run `npx vitest run src/lib/audit-diff.test.ts` → FAIL (no participants change).
- [ ] **Step 3:** Implement: normalize `after.participants` to `SplitShare[]` (`{ userId, name: user?.name ?? '', amount: String(amount) }`, sorted by `userId`, amounts compared as cents via `toCents`); after the field loop, push a `participants` change when the normalized lists differ (length, userId or cents). Missing participants on either side = no change (older revisions).
- [ ] **Step 4:** Run the test → PASS; `npm run test` green.
- [ ] **Step 5:** `ExpenseDetailModal` history: render the change as `Split: Ana R$70.00 · Bruno R$30.00 → Ana R$50.00 · Bruno R$50.00` using `<Money>` for each amount and the `participants` label from the history field labels in the 4 locales.
- [ ] **Step 6:** Loop check: J2 "historico" contains "Split".

### Task 6: Equal-split badge ignores later members (B3)

**Files:**
- Modify: `src/lib/split.ts`
- Test: `src/lib/split.test.ts`
- Modify: `src/app/(app)/expenses/page.tsx:978` (`splitRatio`)

**Interfaces:**
- Produces: `export function isEqualAmongParticipants(expense: Pick<Expense, 'amount' | 'participants'>): boolean`

- [ ] **Step 1: Write the failing tests** (`src/lib/split.test.ts`):
  ```ts
  describe('isEqualAmongParticipants', () => {
    const e = (amount: string, shares: string[]) => ({ amount, participants: shares.map((a, i) => ({ userId: i + 1, amount: a })) })
    it('is true for one participant', () => expect(isEqualAmongParticipants(e('159.90', ['159.90']))).toBe(true))
    it('is true for an equal split with the odd cent', () => expect(isEqualAmongParticipants(e('0.01', ['0.01', '0']))).toBe(true))
    it('is true for 100.00 over 3', () => expect(isEqualAmongParticipants(e('100', ['33.34', '33.33', '33.33']))).toBe(true))
    it('is false for 70/30', () => expect(isEqualAmongParticipants(e('100', ['70', '30']))).toBe(false))
  })
  ```
- [ ] **Step 2:** `npx vitest run src/lib/split.test.ts` → FAIL (not exported).
- [ ] **Step 3:** Implement: `n = participants.length`; false when `n === 0`; compare the participants' cents sorted descending with `splitCents(toCents(amount), n)` sorted descending.
- [ ] **Step 4:** Test → PASS.
- [ ] **Step 5:** `splitRatio`: return `null` when `isEqualAmongParticipants(e)` (keep the largest-remainder ratio for unequal splits). Keep `detectSplitEqually` untouched (the form still uses it to pre-select the split mode).
- [ ] **Step 6:** Loop check: J0 "despesas-duas" has no "⊟ 100".

### Task 7: Expenses list page

Findings: **B4** (no-results hides chips and Filter), **U12** (numbering on non-date sort), **U13** (selection bar gap), **U4** part (mobile description 1 line), **D2** (subtotal alignment), **D13** (⊟ badge pushes meta line), **D16** (⋮ taller than New expense), **A10** part (List/By person `aria-pressed`), **U20** (By person amount column).

**Files:**
- Modify: `src/app/(app)/expenses/page.tsx` (toolbar :442-525, chips :528-562, bulk bar :567, list/table :765-1171)

- [ ] **Step 1 (B4):** Show the chips row, the summary and the "Filter" menu item whenever filters are active (`activeFilterCount > 0`), even when `total === 0`; keep "Select" gated on `total > 0`.
- [ ] **Step 2 (U12):** `rowNumber` = position in the rendered order (running counter over the grouped rows), not the global rank.
- [ ] **Step 3 (U13):** Bulk bar `sticky top-20` → stick right under the header: header height is 56px on mobile (`py-1.5` + 44px trigger) and ~59px on desktop; use `top-14 md:top-[3.7rem]` (measure in the print: no list rows visible between header and bar).
- [ ] **Step 4 (U4):** Mobile card description: replace `truncate` with `line-clamp-2 break-words`.
- [ ] **Step 5 (D2):** Month header subtotal: render it in the Amount column (desktop: `th` spanning up to the Amount column with the subtotal right-aligned on the same right edge as the amounts; mobile: same right edge as the row amounts).
- [ ] **Step 6 (D13):** Mobile card: move "⊟ 70/30" into the payer·date meta line (right side) so it does not change the card height.
- [ ] **Step 7 (D16):** Desktop toolbar: the ⋮ trigger uses the same height as the `sm` button next to it.
- [ ] **Step 8 (A10):** "List"/"By person" buttons get `aria-pressed`.
- [ ] **Step 9 (U20):** By-person table: amount column sized by content (`w-auto whitespace-nowrap` on the header and cells, description column flexible).
- [ ] **Step 10:** Loop checks: J2 "filtro-sem-resultado" shows chips; "ordenado-por-valor" numbers 1..n per displayed order; "selecao-dois" no gap; celular descriptions in up to 2 lines; `por-pessoa` no `passaDaBorda`.

### Task 8: Expense form, detail and filters

Findings: **A3** part (Split/Custom 35px, Amount/% 30px, Filters chips 27px), **A10** part (segmented `aria-pressed`), **U3** (split status hidden below the fold, SUM not colored), **D17** (amount hint squeezed), **T6** (split copy), **B12** (conflict message), **U19** (MultiSelect "1"), **A8** (MultiSelect search label).

**Files:**
- Modify: `src/components/expenses/ExpenseFormModal.tsx` (:408-421 amount, :446-631 split, :645 server error, footer)
- Modify: `src/components/expenses/ExpenseFiltersModal.tsx` (chip buttons)
- Modify: `src/components/ui/MultiSelect.tsx:39-44,79,90`
- Modify: `src/messages/{en,pt,es,fr}.json` (`Expenses` split strings, `staleExpense` action)

- [ ] **Step 1:** Split mode buttons and Amount/% buttons: `min-h-11 md:min-h-0`, `aria-pressed={selected}`, text ≥ 12px.
- [ ] **Step 2:** When the custom split does not match, show the status line ("Missing R$20.00" / "Over by R$25.00", in `text-debt`, amount included) in the modal footer area next to the actions (left side), so the reason for the disabled Add/Save is always visible; color "Sum" with `text-debt` while it does not match (Task 1 made `<Money className="text-debt">` work).
- [ ] **Step 3:** Amount hint spans the full row below Amount/Date (grid `col-span-2`).
- [ ] **Step 4 (T6):** Copy in 4 locales: capitalized status ("Over by", "Missing", "Matches ✓", "Enter the total amount"); the equalize link is "Equalize" in both modes; "Total" in both modes (instead of Sum/Total).
- [ ] **Step 5 (B12):** Stale expense (409 `STALE_EXPENSE`): show only the inline message (no toast) and add a button "Load latest" that refetches the expense into the form (keeps the modal open); message copy: "Someone else changed this expense. Load the latest version to continue." (4 locales).
- [ ] **Step 6 (U19):** MultiSelect summary: no bare count; when more than 2 are selected keep the existing "A, B +N". Remove the trailing `labels.length` span.
- [ ] **Step 7 (A8):** MultiSelect search input `aria-label={searchPlaceholder}` plus a new optional `searchLabel` prop (e.g. "Search categories") passed by the three callers.
- [ ] **Step 8:** Filters modal chips: `min-h-8` (32px) on mobile.
- [ ] **Step 9:** Loop checks: J2 celular "limites-do-formulario"/"custom-*" without `alvoMenor44` for the segmented controls; J2 "custom-somando-errado" shows the reason without scrolling; J2 "conflito-de-edicao" single message + "Load latest".

### Task 9: Balances and Record payment

Findings: **U5** (names hidden on phone, squeezed avatars), **D22** (per-person name truncation), **D15** (orphan "·"), **U17** (delete payment context), **D7** (month bars scale), **D8** (percentages sum 101), **U6** (From/To truncated), **U18** (overpay warning style), **D12** (amount field), **I8** part ("Record payment" wraps next to the title; "Total de gastos" in 3 lines).

**Files:**
- Modify: `src/app/(app)/balances/page.tsx`
- Modify: `src/components/balances/RecordPaymentModal.tsx`
- Modify: `src/components/ui/Member.tsx`
- Create: `src/lib/percent.ts` · Test: `src/lib/percent.test.ts`

**Interfaces:**
- Produces: `export function percentsTo100(values: number[]): number[]` (largest remainder; zeros stay 0).

- [ ] **Step 1: Write the failing test** (`src/lib/percent.test.ts`):
  ```ts
  import { describe, it, expect } from 'vitest'
  import { percentsTo100 } from './percent'
  describe('percentsTo100', () => {
    it('sums to exactly 100', () => {
      const v = [12567.35, 2219.86, 1596.44, 1013.47, 858.34, 0.01]
      const p = percentsTo100(v)
      expect(p.reduce((a, b) => a + b, 0)).toBe(100)
      expect(p[0]).toBe(69)
    })
    it('returns zeros for an empty total', () => expect(percentsTo100([0, 0])).toEqual([0, 0]))
  })
  ```
- [ ] **Step 2:** Run → FAIL; implement `percentsTo100` (floor, then distribute the remainder by largest fractional part); run → PASS.
- [ ] **Step 3 (D8, D7):** Category and month insights use `percentsTo100` for the labels, and both bars use `value / total` (the month bar stops using `value / maxMonth`).
- [ ] **Step 4 (U5):** Who pays whom and Recorded payments show the names on phones too (stack "from → to" names under the avatars row, or show `Member` with the name truncated); `Member` avatar gets `shrink-0` so it never becomes a pill.
- [ ] **Step 5 (D22):** Per person: amount column sized by content (`whitespace-nowrap`, no fixed width) so the name gets the remaining width.
- [ ] **Step 6 (D15):** Recorded payments: render the note as its own line without the leading "· " when it wraps (separator only when inline).
- [ ] **Step 7 (U17):** Delete payment dialog body names the payment: "Bruno QA → Ana QA · R$150.00 · 05/09/2026".
- [ ] **Step 8 (U6, D12, U18):** Record payment: From/To stacked below `sm`; amount input right-aligned with tabular numbers and the same hint as the expense form; the overpay notice uses a warning style (ink text with an amber/stamp-soft background, no `role=alert`) distinct from the blocking error.
- [ ] **Step 9 (I8):** "Record payment" header button stays on one line (`whitespace-nowrap`, section header wraps as a whole); the total block label stays on at most 2 lines at 360px.
- [ ] **Step 10:** `npm run test` green; loop checks: J3 prints, celular360 J8 es/pt balances with readable names.

### Task 10: Shopping and Link expenses

Findings: **U4** part (item names 1 line), **D10** (`[x]` vs `[ ]` width on Bolitas), **D14** (date on a 3rd line), **B8** (Link expenses: 50 cap without notice, linked not on top, "Skip for now" when editing), **U16** (modal jumps while searching).

**Files:**
- Modify: `src/app/(app)/shopping/page.tsx` (ItemRow :404-489, :433)
- Modify: `src/components/shopping/ExpenseLinkModal.tsx`
- Modify: `src/messages/{en,pt,es,fr}.json` (`Shopping` link modal strings)

- [ ] **Step 1:** Item name `line-clamp-2 break-words` instead of one-line truncate; the same for the expense description in the Link expenses rows (U4).
- [ ] **Step 2:** Toggle glyph box with a fixed width (`w-[3ch] text-center`) so `[x]` and `[ ]` align in proportional fonts.
- [ ] **Step 3:** Meta line order: date first, then the "by …" and "N expense(s)" chips (`flex-wrap`), so the date never sits alone on a 3rd line.
- [ ] **Step 4 (B8):** When opened with existing links, render the selected expenses first (section "Linked", then the rest); footer secondary button is "Cancel" when editing and "Skip for now" only right after marking as purchased; below the list, when the page is full (50) and there is no search, show "Showing the 50 most recent — search to find older ones" (4 locales).
- [ ] **Step 5 (U16):** List area gets a stable minimum height (e.g. `min-h-[18rem]`) so the sheet does not jump while filtering.
- [ ] **Step 6:** Loop checks: J4 "editar-vinculos" shows the linked ones on top; "vincular-busca" search field at the same y as "vincular-aberto".

### Task 11: Catalogs

Findings: **A3** part (⋯ 31×26 on phone), **D9** (case-sensitive order), **U11** part (duplicate/system-name error only in a toast).

**Files:**
- Modify: `src/components/app/TagManager.tsx:109-192`
- Modify: `src/services/tag-service.ts` · Test: `src/services/tag-service.test.ts`

- [ ] **Step 1: Write the failing test** (`src/services/tag-service.test.ts`, following the file's mocked-prisma pattern): list returns `["iFood", "Loja do bairro", "Vale", "VR"]` for DB rows in ASCII order `["Loja do bairro", "VR", "Vale", "iFood"]`.
- [ ] **Step 2:** Run → FAIL; sort in the service after the query with `localeCompare(b, undefined, { sensitivity: "base" })`; run → PASS.
- [ ] **Step 3:** Row ⋯ trigger: `grid min-h-11 min-w-11 place-items-center md:min-h-0 md:min-w-0` (same floor used by the other ⋯ buttons).
- [ ] **Step 4 (U11):** Create dialog: on `DUPLICATE_NAME` / `SYSTEM_DEFAULT_COLLISION` / `NAME_*` errors show the translated message under the field via `<Field error=…>` (keep the dialog open, no toast for field errors).
- [ ] **Step 5:** Loop checks: J5 duplicate shows the inline error; celular without `alvoMenor44` on ⋯.

### Task 12: House and Account

Findings: **U7** (members row squeezed, badges misaligned, house title cut), **T4** ("✓ active" style), **T5** (Currency/Currency), **U11** part (join code, password errors only in toast), **I1** (native validation bubble).

**Files:**
- Modify: `src/app/(app)/house/page.tsx` (:187-205 card, :248-273 currency, :276-333 members, :364-412 your houses, :415-447 join)
- Modify: `src/app/(app)/account/page.tsx` (:85, :166, :195)

- [ ] **Step 1 (U7):** Member row: name/username take the full width; on phones the action ("Leave house" / ⋯) goes to its own line under the name, right-aligned; role tags in a fixed-width column (`w-20 text-center`) so ADMIN/MEMBER align. House card title may wrap (`break-words`, no truncate).
- [ ] **Step 2 (T4):** Your houses status uses the same label style as "SWITCH" (`label-mono`, uppercase) keeping the accent color for the active one.
- [ ] **Step 3 (T5):** Currency field label becomes `sr-only` (the section title already says it).
- [ ] **Step 4 (U11):** Join with a code: invalid/format errors under the field (`<Field error>`). Password section: mismatch and wrong current password shown under the respective field; mismatch validated on blur of the confirmation.
- [ ] **Step 5 (I1):** Both account `<form>` elements get `noValidate`; e-mail errors come from the server code `INVALID_EMAIL` (already translated) and show under the e-mail field.
- [ ] **Step 6:** Loop checks: J6 "erro do e-mail aparece na tela, no idioma do app" passes; House celular360 names readable.

### Task 13: Activity

Findings: **B6** (Summary/Detailed coverage, 100 cap without notice), **B7** (raw diffs), **D21** (Detailed label column), **A3** part (filter chips 26px).

**Files:**
- Modify: `src/app/api/categories/route.ts`, `src/app/api/categories/[categoryId]/route.ts`, same for `platforms` and `payment-methods` (add `recordActivity` on create/delete)
- Modify: `src/app/api/shopping-items/[itemId]/route.ts` (PATCH rename, DELETE), `src/app/api/shopping-items/clear-purchased/route.ts`
- Modify: `src/app/api/groups/active/currency/route.ts` (record `{ from, to }`)
- Create: `src/lib/activity-format.ts` · Test: `src/lib/activity-format.test.ts`
- Modify: `src/app/(app)/activity/page.tsx` (:178-219 summary, :340-394 detailed, FilterChip)
- Modify: `src/messages/{en,pt,es,fr}.json` (`Activity` verbs for the new events, field labels, limit notice)

**Interfaces:**
- Produces: `export function formatChangeValue(field: string, value: unknown, fmt: { money: (v: string | number) => string; yes: string; no: string }): string | null` — `null` means "hide this field" (technical keys such as `linkedExpenseIds`).

- [ ] **Step 1: Write the failing tests** (`src/lib/activity-format.test.ts`):
  ```ts
  import { describe, it, expect } from 'vitest'
  import { formatChangeValue } from './activity-format'
  const fmt = { money: (v: string | number) => `R$${Number(v).toFixed(2)}`, yes: 'Yes', no: 'No' }
  describe('formatChangeValue', () => {
    it('formats money fields', () => expect(formatChangeValue('amount', '130', fmt)).toBe('R$130.00'))
    it('formats booleans', () => expect(formatChangeValue('purchased', false, fmt)).toBe('No'))
    it('hides technical fields', () => expect(formatChangeValue('linkedExpenseIds', ['x'], fmt)).toBeNull())
    it('shows empty values as an em dash', () => expect(formatChangeValue('currency', null, fmt)).toBe('—'))
  })
  ```
- [ ] **Step 2:** Run → FAIL; implement (money fields: `amount`; boolean fields: `purchased`, `isPurchased`; hidden: `linkedExpenseIds`); run → PASS.
- [ ] **Step 3:** Summary rows use `formatChangeValue` and skip hidden fields; fields without a translation are hidden instead of printing the raw key.
- [ ] **Step 4:** Add the missing `recordActivity` calls (catalog create/delete, shopping rename/delete, clear-purchased) with new `Activity.act.*` verbs in the 4 locales; currency route records `{ from, to }`.
- [ ] **Step 5:** Detailed sentences use lowercase entity nouns with the article from translations (e.g. "deleted a payment method").
- [ ] **Step 6:** When the Summary returns exactly the limit (100), show "Showing the 100 most recent changes" under the list.
- [ ] **Step 7 (D21, A3):** Detailed entries on phones: label above the value (no side column); filter chips `min-h-11 md:min-h-8`.
- [ ] **Step 8:** `npm run test` green; loop checks: J7 Summary has catalog and item events; no raw keys/booleans (J8 checks).

### Task 14: CSV import

Findings: **B2** (re-import duplicates), **B11** (generic errors, partial import success toast), **I9** (help lists PT column names), **I10** (native file input in the browser language), **A6** part ("Invalid rows" color — fixed by Task 1).

**Files:**
- Modify: `src/components/expenses/ImportCsvModal.tsx`
- Modify: `src/lib/csv-parser.ts` · Test: `src/lib/csv-parser.test.ts`
- Modify: `src/app/api/expenses/import/route.ts`
- Modify: `src/messages/{en,pt,es,fr}.json` (`CsvErrors`, `Expenses` import strings)

- [ ] **Step 1: Write the failing tests** (`src/lib/csv-parser.test.ts`): parsing `"nome,preco\nX,10\n"` throws an error with `code === 'CSV_MISSING_COLUMNS'`; parsing `""` throws `code === 'CSV_EMPTY'` (follow the existing test style in the file).
- [ ] **Step 2:** Run → FAIL; add the codes to the thrown `ApiError`s (and to the route's `Empty CSV` response); run → PASS.
- [ ] **Step 3:** Translations `CsvErrors.CSV_MISSING_COLUMNS` ("The file needs the columns description and amount") and `CsvErrors.CSV_EMPTY` ("The file is empty") in 4 locales; show the error once (inline), not also as a toast.
- [ ] **Step 4 (B2):** After a completed import: clear the file (state + input value), disable "Import" and make "Close" the primary action until a new file is chosen.
- [ ] **Step 5 (B11):** Partial import (imported > 0 and invalid rows > 0): info toast "N imported, M rows skipped" instead of the success toast.
- [ ] **Step 6 (I9):** Help text lists `description, amount` (required) and `date, platform, notes` (optional) in the UI language, followed by "(Portuguese headers also work)".
- [ ] **Step 7 (I10):** Hide the native input visually (keep it focusable/labelled) and render a `Button` "Choose file" + the chosen file name (truncate middle) using the app's translations.
- [ ] **Step 8:** Loop checks: J9 "importado-valido" shows Import disabled; "cabecalho-errado" shows the specific message once.

### Task 15: Money format and copy sweep

Findings: **I3** (ES shows "BRL"), **I4** (FR foyer/maison), **I5** (PT "0 despesa"), **I6** (ES añadir/agregar), **I8** (long labels at 360px), **T1** (toast punctuation), **T2** (same concept, different texts).

**Files:**
- Modify: `src/lib/money.ts:12` · Test: `src/lib/money.test.ts`
- Modify: `src/messages/{en,pt,es,fr}.json`

- [ ] **Step 1: Write the failing test** (`src/lib/money.test.ts`): `formatMoney(8015.43, 'BRL', 'es')` contains `R$` and not `BRL`.
- [ ] **Step 2:** Run → FAIL; `new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'narrowSymbol' })`; run → PASS; check the other money tests still pass.
- [ ] **Step 3 (I4):** FR uses "maison" everywhere (replace "foyer").
- [ ] **Step 4 (I5):** PT count plurals with `=0` ("0 despesas") for categories, platforms and payment methods.
- [ ] **Step 5 (I6):** ES uses "Añadir" everywhere (replace "Agregar"/"agregó" with "Añadir"/"añadió").
- [ ] **Step 6 (I8):** ES split button "Partes iguales"; month headers use a no-break space around " / " so the year never wraps alone.
- [ ] **Step 7 (T1):** Toasts: short sentence, no final period, no exclamation mark, in all 4 locales (e.g. "Added", "Deleted", "Details updated", "Passwords don't match").
- [ ] **Step 8 (T2):** One password rule text (register and account); "Notes" in both forms; the join-with-code form uses the same label/hint/button in onboarding and House ("House code", "6 characters", "Join"; hint "Ask whoever manages the house for the code.").
- [ ] **Step 9:** `npm run test` green; J8 has no "BRL", "foyer", "0 DESPESA".

### Task 16: Round 2 of the loop (verification)

- [ ] **Step 1:** `npm run test`, `npx tsc --noEmit`, `npx eslint src` (no new errors).
- [ ] **Step 2:** Update journeys with checks for the fixes (aria-current, "Split" in history, no "⊟ 100", toasts not over the footer, import disabled after success, etc.), `bash reset-qa.sh`, `python gerar-roteiros.py 2`, run all 23 executions via `pw-edge`.
- [ ] **Step 3:** Review the round-2 prints (parallel reviewers, same instructions) focusing on the fixed findings and regressions; update `achados.json` states ("corrigido e conferido" / "não confirmado") and regenerate the report (before/after prints).
