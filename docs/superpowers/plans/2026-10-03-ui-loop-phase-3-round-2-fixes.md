# UI Test Loop · Phase 3 (Round-2 Fixes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix what round 2 of the UI test loop found: the 4 medium findings (R2-01 payer squeezed by the "⊟ 70/30" badge, R2-02 recipient cut next to MARK PAID, R2-03 link/unlink shown as a bare "updated an item" + Summary/Detailed disagreement, R2-04 year cut in the date field at 360px), the 3 round-1 carry-overs (U6, U11, A7) and the low findings, then run round 3 of the loop.

**Architecture:** Same layers as phases 1–2 — pure helpers in `src/lib` with unit tests, framework-agnostic services with pglite integration tests, thin routes, presentation-only component changes verified by the loop. Two design decisions worth knowing up front: (1) the modal stripe (R2-05) is fixed by dropping the reserved scrollbar gutter *while Radix locks scroll* — react-remove-scroll-bar's own body margin then keeps the content at the same x, so U14's no-jump guarantee holds; (2) Activity › Detailed gets "before → after" for every update (R2-09) by deriving `before` on read from the previous revision of the same entity (ADR 0005's history chain) inside `revision.service.ts` — no write-path change, nothing in `src/lib/prisma-audit.ts`, and it works for rows already stored. No schema change.

**Tech Stack:** Next.js 16 App Router, React 19, Tailwind v4 (CSS-first; `aria-invalid:` → `&[aria-invalid="true"]`), Radix Dialog/DropdownMenu (react-remove-scroll-bar), next-intl 4 (EN/PT/ES/FR), Prisma 7 + Postgres, Vitest + pglite.

**Spec / inputs:** `screenshots/loop-2026-09-27/rodada-2/achados-r2.json` (R2-01…R2-31 + carry-overs U6/U11/A7), `rodada-2/RESUMO.md`, `rodada-2/revisao/achados-lote-{A..G}.md` · `docs/specs/003-mobile-navigation-drawer/` (criterion 7 amended by Task 7) · `docs/specs/005-shopping-item-expense-links/` (criterion 7 added by Task 9) · `docs/decisions/0005-audit-trail-prisma-extension.md` (history chain, relied on by Task 10) · format and loop task from `docs/superpowers/plans/2026-10-03-ui-loop-phase-2-decisions.md`.

## Global Constraints

- Build on the CURRENT working tree (≈100 changed/untracked files from phases 1–2, plus whatever the parallel observability plan adds), not on HEAD. Never `git stash`, `git checkout --`, or reset those files.
- **Parallel plan:** `docs/superpowers/plans/2026-10-03-observability-sentry.md` is being executed at the same time. Do NOT edit its files: `src/lib/api-helpers.ts`, `src/lib/prisma-audit.ts`, `src/middleware.ts`, `next.config.ts`, `src/lib/session.tsx`, `src/app/global-error.tsx`, `src/instrumentation*.ts`, `src/lib/observability/*`, `src/lib/logger.ts`, `package.json`, `package-lock.json`. The ONE exception is Task 9, which edits `replaceExpenseLinks` in `src/services/shopping-item.service.ts` (the observability plan only touches `togglePurchased`'s `catch` in that file — re-read the file right before editing, keep its changes). Both plans add keys to `src/messages/*.json` (it adds a `GlobalError` namespace): edit by key with the Edit tool, never rewrite or reformat a whole messages file.
- English in all code, comments, identifiers and URLs. UI text only through `src/messages/{en,pt,es,fr}.json`: every new key in all 4 files; change values, never keys, of existing messages unless the task says so.
- `cn()` in `src/components/ui/cn.ts` only joins strings (no tailwind-merge): never stack two utilities for the same CSS property under the same variant/breakpoint (`border-rule` + `aria-invalid:border-debt` is fine: different variants).
- Money is integer cents (`lib/currency`); DB is `Decimal(10,2)`; API amounts serialize as strings; exact comparisons.
- API errors carry a `code` translated client-side (`useApiError`, namespaces `ApiErrors`/`CsvErrors`). Tenant isolation via `requireActiveGroup`; `groupId` never comes from the body.
- Mobile-first: 44px touch floor below `md` (spec 003 criterion 7, widened by Task 7); 12px text floor (A7); animations stay behind `prefers-reduced-motion`.
- Gates per task: `npm run test` green, `npx tsc --noEmit` clean, `npx eslint src` with no new errors (1 pre-existing error in `src/app/auth/login/page.tsx` — do not fix it).
- i18n parity check (run after every task that touches messages; must print `i18n parity OK`):
  ```bash
  node -e 'const f=o=>Object.entries(o).flatMap(([k,v])=>v&&typeof v==="object"?f(v).map(s=>k+"."+s):[k]);const L=["en","pt","es","fr"].map(l=>new Set(f(require("./src/messages/"+l+".json"))));const all=new Set(L.flatMap(s=>[...s]));const miss=[...all].filter(k=>!L.every(s=>s.has(k)));console.log(miss.length?"MISSING "+miss.join(", "):"i18n parity OK")'
  ```
- **NO commits.** Leave every change unstaged — the owner commits later on a branch he picks.
- NEVER run `npm run build`, `prisma db push`, or anything that reads `.env` / `.env.local` (they point at the PRODUCTION Neon DB). This plan needs no schema change.
- Implementers do not start dev servers or browsers. Visual tasks end with a **Controller live check** that the controller runs on the QA server (127.0.0.1:3100, DB `homeshare-qa-pg` on 127.0.0.1:55432) BEFORE approving the task (phase-1 lesson: 3 regressions only showed up live).

## Coverage map

| Finding | Severity | Decision | Where |
|---|---|---|---|
| R2-01 payer squeezed by "⊟ 70/30" | média | fix | Task 4 |
| R2-02 recipient cut next to MARK PAID | média | fix | Task 6 |
| R2-03 link/unlink = bare "updated an item"; Summary ≠ Detailed | média | fix | Task 9 |
| R2-04 date "03/10/202" at 360 | média | fix | Task 5 |
| U6 Record payment "To" cut on desktop/notebook | carry-over | fix | Task 2 |
| U11 field error without border / aria-invalid | carry-over | fix | Task 2 |
| A7 12px floor (segmented, chips, stamp, auth footer, drawer) | carry-over | fix | Task 3 |
| R2-05 un-dimmed gutter stripe with a modal/drawer open | baixa | fix | Task 1 |
| R2-06 text controls under 44px | baixa | fix | Task 7 |
| R2-07 menu items 36px | baixa | fix | Task 7 |
| R2-08 same-currency change recorded | baixa | owner | Decided by owner §1 |
| R2-09 Detailed shows only the new state | baixa | fix | Task 10 |
| R2-10 fr "MAISON" chip above "MAISON" section | baixa | fix (Catalogs label) | Task 11 (+ won't-fix note) |
| R2-11 avatar initials 7–11px | baixa | fix | Task 8 |
| R2-12 dialog/hint punctuation policy | baixa | owner | Decided by owner §2 |
| R2-13 text buttons misaligned, no affordance | baixa | fix | Task 6 |
| R2-14 By person Date/Amount misaligned across months | baixa | fix | Task 4 |
| R2-15 history "Split" arrow hangs, no hanging indent | baixa | fix | Task 5 |
| R2-16 "Matches ✓" only in Amount mode | baixa | fix | Task 5 |
| R2-17 "CATEGORY" singular on multi-selects | baixa | owner | Decided by owner §3 |
| R2-18 "ACCOUNT" stamp reads as a button | baixa | owner | Decided by owner §4 |
| R2-19 eye icon only in Delete-account dialog | baixa | won't fix | Won't fix §1 |
| R2-20 welcome page 6px taller than 844 | baixa | fix | Task 11 |
| R2-21 selection bar labels wrap | baixa | fix | Task 4 |
| R2-22 Filters search placeholder cut | baixa | fix | Task 4 |
| R2-23 history time orphaned on 2nd line | baixa | fix | Task 5 |
| R2-24 Recorded payments date jumps | baixa | fix | Task 6 |
| R2-25 two "Clear filters" with 0 results | baixa | fix | Task 4 |
| R2-26 "updated the house — BRL" | baixa | fix | Task 10 |
| R2-27 "created a membership" | baixa | fix | Task 10 |
| R2-28 month subtotal vs amounts on phones | baixa | won't fix | Won't fix §2 |
| R2-29 "0%" next to a real amount | baixa | fix | Task 6 |
| R2-30 fr orphan words | baixa | fix | Task 11 |
| R2-31 Your houses name cut at 360 | baixa | fix | Task 6 |
| Probe defects T5, D1, I11 (+ jx-smoke `fetch`) | — | fix probes | Task 12 |

## Decided by owner

These need a product call; none is implemented in this plan. Task 12 records them in `achados.json` with `"estado": "decidir"` and the recommendation, so round 3 does not re-report them as new.

1. **R2-08 — Should picking the currency that is already active be recorded at all?** Today `POST /api/groups/active/currency` always updates the row and calls `recordActivity`, so Summary shows "currency: BRL → BRL" and Detailed an identical "updated the house".
   *Recommended:* treat it as a no-op — `groupService.updateCurrency` returns `{ changed: false }` without writing when the value is unchanged, the route skips `recordActivity` and still answers `200 { currency }` (no new error code; the UI already shows the selected value). Covered by one pglite test (no AuditLog row, no Group UPDATE revision).
2. **R2-12 — One copy policy for dialogs and hints (4 locales)?** Titles mix questions ("REMOVE BRUNO QA?") and labels ("DELETE ITEM"); hints mix final periods ("Ask whoever manages the house for the code.") and none ("6 characters"); the irreversibility line varies ("This action cannot be undone." / "It can't be undone." / absent in Delete item, Clear purchased, Delete category).
   *Recommended:* confirmation titles are always a question ending in "?"; one-line hints/helper texts never end with a period, multi-sentence descriptions always do; every destructive confirmation states "This action cannot be undone." (no contraction; pt "Esta ação não pode ser desfeita.", es "Esta acción no se puede deshacer.", fr "Cette action est irréversible."). Implementation is a values-only messages pass.
3. **R2-17 — Plural labels on the multi-selects?** "CATEGORY", "PLATFORM", "PAYMENT METHOD" label multi-selects (expense form, Filters, history field names).
   *Recommended:* plural values for `Expenses.categoryLabel` / `platformLabel` / `paymentLabel` in the 4 locales ("Categories", "Platforms", "Payment methods"), plus a new singular key for the CSV import's single platform `<Select>` (`ImportCsvModal.tsx` uses `platformLabel` for a one-value select). The j2 journey step `label:text-is("Category")` must follow.
4. **R2-18 — Keep the rotated "ACCOUNT" stamp in the Balances header?** It is decorative (`cursor-default`) but 5 review batches read it as a button or as "user account".
   *Recommended:* remove it (the subtitle "House statement" already names the page) and delete `Balances.account` from the 4 locales. (Its 11.2px size is fixed by Task 3 either way.)

Not findings, left for the owner (RESUMO §5 open questions, untouched by this plan): "Load latest" discards a typed note silently; "Save (0)" enabled with 0 links selected; "Leave house" looks rust-grey in Bolitas; informal pt ("pros", "pra", "deslogado"); empty E-MAIL field without an "optional" hint; the logged user's avatar color changes per house; Detailed reviewed in English only; "Skip to content" unchecked.

## Won't fix

1. **R2-19 — eye icon only in the Delete-account dialog.** The app renders no show/hide toggle anywhere; the icon is Edge's native password-reveal button (`::-ms-reveal`), which Edge shows on a focused password field that has typed text — exactly the dialog's state in the print. App behavior is already consistent. (A real toggle on every password field would be a feature request.)
2. **R2-28 — month subtotal vs row amounts on phones.** Deliberate phase-1 decision (T7/D2, documented in the comment above the mobile month header in `expenses/page.tsx`): on phones the month label plus a 5-digit subtotal does not fit with the 44px ⋯ inset, so the subtotal stays at the card edge. Desktop alignment (D2) is unchanged and passing.
3. **R2-05 residual — on a short page with no modal the header's bottom rule stops 15px before the window edge.** That 15px is the scrollbar gutter U14 reserves on purpose (outside the document, nothing can be drawn there); it looks the same as when a scrollbar is shown. The modal/drawer part of R2-05 is fixed in Task 1.
4. **R2-10 second half — fr category "Maison" (Home) next to the nav item "MAISON" in Dépenses/Soldes.** Different regions of the screen; renaming the fr category would also change the reserved system names (`src/lib/system-defaults.ts` reads them from the messages) and could collide with existing custom categories. The confusing case (same Catalogs card) is fixed in Task 11.
5. **"1 Issue" Next.js badge in the prints** — dev-only overlay caused by Edge extensions (already discarded in rounds 1–2); absent in production.

## Task order and shared files

Tasks run in order (1 → 12). Files touched by more than one task: `src/messages/*.json` (4, 9, 10, 11), `src/app/(app)/expenses/page.tsx` (3, 4, 7), `src/app/(app)/activity/page.tsx` (3, 9, 10), `src/components/expenses/ExpenseFormModal.tsx` (5, 7), `src/components/expenses/ExpenseDetailModal.tsx` (5, 7), `src/components/ui/Field.tsx` (2, 11), `src/components/app/AppChrome.tsx` (3, 7), `src/lib/activity-format.ts` + test (9, 10), `src/services/tenant-isolation.test.ts` (9, 10). Search by content — line numbers drift.

---

### Task 1: R2-05 — overlays reach the right edge (no un-dimmed gutter stripe)

Root cause (verified in `src/app/globals.css` + Radix): `html { scrollbar-gutter: stable }` (U14) keeps reserving the gutter even while Radix locks scroll (`body[data-scroll-locked] { overflow: hidden }` propagates to the viewport). Fixed layers (`Dialog.Overlay` `fixed inset-0`, the bottom sheet, the drawer) are sized against the viewport box, which excludes that gutter, so the gutter keeps showing the paper canvas (reviewer pixel (243,240,233) vs overlay (154,153,148)). U14 also had to cancel react-remove-scroll-bar's body `margin-right` (`html body[data-scroll-locked] { margin-right: 0 !important }`), because gutter + margin shifted the content. Fix: while scroll is locked, drop the gutter and let the library's margin (it measures the gutter width before locking: `innerWidth − clientWidth`) hold the content in place. Same x before and after → no U14 jump; overlays, sheets and the drawer cover the full width. Dropdown menus (Radix also locks scroll for them) get the same, invisible, compensation.

**Files:**
- Modify: `src/app/globals.css`

**Interfaces:** none.

- [ ] **Step 1: Replace the U14 margin override.** In `src/app/globals.css` replace the whole block
  ```css
  /* The html gutter already reserves the scrollbar space; react-remove-scroll-bar (Radix scroll
     lock) would add it again. Unlayered so it outranks the library's own unlayered, !important
     rule by specificity alone. */
  html body[data-scroll-locked] {
    margin-right: 0 !important;
  }
  ```
  with
  ```css
  /* R2-05: the html gutter (U14) reserves the scrollbar space on every page. While a Radix
     dialog, drawer or menu locks scrolling, drop that reserve instead: a reserved gutter sits
     outside the viewport box fixed layers are sized against, so the overlay, the bottom sheet
     and the drawer stopped ~15px short and left an un-dimmed stripe. react-remove-scroll-bar
     gives <body> a margin-right equal to the gutter it measured before locking, so the page
     content keeps its x — no U14 jump. Unlayered, like the library's own rule. */
  html:has(> body[data-scroll-locked]) {
    scrollbar-gutter: auto;
  }
  ```
  Keep the `html { … scrollbar-gutter: stable; }` rule in `@layer base` unchanged.

- [ ] **Step 2: Gates.** `npx tsc --noEmit` clean; `npm run test` green (CSS only — no test change).

- [ ] **Step 3: Controller live check** (Edge on Windows = classic scrollbar), 127.0.0.1:3100:
  - desktop 1440×900, `/expenses` (long page) and `/house` (short page): note `document.querySelector('header a').getBoundingClientRect().x`; open **New expense** → the overlay (`div[data-state=open]` with `position: fixed`, not `role=dialog`) has `getBoundingClientRect().right === innerWidth`, and the brand x is unchanged; close → brand x unchanged.
  - same with the ⋮ menu open (dropdown lock) and with a confirmation stacked on a dialog (Delete expense from the detail modal).
  - 390×844 emulation: the drawer's right edge and the bottom sheet's right edge `=== innerWidth`.
  - **Fallback, only if the brand x moves in any of the above:** restore the deleted `margin-right: 0 !important` rule, delete the new rule, and paint the gutter only while a dialog is open instead:
    ```css
    /* R2-05 fallback: the gutter shows the canvas; paint it with the overlay's composited color. */
    html:has([role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]) {
      background-color: color-mix(in srgb, var(--color-ink) 40%, var(--color-paper));
    }
    ```

- [ ] **Step 4: Loop check for Task 12 (J0 desktop, J9 celular):** with a modal open the overlay's right edge equals `innerWidth`; the existing `[U14]` checks (brand x with the modal open, `/expenses` vs `/house`) still pass.

- [ ] **Step 5: Leave changes unstaged** (no commits — the owner commits later on a branch he picks).

---

### Task 2: U11 + U6 — field error state; Record payment From/To always stacked

**U11:** `Field` only styles the `<p role="alert">`; the control keeps its thin grey border and only some callers pass `aria-invalid`. Make `Field` mark the control itself whenever it has an `error` (`aria-invalid="true"` through the same `cloneElement` that already injects `aria-describedby`) and give `fieldBase` an `aria-invalid:` debt border. Record payment's "same person" error becomes the "To" field's error, so its select is marked too. **U6:** the 2-column From/To grid is only stacked below `sm`; inside the 448px dialog each column is ~200px and still cuts "Júlia Caminho Feli" on desktop/notebook → stack at every width.

**Files:**
- Create test: `src/components/ui/Field.test.ts`
- Modify: `src/components/ui/Field.tsx` (`fieldBase`, `Field`)
- Modify: `src/components/balances/RecordPaymentModal.tsx`

**Interfaces:** `Field` unchanged signature; with `error` set, the single child element receives `aria-invalid={true}` in addition to `aria-describedby`.

- [ ] **Step 1: Write the failing test.** Create `src/components/ui/Field.test.ts` (node environment, no new dependency — `react-dom/server` ships with `react-dom`; `tsconfig` `"jsx": "react-jsx"` lets Vitest transform `Field.tsx`):
  ```ts
  import { describe, it, expect } from "vitest";
  import { createElement } from "react";
  import { renderToStaticMarkup } from "react-dom/server";
  import { Field, Input, Select } from "./Field";

  const field = (error?: string) =>
    renderToStaticMarkup(
      createElement(Field, { label: "Name", htmlFor: "f", error }, createElement(Input, { id: "f" }))
    );

  describe("Field error state (U11)", () => {
    it("marks the control aria-invalid and keeps the message wired by aria-describedby", () => {
      const html = field("Required");
      expect(html).toMatch(/<input[^>]*aria-invalid="true"/);
      const describedBy = html.match(/<input[^>]*aria-describedby="([^"]+)"/)?.[1];
      expect(describedBy).toBeTruthy();
      expect(html).toContain(`id="${describedBy}" role="alert"`);
    });

    it("leaves a valid control unmarked", () => {
      // Attribute only — the class list legitimately contains the "aria-invalid:" variant.
      expect(field()).not.toMatch(/aria-invalid="/);
    });

    it("styles the invalid state with the debt border", () => {
      expect(field("x")).toMatch(/<input[^>]*class="[^"]*aria-invalid:border-debt/);
    });

    it("reaches the native <select> through Select", () => {
      const html = renderToStaticMarkup(
        createElement(
          Field,
          { label: "To", htmlFor: "s", error: "Same person" },
          createElement(Select, { id: "s" }, createElement("option", { value: "" }, "—"))
        )
      );
      expect(html).toMatch(/<select[^>]*aria-invalid="true"/);
    });
  });
  ```
  (If Vitest ever reports `React is not defined` for the `.tsx` import, the tsconfig `jsx` setting was not picked up — stop and report; do not edit `vitest.config.ts` in this task.)

- [ ] **Step 2: Run it to verify it fails.**
  Run: `npx vitest run src/components/ui/Field.test.ts`
  Expected: FAIL — no `aria-invalid` on the input/select; no `aria-invalid:border-debt` class. ("leaves a valid control unmarked" passes.)

- [ ] **Step 3: Implement.** In `src/components/ui/Field.tsx` replace `fieldBase` with:
  ```ts
  // aria-invalid: variants (U11): a field with an error gets the debt border, also while focused
  // (the focus pair is more specific than focus:border-ink, so it wins without tailwind-merge).
  const fieldBase =
    "w-full bg-card text-ink rounded-md border border-rule px-3 py-2.5 text-base sm:text-sm " +
    "placeholder:text-faint outline-none transition-colors " +
    "focus:border-ink focus:ring-1 focus:ring-ink disabled:opacity-60 " +
    "aria-invalid:border-debt aria-invalid:focus:border-debt aria-invalid:focus:ring-debt";
  ```
  (keep the iOS comment above it). In `Field` replace the comment + `msgId`/`described`/`control` lines with:
  ```tsx
  // Wire the hint/error text to the control via aria-describedby so a screen reader reads it when
  // the field is focused (a11y WCAG 3.3.2). With an error the control is also marked aria-invalid
  // (U11) — announced as invalid and painted with fieldBase's debt border. cloneElement injects both
  // onto the single input child; if a caller passes something exotic, it just isn't described (no crash).
  const msgId = useId();
  const described = (error || hint) ? msgId : undefined;
  const control =
    described && isValidElement(children)
      ? cloneElement(children as ReactElement<{ "aria-describedby"?: string; "aria-invalid"?: boolean }>, {
          "aria-describedby": described,
          ...(error ? { "aria-invalid": true } : {}),
        })
      : children;
  ```
  The callers that already pass `aria-invalid={!!error}` (account, house, TagManager) keep working — leave them as they are.

- [ ] **Step 4: Run it to verify it passes.**
  Run: `npx vitest run src/components/ui/Field.test.ts`
  Expected: PASS (4 tests).

- [ ] **Step 5: Record payment.** In `src/components/balances/RecordPaymentModal.tsx` replace
  ```tsx
        {/* U6: stacked below sm — side by side at 360-390px left ~150px per select, cutting
            member names short. */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
  ```
  with
  ```tsx
        {/* U6: always stacked — side by side, the ~200px columns of the 448px dialog still cut a
            long name ("Júlia Caminho Feli") on desktop and notebook, not only on phones. */}
        <div className="grid grid-cols-1 gap-3">
  ```
  change the "To" field's opening tag to
  ```tsx
          {/* U11: the same-person error belongs to "To" — Field marks its select aria-invalid. */}
          <Field
            label={t("to")}
            htmlFor="pay-to"
            error={fromId !== "" && fromId === toId ? t("sameError") : undefined}
          >
  ```
  and delete the standalone block
  ```tsx
        {fromId !== "" && fromId === toId && (
          <p role="alert" className="text-xs text-debt">{t("sameError")}</p>
        )}
  ```
  (the U18 overpay warning comment that mentions `sameError` stays true: the error is still plain red text with `role="alert"`, now rendered by `Field`).

- [ ] **Step 6: Gates.** `npx tsc --noEmit` clean; `npx eslint src` no new errors; `npm run test` green.

- [ ] **Step 7: Controller live check:** Catalogs › Add category with a duplicate name, House › Join with `ZZZZZZ`, My account with mismatched passwords, Record payment with Bruno → Bruno: each control shows the red border (`getComputedStyle(el).borderTopColor` equals the `text-debt` color) and `aria-invalid="true"`; Record payment at 1440 and 1093 shows "Júlia Caminho Feliz" whole in "To".

- [ ] **Step 8: Loop checks for Task 12 (J0, J3, J5, J6):** U6 stacked at every viewport with the selected name fully visible (text width ≤ select inner width); U11 border color + `aria-invalid` on every error field.

- [ ] **Step 9: Leave changes unstaged** (no commits — the owner commits later on a branch he picks).

---

### Task 3: A7 — nothing under the 12px text floor

The phase-1 fix raised `label-mono`, tags and small buttons; nine arbitrary sizes are still below 0.75rem: the List/By person and Summary/Detailed segmented controls (0.7rem = 11.2px), the Activity filter chips (0.7rem), the Filters modal chips (0.72rem), the rotated `Stamp` ("ACCOUNT", "TO RECEIVE"… 0.7rem), the auth footer "░ SHARED EXPENSES ░" (0.7rem), the drawer and sidebar nav labels (0.74rem) and the By-person "⊟ ratio" (0.7rem). A static scan test keeps the floor from regressing.

**Files:**
- Create test: `src/components/ui/text-floor.test.ts`
- Modify: `src/app/(app)/expenses/page.tsx` (segmented toggle; By-person ratio), `src/app/(app)/activity/page.tsx` (tab toggle; `FilterChip`), `src/components/expenses/ExpenseFiltersModal.tsx` (`MultiChips` button), `src/components/app/MobileNavDrawer.tsx` (nav label), `src/components/app/AppChrome.tsx` (sidebar label), `src/components/ui/Stamp.tsx` (`Stamp`), `src/app/auth/layout.tsx` (footer)

**Interfaces:** none.

- [ ] **Step 1: Write the failing test.** Create `src/components/ui/text-floor.test.ts`:
  ```ts
  import { describe, it, expect } from "vitest";
  import { readdirSync, readFileSync, statSync } from "node:fs";
  import { join, relative } from "node:path";

  // A7: 12px (0.75rem) is the floor for any text. Tailwind's named sizes are all >= 12px, so the
  // only way under it is an arbitrary size like text-[0.7rem] — scan every component for one.
  const ROOT = join(process.cwd(), "src");
  const tsxFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? tsxFiles(p) : p.endsWith(".tsx") ? [p] : [];
    });

  describe("12px text floor (A7)", () => {
    it("no arbitrary text size under 0.75rem / 12px", () => {
      const offenders = tsxFiles(ROOT).flatMap((file) =>
        [...readFileSync(file, "utf8").matchAll(/text-\[(\d*\.?\d+)(rem|px)\]/g)]
          .filter((m) => (m[2] === "rem" ? Number(m[1]) * 16 : Number(m[1])) < 12)
          .map((m) => `${relative(ROOT, file)}: ${m[0]}`)
      );
      expect(offenders).toEqual([]);
    });
  });
  ```

- [ ] **Step 2: Run it to verify it fails.**
  Run: `npx vitest run src/components/ui/text-floor.test.ts`
  Expected: FAIL listing exactly 9 offenders: `app/(app)/expenses/page.tsx` ×2 (`text-[0.7rem]`), `app/(app)/activity/page.tsx` ×2, `app/auth/layout.tsx`, `components/app/AppChrome.tsx` (`text-[0.74rem]`), `components/app/MobileNavDrawer.tsx` (`text-[0.74rem]`), `components/expenses/ExpenseFiltersModal.tsx` (`text-[0.72rem]`), `components/ui/Stamp.tsx`.

- [ ] **Step 3: Implement** — in each of those 9 class strings replace the arbitrary size with `text-xs` (12px) and nothing else:
  - `expenses/page.tsx` view toggle: `… px-3 py-1.5 text-[0.7rem] font-display …` → `… px-3 py-1.5 text-xs font-display …`; By-person ratio `<span className="block text-[0.7rem] text-faint tnum" …>` → `<span className="block text-xs text-faint tnum" …>`.
  - `activity/page.tsx` tab toggle `… px-3 py-1.5 text-[0.7rem] font-display …` and `FilterChip` `… px-2.5 py-1 text-[0.7rem] font-medium …` → `text-xs`.
  - `ExpenseFiltersModal.tsx` `… px-2.5 py-1 text-[0.72rem] font-medium …` → `text-xs`.
  - `MobileNavDrawer.tsx` and `AppChrome.tsx` `font-display font-bold uppercase tracking-wide text-[0.74rem]` → `font-display font-bold uppercase tracking-wide text-xs`.
  - `Stamp.tsx` `… px-2 py-0.5 font-display text-[0.7rem] font-bold …` → `text-xs`.
  - `auth/layout.tsx` `mt-6 text-center text-[0.7rem] uppercase tracking-widest text-faint` → `mt-6 text-center text-xs uppercase tracking-widest text-faint`.

- [ ] **Step 4: Run it to verify it passes.**
  Run: `npx vitest run src/components/ui/text-floor.test.ts`
  Expected: PASS.

- [ ] **Step 5: Gates.** `npx tsc --noEmit` clean; `npx eslint src` no new errors; `npm run test` green.

- [ ] **Step 6: Controller live check (390 and 360):** List/By person and Summary/Detailed still fit on one line each; the Activity chips still wrap cleanly; the drawer labels and the auth footer stay on one line in the 4 locales.

- [ ] **Step 7: Loop check for Task 12 (J0, J1, J2, J7 celular):** no visible text node under 12px (helper `fontesMiudas` in Task 12) on Expenses, Balances, Activity, Filters, drawer, login.

- [ ] **Step 8: Leave changes unstaged** (no commits — the owner commits later on a branch he picks).

---

### Task 4: Expenses list — R2-01, R2-14, R2-21, R2-22, R2-25

- **R2-01:** in `ExpenseCard` the payer name is the only shrinkable item of the "avatar · name · date · ⊟ ratio" row, so it collapses to "An…". The row now wraps instead (date and badge move to a 2nd line when they don't fit); a clipping trick keeps any line from starting with "·". Trade-off accepted: a card whose metadata wraps is one line taller (D13 only required that the badge not sit under the amount).
- **R2-14:** each By-person month is its own auto-width table, so Date/Amount move between months. One table per person with a `<tbody>` per month (the list view's model) shares the columns; Amount still sizes to content (U20).
- **R2-21:** the bulk bar's "2 SELECTED" and "DELETE SELECTED" wrap at 390 → no-wrap label and the existing shorter `deleteCount` text ("Delete 2").
- **R2-22:** the search placeholder is longer than the 360–390px field → drop the verb (the label already says "Search").
- **R2-25:** with 0 results the top "Clear filters" duplicates the empty state's button → show the top one only when there are results.

**Files:**
- Modify: `src/app/(app)/expenses/page.tsx` (`ExpenseCard`, By-person block, filters row, bulk bar)
- Modify: `src/messages/{en,pt,es,fr}.json` (`Expenses.searchPlaceholder` values)

**Interfaces:** none (presentation only).

- [ ] **Step 1 (R2-01): card metadata.** In `ExpenseCard` replace the whole block from `<div className="mt-1.5 flex items-center gap-2 text-xs text-faint">` to its closing `</div>` (the one holding the payer, "·", date and `⊟ {ratio}` with the D13 comment) with:
  ```tsx
        {/* R2-01: the payer is never squeezed — when "date · ⊟ ratio" doesn't fit beside the name it
            wraps to a second line (the D13 badge stays here, off the amount column). Each item draws
            its own "·" in its 12px left padding; the row is pulled 12px left inside an
            overflow-hidden wrapper, so whichever item starts a line has its dot clipped and no line
            ever begins with "·". */}
        <div className="mt-1.5 overflow-hidden text-xs text-faint">
          <div className="-ml-3 flex flex-wrap items-center gap-y-0.5">
            {!hidePayer && (
              <span className="relative flex min-w-0 max-w-full items-center gap-1.5 pl-3">
                <span aria-hidden className="absolute left-0.5">·</span>
                <MemberDot colorIndex={colorIndex} name={payerName} size={18} />
                <span className="truncate">{payerName}</span>
              </span>
            )}
            <span className="relative shrink-0 pl-3 tnum">
              <span aria-hidden className="absolute left-0.5">·</span>
              {formatDateLocale(e.date)}
            </span>
            {ratio && (
              <span className="relative shrink-0 pl-3 tnum" title={t("customSplit")}>
                <span aria-hidden className="absolute left-0.5">·</span>⊟ {ratio}
              </span>
            )}
          </div>
        </div>
  ```
  (`truncate` on the name only applies when the name alone is wider than the whole card.)

- [ ] **Step 2 (R2-14): one By-person table per person.** Inside the By-person `<Card>`, replace the whole `person.months.length === 0 ? ( … ) : ( person.months.map((mg) => ( <div key={mg.key}> … </div> )) )` expression (month header div + per-month `<table>` + per-month mobile `<ul>`) with:
  ```tsx
                    {person.months.length === 0 ? (
                      <p className="px-4 py-8 text-center text-sm text-faint">{t("emptyTitle")}</p>
                    ) : (
                      <>
                        {/* R2-14: ONE table per person with a <tbody> per month (the list view's
                            model), so Date and Amount share their columns across months. U20 still
                            holds: no table-fixed, Amount sizes to the widest amount of the card and
                            Description absorbs the rest. */}
                        <table className="hidden w-full md:table">
                          <thead>
                            <tr>
                              <th className="w-6 px-2 py-1.5" aria-hidden />
                              <th className="label-mono px-4 py-1.5 text-left">{t("colDescription")}</th>
                              <th className="label-mono w-[86px] px-2 py-1.5 text-left">{t("colDate")}</th>
                              <th className="label-mono w-auto whitespace-nowrap px-2 py-1.5 text-right">{t("colAmount")}</th>
                            </tr>
                          </thead>
                          {person.months.map((mg) => (
                            <tbody key={mg.key}>
                              <tr className="border-t border-dashed border-rule bg-panel/40">
                                {/* pr-2 = the Amount cell's px-2, so the subtotal lines up with the amounts. */}
                                <th colSpan={4} className="py-2 pl-4 pr-2 text-left font-normal">
                                  <span className="flex items-center justify-between gap-3">
                                    <span className="label-mono min-w-0 truncate">▦&nbsp;{mg.label}</span>
                                    <Money value={mg.subtotal} className="text-ink-soft" />
                                  </span>
                                </th>
                              </tr>
                              {mg.items.map((e, i) => {
                                const ratio = splitRatio(e);
                                return (
                                <tr key={e.publicId} onClick={() => openView(e)} className="group cursor-pointer border-t border-dotted border-rule align-middle transition-colors hover:bg-panel/30">
                                  <td className="px-2 py-2 text-xs leading-5 text-faint tnum" aria-hidden>{i + 1}</td>
                                  <td className="px-4 py-2 text-sm text-ink">
                                    <span className="break-words">{e.description}</span>
                                    <ExpenseTags expense={e} className="mt-1" />
                                  </td>
                                  <td className="whitespace-nowrap px-2 py-2 text-xs text-ink-soft">
                                    {formatDateLocale(e.date)}
                                  </td>
                                  <td className="relative w-auto whitespace-nowrap px-2 py-2 text-right max-md:pr-12 pointer-coarse:pr-12">
                                    <Money value={e.amount} />
                                    {ratio && <span className="block text-xs text-faint tnum" title={t("customSplit")}>⊟ {ratio}</span>}
                                    {/* Desktop: ⋯ floats in on hover; touch/narrow: stays in the reserved right padding. */}
                                    <span onClick={(ev) => ev.stopPropagation()} className="absolute inset-y-0 right-0.5 flex items-center bg-gradient-to-l from-card via-card to-transparent pl-6 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 max-md:opacity-100 pointer-coarse:opacity-100">
                                      <RowMenu onEdit={() => openEdit(e)} onDelete={() => setDeleteTarget(e)} />
                                    </span>
                                  </td>
                                </tr>
                                );
                              })}
                            </tbody>
                          ))}
                        </table>
                        {/* Mobile: same card model as the list view (no cramped columns). */}
                        <div className="md:hidden">
                          {person.months.map((mg) => (
                            <div key={mg.key}>
                              <div className="flex items-center justify-between gap-3 border-t border-dashed border-rule bg-panel/40 px-4 py-2">
                                <span className="label-mono min-w-0 truncate max-sm:tracking-[0.03em]">▦&nbsp;{mg.label}</span>
                                <Money value={mg.subtotal} className="text-ink-soft" />
                              </div>
                              <ul>
                                {mg.items.map((e) => (
                                  <ExpenseCard
                                    key={e.publicId}
                                    expense={e}
                                    colorIndex={person.colorIndex}
                                    members={members}
                                    selectionMode={false}
                                    onView={openView}
                                    onEdit={openEdit}
                                    onDelete={setDeleteTarget}
                                    hidePayer
                                  />
                                ))}
                              </ul>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
  ```
  (Row markup is the existing one, unchanged except that Task 3 already made the ratio `text-xs`. The B5 subtotals keep coming from `mg.subtotal`.)

- [ ] **Step 3 (R2-25 + R2-21): filters row and bulk bar.** In the applied-filters row wrap the top button:
  ```tsx
              {/* R2-25: with 0 results the empty state below carries the only "Clear filters". */}
              {total > 0 && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="label-mono inline-flex min-h-8 shrink-0 items-center rounded-md px-2 py-1.5 text-stamp-text transition-colors hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
                >
                  {t("clearFilters")}
                </button>
              )}
  ```
  (Task 7 changes its `min-h-8` later.) In the bulk action bar change the counter to `<span className="label-mono whitespace-nowrap">{t("selectedCount", { count: selectedCount })}</span>` and the danger button to:
  ```tsx
            <Button
              variant="danger"
              size="sm"
              className="whitespace-nowrap"
              disabled={selectedCount === 0}
              onClick={() => setBulkConfirm(true)}
            >
              {/* R2-21: "Delete 2" (existing deleteCount) instead of "Delete selected", which wrapped
                  to 2 lines at 390px; the confirm dialog keeps the deleteSelected title. */}
              {t("deleteCount", { count: selectedCount })}
            </Button>
  ```

- [ ] **Step 4 (R2-22): messages.** Change `Expenses.searchPlaceholder` values (keys unchanged):
  - en `"Description, notes, person…"`
  - pt `"Descrição, observação, pessoa…"`
  - es `"Descripción, nota, persona…"`
  - fr `"Description, note, personne…"`

- [ ] **Step 5: Gates.** `npx tsc --noEmit` clean; `npx eslint src` no new errors; `npm run test` green; i18n parity OK.

- [ ] **Step 6: Controller live check:** 360 (List) and 390 (selection mode): "Bruno QA"/"Ana QA" whole on cards with "⊟ 70/30"; a wrapped line never starts with "·"; "Júlia Caminho Feliz" whole; bulk bar on one line; By person at 1440: one column header per person, Date and Amount columns aligned across months, subtotal right edge = amounts' right edge.

- [ ] **Step 7: Loop checks for Task 12 (J0, J2, J8):** R2-01, R2-14, R2-21, R2-22, R2-25 (table in Task 12).

- [ ] **Step 8: Leave changes unstaged** (no commits — the owner commits later on a branch he picks).

---

### Task 5: Expense form and detail — R2-04, R2-16, R2-15, R2-23

- **R2-04:** the Amount | Date grid leaves the native date input ~150px at 360 → "03/10/202" under the calendar icon. Stack the two fields below 380px (390 keeps the 2 columns, where the date fits); stacked, the amount hint stays right under Amount.
- **R2-16:** Amount mode shows a black TOTAL + green "Matches ✓"; % mode shows a green TOTAL and no "Matches ✓" → both modes: TOTAL in the state color, "Matches ✓" when the split is right.
- **R2-15:** the history change row is a wrapping flex, so the new "Split" value restarts under the label → label column + value column (hanging indent).
- **R2-23:** the date-time can break between date and time → keep it on one line, with a real space before it.

**Files:**
- Modify: `src/components/expenses/ExpenseFormModal.tsx` (Amount/Date grid, custom-split footers)
- Modify: `src/components/expenses/ExpenseDetailModal.tsx` (`ExpenseHistory`)

**Interfaces:** none.

- [ ] **Step 1 (R2-04).** In `ExpenseFormModal.tsx` replace the opening `<div className="grid grid-cols-2 gap-3">` of the Amount/Date block with:
  ```tsx
        {/* R2-04: stacked below 380px — at 360 the half-width native date input cut the year
            ("03/10/202"). Stacked, the date moves last so the amount hint stays under Amount. */}
        <div className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2">
  ```
  wrap the Date field: `<div className="max-[379px]:order-last">` + the existing `<Field label={t("date")} htmlFor="exp-date">…</Field>` + `</div>`; and change the hint paragraph to `<p id="exp-amount-hint" className="text-pretty text-xs text-faint min-[380px]:col-span-2">` (a plain `col-span-2` inside a 1-column grid would create an implicit 2nd column).

- [ ] **Step 2 (R2-16).** In the Amount-mode footer change the TOTAL `Money` to
  ```tsx
                    <Money
                      value={fromCents(customSumCents)}
                      // R2-16: same rule as the % mode — the total takes the state color.
                      className={customMismatch ? "text-debt" : amountMatches ? "text-credit" : undefined}
                    />
  ```
  In the %-mode block, right after `{totalCents <= 0 && (<p className="text-xs text-faint">{t("enterTotal")}</p>)}` add:
  ```tsx
                {/* R2-16: "Matches ✓" in both modes (Amount already shows it). */}
                {percentMatches && (
                  <p className="text-xs">
                    <span className="text-credit">{t("matches")}</span>
                  </p>
                )}
  ```

- [ ] **Step 3 (R2-15 + R2-23).** In `ExpenseHistory` (`ExpenseDetailModal.tsx`) replace the entry header line
  ```tsx
                  <span className="ml-1.5 text-xs text-faint tnum">{formatDateTimeLocale(e.createdAt)}</span>
  ```
  with
  ```tsx
                  {/* R2-23: a real space (screen readers and copy-paste read "edited 03/10/2026 18:54")
                      and nowrap, so the time never drops alone to the next line. */}
                  {" "}
                  <span className="whitespace-nowrap text-xs text-faint tnum">{formatDateTimeLocale(e.createdAt)}</span>
  ```
  and replace the change row `<li key={c.field} className="flex flex-wrap items-center gap-1 text-xs text-faint"> … </li>` with
  ```tsx
                        <li key={c.field} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-1 text-xs text-faint">
                          {/* R2-15: label column + value column — a long "old → new" (the Split row)
                              wraps under the old value (hanging indent), not under the label. */}
                          <span>{fieldLabel(c.field)}:</span>
                          <span className="min-w-0">
                            <span className="line-through opacity-70">{renderValue(c.field, c.from)}</span>{" "}
                            <span aria-hidden>→</span>{" "}
                            <span className="text-ink-soft">{renderValue(c.field, c.to)}</span>
                          </span>
                        </li>
  ```

- [ ] **Step 4: Gates.** `npx tsc --noEmit` clean; `npx eslint src` no new errors; `npm run test` green.

- [ ] **Step 5: Controller live check:** New expense at 360 shows "03/10/2026" whole (fields stacked, hint under Amount) and at 390 keeps Amount | Date side by side; custom split at 100% shows "Matches ✓" in both modes with a green TOTAL; History at 1440 aligns the wrapped Split value under the old value; at 390 date and time stay together.

- [ ] **Step 6: Loop checks for Task 12 (J0 360, J2, J8 360):** R2-04, R2-15, R2-16, R2-23.

- [ ] **Step 7: Leave changes unstaged** (no commits — the owner commits later on a branch he picks).

---

### Task 6: Balances and House rows — R2-02, R2-13, R2-24, R2-29, R2-31

- **R2-02:** below `sm` the "Carla QA → Júlia Caminho …" line is `truncate`d next to MARK PAID → let it wrap (same rule as the post-run Members/Per person fixes).
- **R2-13:** RECORD PAYMENT and MARK PAID are ghost text buttons whose 12px padding indents the text from the card edge and gives no affordance → `secondary` (bordered: the border box sits on the card's content edge). House › Members: tags centered in their column and the ⋯ glyph inset by its padding → tags right-aligned and the ⋯ glyph on the edge.
- **R2-24:** the payment date sits inline with the avatars and wraps or not depending on the amount's width → on phones the date joins the names line (fixed position); `sm` and up unchanged.
- **R2-29:** a month with 0.4% of the total shows "0%" → "<1%" for a positive value that rounds to 0 (pure helper, TDD).
- **R2-31:** Your houses truncates the house name at 360 while the card above wraps it → same `max-sm:line-clamp-2` rule.

**Files:**
- Modify: `src/lib/percent.ts` · Test: `src/lib/percent.test.ts`
- Modify: `src/app/(app)/balances/page.tsx`
- Modify: `src/app/(app)/house/page.tsx` (Members row, Your houses row)

**Interfaces:**
- Produces: `export function percentLabel(percent: number, value: number): string` in `src/lib/percent.ts` — `"<1%"` when `percent === 0 && value > 0`, else `` `${percent}%` ``.

- [ ] **Step 1: Write the failing test.** Change the import in `src/lib/percent.test.ts` to `import { percentLabel, percentsTo100 } from './percent'` and append:
  ```ts
  describe('percentLabel (R2-29)', () => {
    it('reads "<1%" for a positive value that rounds to 0', () => expect(percentLabel(0, 45)).toBe('<1%'))
    it('keeps "0%" for a zero value', () => expect(percentLabel(0, 0)).toBe('0%'))
    it('prints whole percents as they are', () => expect(percentLabel(73, 9000)).toBe('73%'))
  })
  ```

- [ ] **Step 2: Run it to verify it fails.**
  Run: `npx vitest run src/lib/percent.test.ts`
  Expected: FAIL — `percentLabel` is not exported.

- [ ] **Step 3: Implement** (append to `src/lib/percent.ts`):
  ```ts
  /** Label for one whole-percent share (R2-29): a positive value that rounds to 0 reads "<1%" —
   *  "0%" next to a real amount looked like the month spent nothing. The numbers themselves still
   *  come from percentsTo100, so the shown integers keep summing to 100 (D8). */
  export function percentLabel(percent: number, value: number): string {
    return percent === 0 && value > 0 ? '<1%' : `${percent}%`
  }
  ```

- [ ] **Step 4: Run it to verify it passes.**
  Run: `npx vitest run src/lib/percent.test.ts`
  Expected: PASS.

- [ ] **Step 5: Balances.** In `src/app/(app)/balances/page.tsx`:
  - import: `import { percentLabel, percentsTo100 } from "@/lib/percent";`
  - By category: `<span className="label-mono text-faint">{catPercents[i]}%</span>` → `<span className="label-mono text-faint">{percentLabel(catPercents[i], c.total)}</span>`; By month: `{monthPercents[i]}%` → `{percentLabel(monthPercents[i], m.total)}` (same span).
  - Who pays whom header: the Record payment `<Button size="sm" variant="ghost" className="whitespace-nowrap" …>` → `variant="secondary"`, with the comment `{/* R2-13: bordered (secondary), so it reads as a button and its edge sits on the card margin. */}` above it.
  - both MARK PAID buttons (the `sm:flex` row and the below-`sm` block): `variant="ghost"` → `variant="secondary"`.
  - below-`sm` names line: replace `<p className="min-w-0 truncate text-xs text-ink-soft" aria-hidden="true">` with
    ```tsx
                      {/* R2-02: wraps instead of cutting the recipient next to MARK PAID — two people
                          with similar names must stay distinguishable on the row that settles them. */}
                      <p className="min-w-0 flex-1 break-words text-xs text-ink-soft" aria-hidden="true">
    ```
  - Recorded payments (R2-24): the inline date `<span className="ml-1 text-xs text-faint">{formatDateLocale(p.date)}</span>` → `<span className="sr-only text-xs text-faint sm:not-sr-only sm:ml-1">{formatDateLocale(p.date)}</span>` (still read by screen readers on phones), and the phone-only names paragraph becomes:
    ```tsx
                  {/* U5: aria-hidden — each MemberChip's dot already carries its name via aria-label/title, so this phone-only text is a sighted-only duplicate.
                      R2-24: the date lives here on phones, so it never jumps between rows with the amount's width. */}
                  <p className="mt-1 break-words text-xs text-ink-soft sm:hidden" aria-hidden="true">
                    {displayName(p.fromUser.id, p.fromUser.name)} → {displayName(p.toUser.id, p.toUser.name)}
                    <span className="whitespace-nowrap text-faint"> · {formatDateLocale(p.date)}</span>
                  </p>
    ```

- [ ] **Step 6: House.** In `src/app/(app)/house/page.tsx`:
  - Members row: `<div className="w-20 shrink-0 text-center">` → `<div className="w-20 shrink-0 text-right">` with `{/* R2-13: right-aligned, so tag, "Leave house" and ⋯ end on the same edge. */}` above it; the member ⋯ trigger class `inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-sm px-2 py-1 …` → `-mr-2 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-end rounded-sm px-2 py-1 …` (rest unchanged; glyph flush with the edge, 44px hit area kept).
  - Your houses (R2-31): `<p className="truncate text-sm font-medium text-ink">{g.name}</p>` → `<p className="text-sm font-medium text-ink max-sm:line-clamp-2 max-sm:break-words sm:truncate">{g.name}</p>` with `{/* R2-31: same rule as the house card and Members — 2 lines below sm, truncate from sm up. */}`.

- [ ] **Step 7: Gates.** `npx tsc --noEmit` clean; `npx eslint src` no new errors; `npm run test` green.

- [ ] **Step 8: Controller live check (390, 360, 1440, Bolitas too):** names line shows "Carla QA → Júlia Caminho Feliz" whole (2 lines at 360); RECORD PAYMENT / MARK PAID bordered, MARK PAID's right edge = the amount's right edge (±1px); recorded payments put the date on the names line on every row; "OUT. 2026 <1%"; Members tags/"Leave house"/⋯ end on one edge; Your houses wraps "Casa Caminho Feliz".

- [ ] **Step 9: Loop checks for Task 12 (J0, J3, J8):** R2-02, R2-13, R2-24, R2-29, R2-31; the `[U5]` probe still finds 2 avatars of 22×22 and a 44px MARK PAID.

- [ ] **Step 10: Leave changes unstaged** (no commits — the owner commits later on a branch he picks).

---

### Task 7: R2-06 + R2-07 — 44px touch targets for text controls and menu items

Spec 003 criterion 7 lists primary buttons, icon buttons and segmented controls; text buttons, menu items and stand-alone links were left at 17–36px. Below `md` they all get `min-h-11` (desktop density unchanged via `md:min-h-0`). "Export CSV" was a 20px `<a>` inside a 36px menu row (tapping the row outside the link did nothing) → a plain `MenuItem` whose `onSelect` navigates to the download (the route answers `Content-Disposition: attachment`, so the page stays).

**Files:**
- Modify: `docs/specs/003-mobile-navigation-drawer/requirements.md` (criterion 7), `docs/specs/003-mobile-navigation-drawer/tasks.md`
- Modify: `src/components/ui/Menu.tsx` (`MenuItem`, `MenuRadioItem`, `MenuSub` trigger)
- Modify: `src/app/(app)/expenses/page.tsx` (Export CSV item, top "Clear filters")
- Modify: `src/components/expenses/ExpenseDetailModal.tsx` (History toggle)
- Modify: `src/components/expenses/ExpenseFormModal.tsx` (2 "Equalize" buttons)
- Modify: `src/components/expenses/ImportCsvModal.tsx` (template link)
- Modify: `src/app/auth/login/page.tsx`, `src/app/auth/register/page.tsx` (footer links)
- Modify: `src/components/app/AppChrome.tsx` (brand link)

**Interfaces:** none.

- [ ] **Step 1: Spec 003.** In `requirements.md` replace criterion 7 with:
  ```markdown
  7. WHILE the viewport is narrower than 768px, THE SYSTEM SHALL keep primary buttons, icon buttons,
     segmented controls, text buttons, menu items and stand-alone links (the brand link, form
     footer links, help links on a line of their own) at least 44px tall; removable filter chips
     SHALL be at least 32px tall. Links inside running text are exempt (WCAG 2.5.8 inline exception).
  ```
  In `tasks.md` append:
  ```markdown
  - [ ] 6. Extend the 44px floor to text buttons, menu items and stand-alone links (loop round 2,
        R2-06/R2-07) — `src/components/ui/Menu.tsx`, `src/app/(app)/expenses/page.tsx`,
        `src/components/expenses/*.tsx`, `src/app/auth/*/page.tsx`, `src/components/app/AppChrome.tsx` _Requirements: 7_
  ```

- [ ] **Step 2: Menus (R2-07).** In `src/components/ui/Menu.tsx` add `min-h-11 md:min-h-0` to the base class string of `MenuItem` (`"flex min-h-11 min-w-0 cursor-pointer items-center gap-2 rounded-sm px-3 py-2 text-sm outline-none md:min-h-0"`), of `MenuRadioItem` and of the `MenuSub` `SubTrigger`, each with the comment `// R2-07: 44px rows on touch (were 36px); compact again from md.` on the first one. In `expenses/page.tsx` replace
  ```tsx
              <MenuItem>
                {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- API download endpoint, not a page route */}
                <a href="/api/expenses/export" className="flex w-full items-center">
                  {t("exportCsv")}
                </a>
              </MenuItem>
  ```
  with
  ```tsx
              {/* R2-07: the whole 44px row downloads (was a 20px link inside the row). The route
                  answers Content-Disposition: attachment, so the page stays where it is. */}
              <MenuItem onSelect={() => { window.location.href = "/api/expenses/export"; }}>
                {t("exportCsv")}
              </MenuItem>
  ```

- [ ] **Step 3: Text buttons and links (R2-06)** — add the classes, nothing else:
  - `expenses/page.tsx` top "Clear filters": `min-h-8` → `min-h-11 md:min-h-8`.
  - `ExpenseDetailModal.tsx` History toggle: `"flex items-center gap-1.5 self-start label-mono text-ink-soft hover:text-ink"` → `"flex min-h-11 items-center gap-1.5 self-start label-mono text-ink-soft hover:text-ink md:min-h-0"`.
  - `ExpenseFormModal.tsx` both Equalize buttons: `"label-mono underline decoration-dotted hover:text-ink"` → `"label-mono inline-flex min-h-11 items-center underline decoration-dotted hover:text-ink md:min-h-0"`.
  - `ImportCsvModal.tsx` template link: `"mt-1 inline-block text-ink-soft underline decoration-dotted underline-offset-2 hover:text-ink"` → `"mt-1 inline-flex min-h-11 items-center text-ink-soft underline decoration-dotted underline-offset-2 hover:text-ink md:min-h-0"`.
  - `auth/login/page.tsx` and `auth/register/page.tsx` footer `<Link … className="text-ink underline underline-offset-2">` → `className="inline-flex min-h-11 items-center text-ink underline underline-offset-2 md:min-h-0"`.
  - `AppChrome.tsx` brand `<Link href="/expenses" className="shrink-0 font-display text-base font-bold tracking-tight text-ink">` → `className="inline-flex min-h-11 shrink-0 items-center font-display text-base font-bold tracking-tight text-ink md:min-h-0"` (the phone header row is already 44px tall: no layout change).

- [ ] **Step 4: Gates.** `npx tsc --noEmit` clean; `npx eslint src` no new errors (the removed `eslint-disable` line must not leave an "unused directive" warning); `npm run test` green.

- [ ] **Step 5: Controller live check (390):** every `[role=menuitem]`, `[role=menuitemradio]` and submenu trigger is ≥ 44px tall; Export CSV downloads from a tap anywhere on its row; "+ History", "Equalize", "Clear filters", "Download example CSV", "Create account"/"Sign in" and the brand are ≥ 44px tall; desktop menus keep their compact height.

- [ ] **Step 6: Loop check for Task 12 (J10, J2, J9, J1 celular):** no `alvoMenor44` for these controls.

- [ ] **Step 7: Leave changes unstaged** (no commits — the owner commits later on a branch he picks).

---

### Task 8: R2-11 — avatar initials never under 12px

`MemberDot` sizes its text at `size × 0.4` → 7px (18px avatar), 9px (22), 10px (26), 11px (28): unreadable ("CQ" reads "CO"). Two initials only fit at ≥ 12px from a 30px avatar up; smaller avatars show the first initial alone. The name stays in `title`/`aria-label`.

**Files:**
- Modify: `src/lib/members.ts` · Create test: `src/lib/members.test.ts`
- Modify: `src/components/ui/Member.tsx` (`MemberDot`)

**Interfaces:**
- Produces: `export function avatarLabel(name: string, size: number): { text: string; fontSize: number }` in `src/lib/members.ts`.

- [ ] **Step 1: Write the failing test.** Create `src/lib/members.test.ts`:
  ```ts
  import { describe, it, expect } from "vitest";
  import { avatarLabel } from "./members";

  describe("avatarLabel (R2-11)", () => {
    it("keeps two initials from a 30px avatar up, never under 12px", () => {
      expect(avatarLabel("Carla QA", 32)).toEqual({ text: "CQ", fontSize: 13 });
      expect(avatarLabel("Carla QA", 30)).toEqual({ text: "CQ", fontSize: 12 });
    });
    it("shows only the first initial on smaller avatars, at 12px or more", () => {
      expect(avatarLabel("Carla QA", 22)).toEqual({ text: "C", fontSize: 12 });
      expect(avatarLabel("Júlia Caminho Feliz", 18)).toEqual({ text: "J", fontSize: 12 });
      expect(avatarLabel("Bruno QA", 26)).toEqual({ text: "B", fontSize: 14 });
    });
    it("falls back to ? for a blank name", () => expect(avatarLabel("  ", 22).text).toBe("?"));
  });
  ```

- [ ] **Step 2: Run it to verify it fails.**
  Run: `npx vitest run src/lib/members.test.ts`
  Expected: FAIL — `avatarLabel` is not exported.

- [ ] **Step 3: Implement.** Append to `src/lib/members.ts`:
  ```ts
  /** Avatar text (R2-11): two initials are only legible at the 12px floor (A7) from a 30px avatar
   *  up; smaller avatars show the first initial alone, at 12px or more. The full name stays in the
   *  avatar's title/aria-label. */
  export function avatarLabel(name: string, size: number): { text: string; fontSize: number } {
    const full = initials(name);
    if (size >= 30) return { text: full, fontSize: Math.round(size * 0.4) };
    return { text: full.charAt(0), fontSize: Math.max(12, Math.round(size * 0.55)) };
  }
  ```
  In `src/components/ui/Member.tsx`: import `avatarLabel` (replacing `initials` in the `@/lib/members` import), add `const label = avatarLabel(name, size);` after `const s = memberStyle(colorIndex);`, set `fontSize: label.fontSize,` in the style object and render `{label.text}` instead of `{initials(name)}`.

- [ ] **Step 4: Run it to verify it passes.**
  Run: `npx vitest run src/lib/members.test.ts`
  Expected: PASS.

- [ ] **Step 5: Gates.** `npx tsc --noEmit` clean; `npx eslint src` no new errors; `npm run test` green.

- [ ] **Step 6: Loop check for Task 12 (J0 360, J2 celular, J7):** every visible avatar's computed font-size ≥ 12px (covered by `fontesMiudas`).

- [ ] **Step 7: Leave changes unstaged** (no commits — the owner commits later on a branch he picks).

---

### Task 9: R2-03 — linking expenses to an item reads as such, in Summary and Detailed

Summary: the link route records `UPDATE SHOPPING_ITEM` with `changes: { linkedExpenseIds }`; B7 hid that technical field, so the entry is a bare "updated an item". A pure helper picks a dedicated phrase ("linked 2 expenses to an item" / "removed the expense links of an item") — works for rows already stored. Detailed: link rows live in `ShoppingItemExpense`, which the feed does not list, so the event is missing there (6 vs 3 in the review). `replaceExpenseLinks` now writes a `ShoppingItem` UPDATE revision with the linked-expense count before → after, inside the same transaction as the links.

> **Overlap with the parallel observability plan:** this task edits `src/services/shopping-item.service.ts` — `replaceExpenseLinks` only. The observability plan edits `togglePurchased`'s `catch` in the same file. Re-read the file immediately before editing and keep every change you find there. `src/lib/api-helpers.ts` (`recordActivity`) is NOT touched.

**Files:**
- Modify: `docs/specs/005-shopping-item-expense-links/requirements.md`, `docs/specs/005-shopping-item-expense-links/tasks.md`
- Modify: `src/lib/activity-format.ts` · Test: `src/lib/activity-format.test.ts`
- Modify: `src/services/shopping-item.service.ts` (`replaceExpenseLinks`)
- Modify: `src/app/api/shopping-items/[itemId]/expenses/route.ts` (`PUT`)
- Modify: `src/app/(app)/activity/page.tsx` (`SummaryFeed`, `SNAPSHOT_FIELDS`)
- Modify: `src/messages/{en,pt,es,fr}.json` (`Activity.act.LINK_SHOPPING_ITEM`, `Activity.field.linkedExpenses`)
- Test: `src/services/tenant-isolation.test.ts` (describe `"shopping item expense links (integration, real pglite DB)"`)

**Interfaces:**
- Produces: `export function summaryPhrase(entry: { action: string; entityType: string; changes: Record<string, unknown> | null }): { key: string; values: { count: number } } | null` in `src/lib/activity-format.ts`.
- Produces: `shoppingItemService.replaceExpenseLinks(groupId: number, publicId: string, expensePublicIds: string[], actorId: number | null = null)` — same return value; also writes one `EntityRevision` (`entityType: "ShoppingItem"`, `action: "UPDATE"`, `before`/`after` = the item's columns + `linkedExpenses: <count>`).

- [ ] **Step 1: Spec 005.** In `requirements.md` append criterion 7 after criterion 6:
  ```markdown
  7. WHEN an item's expense links are replaced, THE SYSTEM SHALL show it in Activity › Summary as
     "linked N expenses to an item" (N = 0: "removed the expense links of an item") and in
     Activity › Detailed as an update of that shopping item with the linked-expense count
     before → after.
  ```
  In `tasks.md` append:
  ```markdown
  - [ ] 8. Activity wording and a Detailed revision for link changes (loop round 2, R2-03) —
        `src/lib/activity-format.ts`, `src/services/shopping-item.service.ts`,
        `src/app/api/shopping-items/[itemId]/expenses/route.ts`, `src/app/(app)/activity/page.tsx`,
        `src/services/tenant-isolation.test.ts` _Requirements: 7_
  ```

- [ ] **Step 2: Write the failing unit test.** In `src/lib/activity-format.test.ts` change the import to `import { formatChangeValue, summaryPhrase } from './activity-format'` and append:
  ```ts
  describe('summaryPhrase (R2-03)', () => {
    const link = (ids: string[], extra: Record<string, unknown> = {}) =>
      ({ action: 'UPDATE', entityType: 'SHOPPING_ITEM', changes: { linkedExpenseIds: ids, ...extra } })
    it('names a link change with the resulting count', () =>
      expect(summaryPhrase(link(['a', 'b']))).toEqual({ key: 'act.LINK_SHOPPING_ITEM', values: { count: 2 } }))
    it('counts 0 when every link was removed', () =>
      expect(summaryPhrase(link([]))).toEqual({ key: 'act.LINK_SHOPPING_ITEM', values: { count: 0 } }))
    it('leaves other updates to the generic phrase', () => {
      expect(summaryPhrase({ action: 'UPDATE', entityType: 'SHOPPING_ITEM', changes: { name: { from: 'a', to: 'b' } } })).toBeNull()
      expect(summaryPhrase(link(['a'], { name: { from: 'a', to: 'b' } }))).toBeNull()
      expect(summaryPhrase({ action: 'UPDATE', entityType: 'GROUP', changes: null })).toBeNull()
    })
  })
  ```

- [ ] **Step 3: Run it to verify it fails.**
  Run: `npx vitest run src/lib/activity-format.test.ts`
  Expected: FAIL — `summaryPhrase` is not exported.

- [ ] **Step 4: Implement the helper** (append to `src/lib/activity-format.ts`):
  ```ts
  /**
   * Summary-feed phrase for an AuditLog entry that the generic `act.<ACTION>_<TYPE>` can't describe
   * (R2-03). A shopping item's expense-link change is recorded as UPDATE with only
   * `linkedExpenseIds` (the resulting set), which B7 hides as a technical field — it used to render
   * as a bare "updated an item". Returns the message key + ICU values, or null for the generic phrase.
   */
  export function summaryPhrase(entry: {
    action: string
    entityType: string
    changes: Record<string, unknown> | null
  }): { key: string; values: { count: number } } | null {
    if (entry.entityType !== 'SHOPPING_ITEM' || entry.action !== 'UPDATE' || !entry.changes) return null
    const ids = entry.changes.linkedExpenseIds
    if (!Array.isArray(ids) || Object.keys(entry.changes).length !== 1) return null
    return { key: 'act.LINK_SHOPPING_ITEM', values: { count: ids.length } }
  }
  ```

- [ ] **Step 5: Run it to verify it passes.**
  Run: `npx vitest run src/lib/activity-format.test.ts`
  Expected: PASS.

- [ ] **Step 6: Write the failing integration test.** Append inside `describe("shopping item expense links (integration, real pglite DB)", …)` in `src/services/tenant-isolation.test.ts`:
  ```ts
  it("replaceExpenseLinks records the linked-expense count before/after on the item (R2-03)", async () => {
    const { ana, houseA, expA } = await seedTwoHouses();
    const item = await shoppingItemService.create(houseA.id, "Detergent", ana.id);
    await shoppingItemService.togglePurchased(houseA.id, item.publicId, ana.id);
    await shoppingItemService.replaceExpenseLinks(houseA.id, item.publicId, [expA.publicId], ana.id);
    await shoppingItemService.replaceExpenseLinks(houseA.id, item.publicId, [], ana.id);
    await flushAudit();

    const revs = await prisma.entityRevision.findMany({
      where: { entityType: "ShoppingItem", entityId: String(item.id), action: "UPDATE" },
      orderBy: { id: "asc" },
    });
    const links = revs.filter((r) => (r.after as Record<string, unknown>).linkedExpenses !== undefined);
    expect(
      links.map((r) => [
        (r.before as Record<string, unknown>).linkedExpenses,
        (r.after as Record<string, unknown>).linkedExpenses,
      ])
    ).toEqual([[0, 1], [1, 0]]);
    expect(links.every((r) => r.actorId === ana.id && r.groupId === houseA.id)).toBe(true);
    expect((links[0].after as Record<string, unknown>).name).toBe("Detergent");

    const feed = await revisionService.listForGroup(houseA.id, { entityType: "ShoppingItem" });
    expect(feed.filter((r) => r.after?.linkedExpenses !== undefined)).toHaveLength(2);
  });
  ```

- [ ] **Step 7: Run it to verify it fails.**
  Run: `npx vitest run src/services/tenant-isolation.test.ts -t "linked-expense count"`
  Expected: FAIL — no revision carries `linkedExpenses` (TypeScript may also flag the 4th argument; fine at this point).

- [ ] **Step 8: Implement the service and route.** In `src/services/shopping-item.service.ts` change the signature to `async replaceExpenseLinks(groupId: number, publicId: string, expensePublicIds: string[], actorId: number | null = null) {` and replace the end of the transaction
  ```ts
        const updated = await tx.shoppingItem.findUniqueOrThrow({
          where: { id: item.id },
          include: itemInclude,
        })
        return serializeItem(updated)
  ```
  with
  ```ts
        const updated = await tx.shoppingItem.findUniqueOrThrow({
          where: { id: item.id },
          include: itemInclude,
        })

        // R2-03: link rows live in ShoppingItemExpense, which Activity › Detailed doesn't list —
        // record the change on the item itself (linked-expense count before → after) so Detailed
        // shows the same event as the Summary. Inside the transaction: the links and their audit
        // row commit or roll back together (EntityRevision is skipped by the audit extension).
        const row: ShoppingItemRow = {
          id: updated.id,
          publicId: updated.publicId,
          groupId: updated.groupId,
          name: updated.name,
          isPurchased: updated.isPurchased,
          createdAt: updated.createdAt,
          addedById: updated.addedById,
        }
        await tx.entityRevision.create({
          data: {
            entityType: 'ShoppingItem',
            entityId: String(row.id),
            groupId: row.groupId,
            action: 'UPDATE',
            actorId,
            before: sanitize({ ...row, linkedExpenses: item._count.expenseLinks }) as Prisma.InputJsonValue,
            after: sanitize({ ...row, linkedExpenses: updated.expenseLinks.length }) as Prisma.InputJsonValue,
          },
        })
        return serializeItem(updated)
  ```
  (`item._count.expenseLinks` is already selected at the top of the transaction.) In `src/app/api/shopping-items/[itemId]/expenses/route.ts` change the call to `shoppingItemService.replaceExpenseLinks(check.groupId, itemId, expenseIds, check.session.userId)`; the `recordActivity` call stays as it is.

- [ ] **Step 9: Run it to verify it passes.**
  Run: `npx vitest run src/services/tenant-isolation.test.ts`
  Expected: PASS (all describes; the existing callers omit `actorId`).

- [ ] **Step 10: Messages.** Inside `"Activity"` → `"act"` add `LINK_SHOPPING_ITEM`, and inside `"Activity"` → `"field"` add `linkedExpenses`:
  - en: `"LINK_SHOPPING_ITEM": "{count, plural, =0 {removed the expense links of an item} one {linked # expense to an item} other {linked # expenses to an item}}"` / `"linkedExpenses": "linked expenses"`
  - pt: `"LINK_SHOPPING_ITEM": "{count, plural, =0 {removeu os vínculos de despesas de um item} one {vinculou # despesa a um item} other {vinculou # despesas a um item}}"` / `"linkedExpenses": "despesas vinculadas"`
  - es: `"LINK_SHOPPING_ITEM": "{count, plural, =0 {quitó los gastos vinculados de un artículo} one {vinculó # gasto a un artículo} other {vinculó # gastos a un artículo}}"` / `"linkedExpenses": "gastos vinculados"`
  - fr: `"LINK_SHOPPING_ITEM": "{count, plural, =0 {a retiré les dépenses liées d'un article} one {a lié # dépense à un article} other {a lié # dépenses à un article}}"` / `"linkedExpenses": "dépenses liées"`

- [ ] **Step 11: Activity page.** In `src/app/(app)/activity/page.tsx`: import `summaryPhrase` next to `formatChangeValue` from `@/lib/activity-format`; in `SummaryFeed`, inside `entries.map((e, i) => {`, after the `changeRows` constant add
  ```tsx
          // R2-03: entries the generic act.<ACTION>_<TYPE> can't describe (expense links) get their own phrase.
          const phrase = summaryPhrase(e);
  ```
  and replace `<span className="text-ink-soft">{actionLabel(e.action, e.entityType)}</span>` with `<span className="text-ink-soft">{phrase ? t(phrase.key, phrase.values) : actionLabel(e.action, e.entityType)}</span>`. In `SNAPSHOT_FIELDS` change `ShoppingItem: ["name", "isPurchased"],` to `ShoppingItem: ["name", "isPurchased", "linkedExpenses"],` (absent from the extension's snapshots, so only link revisions show it — `snapshotFields` skips undefined values).

- [ ] **Step 12: Gates.** `npx tsc --noEmit` clean; `npx eslint src` no new errors; `npm run test` green; i18n parity OK.

- [ ] **Step 13: Loop check for Task 12 (J7, J8):** after linking 1 expense to a purchased item and then unlinking it, Summary shows "linked 1 expense to an item — <item>" and "removed the expense links of an item — <item>" (pt/es/fr equivalents in J8); Detailed › Shopping item lists both with "linked expenses ~~0~~ → 1" and "~~1~~ → 0".

- [ ] **Step 14: Leave changes unstaged** (no commits — the owner commits later on a branch he picks).

---

### Task 10: Activity — R2-09 (before → after everywhere), R2-26, R2-27

- **R2-09 (decision):** do NOT store `before` on more write paths (that would mean `prisma-audit.ts`, owned by the parallel plan, or one bespoke write per route). ADR 0005 already defines an update's "before" as the previous revision's `after`; `revisionService.listForGroup` now fills a missing `before` from that previous revision (same entity, same house, lower id). `DetailedFeed` already renders "~~old~~ → new" whenever `before` exists (Task 5 of phase 2), so house currency changes, item renames and expense edits gain the arrow with no client change; rows already stored benefit too. An update where no shown field changed (join-code regeneration, or the same-currency case pending owner decision R2-08) gets a muted "No visible field changed" line instead of looking identical to its neighbors.
- **R2-26:** "updated the house — BRL": the stored `summary` of a currency change is the currency code. The house is always the active one, so GROUP entries drop the "— …" complement (client-side; fixes stored rows too); the change line below still says "currency: USD → BRL".
- **R2-27:** "Bruno QA created a membership" → "joined the house" (actor is the member), "added a member" (someone else added them), "removed a member" (hard delete). Membership updates keep "updated a membership" and now show "role: ~~Member~~ → Admin" through R2-09.

**Files:**
- Modify: `src/services/revision.service.ts` (`listForGroup`)
- Modify: `src/lib/activity-format.ts` · Test: `src/lib/activity-format.test.ts`
- Modify: `src/app/(app)/activity/page.tsx` (`SummaryFeed.resolvedSummary`, `DetailedFeed`)
- Modify: `src/messages/{en,pt,es,fr}.json` (`Activity.noVisibleChange`, `Activity.phrase.*`)
- Test: `src/services/tenant-isolation.test.ts` (describe `"audit trail / EntityRevision (integration, real pglite DB)"`)

**Interfaces:**
- Produces: `revisionService.listForGroup` — same signature; an `UPDATE` record without a stored `before` now carries the previous revision's `after` as `before` (when one exists in the same house). `listForEntity` is unchanged (the expense History builds its own chain).
- Produces: `export function membershipPhraseKey(r: { entityType: string; action: string; actorId: number | null; after: Record<string, unknown> | null }): string | null` in `src/lib/activity-format.ts` → `"phrase.joinedHouse" | "phrase.addedMember" | "phrase.removedMember" | null`.

- [ ] **Step 1: Write the failing integration test.** Append inside `describe("audit trail / EntityRevision (integration, real pglite DB)", …)`:
  ```ts
  it("listForGroup fills an UPDATE's missing before from the previous revision of the same entity (R2-09)", async () => {
    const g = await prisma.group.create({ data: { publicId: randomUUID(), name: "Chain House" } });
    await prisma.group.update({ where: { id: g.id }, data: { currency: "USD" } });
    await prisma.group.update({ where: { id: g.id }, data: { currency: "EUR" } });
    const item = await prisma.shoppingItem.create({ data: { publicId: randomUUID(), groupId: g.id, name: "Milk" } });
    await prisma.shoppingItem.update({ where: { id: item.id }, data: { name: "Oat milk" } });
    await flushAudit();

    const house = await revisionService.listForGroup(g.id, { entityType: "Group" });
    // Newest first (sorted by id: two updates can share a createdAt): EUR (was USD), then USD (was
    // BRL); the CREATE has nothing before it.
    const houseUpdates = house.filter((r) => r.action === "UPDATE").sort((a, b) => b.id - a.id);
    expect(houseUpdates.map((r) => [r.before?.currency, r.after?.currency]))
      .toEqual([["USD", "EUR"], ["BRL", "USD"]]);
    expect(house.find((r) => r.action === "CREATE")?.before).toBeNull();

    const items = await revisionService.listForGroup(g.id, { entityType: "ShoppingItem" });
    const rename = items.find((r) => r.action === "UPDATE");
    expect(rename?.before?.name).toBe("Milk");
    expect(rename?.after?.name).toBe("Oat milk");
  });
  ```

- [ ] **Step 2: Run it to verify it fails.**
  Run: `npx vitest run src/services/tenant-isolation.test.ts -t "fills an UPDATE"`
  Expected: FAIL — `before` is `null` on both Group updates and on the rename.

- [ ] **Step 3: Implement.** In `src/services/revision.service.ts` add above `export class RevisionService`:
  ```ts
  /**
   * R2-09: the audit extension stores only `after` on an UPDATE — by design its "before" is the
   * previous revision's `after` for the same entity (ADR 0005, history chain). The detailed feed
   * fills it in on read, so Activity › Detailed shows "old → new" for every update (house currency,
   * item rename, expense edits) with no write-path change and for rows already stored. Revisions
   * that carry an explicit `before` (purchase toggle, expense links) are kept as they are. Scoped
   * to the same house: a revision never borrows another tenant's snapshot.
   */
  async function withPreviousState<
    R extends { id: number; entityType: string; entityId: string; action: string; before: unknown }
  >(groupId: number, rows: R[]): Promise<R[]> {
    const missing = rows.filter((r) => r.action === 'UPDATE' && r.before == null)
    if (missing.length === 0) return rows
    const earlier = await prisma.entityRevision.findMany({
      where: {
        groupId,
        OR: missing.map((r) => ({ entityType: r.entityType, entityId: r.entityId, id: { lt: r.id } })),
      },
      orderBy: { id: 'desc' },
      select: { id: true, entityType: true, entityId: true, after: true },
    })
    return rows.map((r) => {
      if (r.action !== 'UPDATE' || r.before != null) return r
      const prev = earlier.find(
        (e) => e.entityType === r.entityType && e.entityId === r.entityId && e.id < r.id && e.after != null
      )
      return prev ? { ...r, before: prev.after } : r
    })
  }
  ```
  and in `listForGroup` (NOT `listForEntity`, which ends with the same two lines — leave those) replace
  ```ts
      const names = await actorNames(rows.map((r) => r.actorId))
      return rows.map((r) => toRecord(r, names))
  ```
  with
  ```ts
      const filled = await withPreviousState(groupId, rows)
      const names = await actorNames(filled.map((r) => r.actorId))
      return filled.map((r) => toRecord(r, names))
  ```
  (`toRecord` still redacts both snapshots, so a borrowed legacy `after` with a join code is stripped too.)

- [ ] **Step 4: Run it to verify it passes.**
  Run: `npx vitest run src/services/tenant-isolation.test.ts`
  Expected: PASS (incl. the read-side redaction test, whose UPDATE has an explicit `before`).

- [ ] **Step 5: Write the failing unit test.** In `src/lib/activity-format.test.ts` add `membershipPhraseKey` to the import and append:
  ```ts
  describe('membershipPhraseKey (R2-27)', () => {
    const rev = (action: string, actorId: number | null, userId: number) =>
      ({ entityType: 'GroupMember', action, actorId, after: action === 'DELETE' ? null : { userId, role: 'MEMBER' } })
    it('a member created by themselves joined the house', () =>
      expect(membershipPhraseKey(rev('CREATE', 7, 7))).toBe('phrase.joinedHouse'))
    it('a member created by someone else was added', () => {
      expect(membershipPhraseKey(rev('CREATE', 1, 7))).toBe('phrase.addedMember')
      expect(membershipPhraseKey(rev('CREATE', null, 7))).toBe('phrase.addedMember')
    })
    it('a deleted membership removed a member', () =>
      expect(membershipPhraseKey(rev('DELETE', 1, 7))).toBe('phrase.removedMember'))
    it('updates and other entities keep the generic phrase', () => {
      expect(membershipPhraseKey(rev('UPDATE', 1, 7))).toBeNull()
      expect(membershipPhraseKey({ entityType: 'Expense', action: 'CREATE', actorId: 1, after: {} })).toBeNull()
    })
  })
  ```

- [ ] **Step 6: Run it to verify it fails.**
  Run: `npx vitest run src/lib/activity-format.test.ts`
  Expected: FAIL — `membershipPhraseKey` is not exported.

- [ ] **Step 7: Implement the helper** (append to `src/lib/activity-format.ts`):
  ```ts
  /**
   * Detailed-feed phrase for a membership revision (R2-27): "joined the house" / "added a member" /
   * "removed a member" instead of the generic "created a membership". null = keep the generic
   * "<action> <entity>" (membership updates read "updated a membership" + role before → after).
   */
  export function membershipPhraseKey(r: {
    entityType: string
    action: string
    actorId: number | null
    after: Record<string, unknown> | null
  }): string | null {
    if (r.entityType !== 'GroupMember') return null
    if (r.action === 'CREATE') {
      return r.actorId !== null && r.after?.userId === r.actorId ? 'phrase.joinedHouse' : 'phrase.addedMember'
    }
    if (r.action === 'DELETE') return 'phrase.removedMember'
    return null
  }
  ```

- [ ] **Step 8: Run it to verify it passes.**
  Run: `npx vitest run src/lib/activity-format.test.ts`
  Expected: PASS.

- [ ] **Step 9: Messages.** Inside `"Activity"` add `"noVisibleChange"` and a `"phrase"` object:
  - en: `"noVisibleChange": "No visible field changed"`, `"phrase": { "joinedHouse": "joined the house", "addedMember": "added a member", "removedMember": "removed a member" }`
  - pt: `"noVisibleChange": "Nenhum campo visível mudou"`, `"phrase": { "joinedHouse": "entrou na casa", "addedMember": "adicionou um membro", "removedMember": "removeu um membro" }`
  - es: `"noVisibleChange": "Ningún campo visible cambió"`, `"phrase": { "joinedHouse": "entró en la casa", "addedMember": "añadió un miembro", "removedMember": "eliminó un miembro" }`
  - fr: `"noVisibleChange": "Aucun champ visible modifié"`, `"phrase": { "joinedHouse": "a rejoint la maison", "addedMember": "a ajouté un membre", "removedMember": "a retiré un membre" }`

- [ ] **Step 10: Activity page.** In `src/app/(app)/activity/page.tsx`:
  - import `membershipPhraseKey` with the other `@/lib/activity-format` helpers.
  - `SummaryFeed.resolvedSummary` — first line of the function:
    ```tsx
    // R2-26: a house update's stored summary is the new currency code ("— BRL" read as the house's
    // name); the house is always the active one and the change line below names the currency.
    if (e.entityType === "GROUP") return "";
    ```
  - `DetailedFeed`, inside `revisions.map((r, i) => {` after the `prev` constant:
    ```tsx
    // R2-27: membership events read as people joining/being added, not "created a membership".
    const phraseKey = membershipPhraseKey(r);
    // R2-09: an update whose shown fields all equal the previous state (e.g. a new join code).
    const unchanged = prev !== null && fields.every((f) => JSON.stringify(prev[f]) === JSON.stringify(snap[f]));
    ```
    replace the two spans after the actor name
    ```tsx
                        <span className="text-ink-soft">{actionLabel(r.action)}</span>{" "}
                        <span className="text-ink">{entityWithArticle(r.entityType)}</span>
    ```
    with
    ```tsx
                        {phraseKey ? (
                          <span className="text-ink-soft">{t(phraseKey)}</span>
                        ) : (
                          <>
                            <span className="text-ink-soft">{actionLabel(r.action)}</span>{" "}
                            <span className="text-ink">{entityWithArticle(r.entityType)}</span>
                          </>
                        )}
    ```
    and right after the `{fields.length > 0 && ( <dl …> … </dl> )}` block add
    ```tsx
                      {unchanged && <p className="mt-1 text-xs text-faint">{t("noVisibleChange")}</p>}
    ```
    Update the comment above `prev` to: `// UPDATEs carry a before (explicit, or the previous revision's after — R2-09) → "old → new".`

- [ ] **Step 11: Gates.** `npx tsc --noEmit` clean; `npx eslint src` no new errors; `npm run test` green; i18n parity OK.

- [ ] **Step 12: Loop checks for Task 12 (J7, J8):** Detailed › House shows "currency ~~BRL~~ → USD" after the USD switch; a code regeneration shows "No visible field changed"; Detailed › Membership reads "joined the house"/"added a member" (no "created a membership"); Summary "updated the house" has no "— BRL" complement.

- [ ] **Step 13: Leave changes unstaged** (no commits — the owner commits later on a branch he picks).

---

### Task 11: Copy and layout polish — R2-10, R2-20, R2-30

- **R2-10:** fr Catalogs shows the default chip "MAISON" (category Home) right above the custom-items section label "MAISON" (`Catalogs.customTitle`) → the section label becomes "De la maison" (pt "Da casa", es "De la casa" already use the preposition). The category itself stays "Maison" (see Won't fix §4).
- **R2-20:** the welcome page is 850px tall on an 844px phone (content + `py-10`) → `py-8` below `md` (16px back).
- **R2-30:** fr orphans ("mois par / mois", "MOT DE / PASSE", "mot de / passe.") → `text-wrap: pretty` (`text-pretty`) on field labels, page subtitles and the password-section hint.

**Files:**
- Modify: `src/messages/fr.json` (`Catalogs.customTitle` value)
- Modify: `src/components/app/Onboarding.tsx` (`<main>`)
- Modify: `src/components/ui/Field.tsx` (`Label`), `src/components/ui/PageHeader.tsx` (subtitle), `src/app/(app)/account/page.tsx` (password hint paragraph)

**Interfaces:** none.

- [ ] **Step 1:** `src/messages/fr.json`: `Catalogs.customTitle` `"Maison"` → `"De la maison"` (only fr changes; parity unaffected).
- [ ] **Step 2:** `Onboarding.tsx`: `<main className="paper-grain relative min-h-dvh px-4 py-10">` → `<main className="paper-grain relative min-h-dvh px-4 py-8 md:py-10">` with `{/* R2-20: py-8 below md — the page was 6px taller than a 390x844 screen. */}` above the language-selector div.
- [ ] **Step 3:** `Field.tsx` `Label`: `className="label-mono block mb-1.5"` → `className="label-mono block mb-1.5 text-pretty"`; `PageHeader.tsx` subtitle `className="mt-1 text-sm text-faint"` → `className="mt-1 text-pretty text-sm text-faint"`; `account/page.tsx` the paragraph rendering `changePasswordHint`/`definePasswordHint` `className="text-sm text-faint"` → `className="text-pretty text-sm text-faint"`. In `Label` add the line `// text-pretty (R2-30): no single-word last line ("MOT DE / PASSE" in fr).` right above its `return`.
- [ ] **Step 4: Gates.** `npx tsc --noEmit` clean; `npx eslint src` no new errors; `npm run test` green; i18n parity OK.
- [ ] **Step 5: Controller live check:** fr at 360: Dépenses subtitle and "Confirmer le nouveau mot de passe" end with ≥ 2 words on the last line; Catalogues shows "DE LA MAISON" under the defaults; welcome page at 390×844 has no vertical scroll (`document.scrollingElement.scrollHeight <= innerHeight`) in EN.
- [ ] **Step 6: Loop checks for Task 12 (J0 celular, J8 fr):** R2-10, R2-20, R2-30.
- [ ] **Step 7: Leave changes unstaged** (no commits — the owner commits later on a branch he picks).

---

### Task 11b: Owner decisions — R2-08, R2-12, R2-17, R2-18

> Added 2026-10-03: the owner chose the four recommended options in "Decided by owner" (standing "faça o recomendado pra tudo"). This task implements exactly those recommendations, nothing more.

**Files:**
- Modify: `src/services/group.service.ts` (`updateCurrency`), `src/app/api/groups/active/currency/route.ts`; test next to the existing group-service / currency-route tests (pglite)
- Modify: `src/messages/{en,pt,es,fr}.json` (R2-12 values, R2-17 values + 3 new keys, R2-18 key removal)
- Modify: `src/app/(app)/expenses/page.tsx` (filter chips → singular keys), `src/components/expenses/ImportCsvModal.tsx` (single platform select → singular key), `src/app/(app)/balances/page.tsx` (remove the stamp)

**Interfaces:** `groupService.updateCurrency(groupId, currency)` → `{ group, previousCurrency, changed: boolean }`.

- [ ] **Step 1 (R2-08, TDD):** failing pglite test first: posting the currency that is already active answers `200 { currency }` and writes no AuditLog row and no Group UPDATE revision; posting a different currency still writes both. Then: `updateCurrency` reads the current value; when equal, returns `{ group: <current row>, previousCurrency, changed: false }` without `prisma.group.update`; the route calls `recordActivity` only when `changed`. No new error code.
- [ ] **Step 2 (R2-12, values only, 4 locales):** inventory every confirmation dialog — each `<Modal>` whose footer has a `variant="danger"` button (account ×2, balances, expenses ×3, house ×3, shopping ×2, TagManager, ExpenseDetailModal, ExpenseFormModal discard) — and apply: (a) its title is a question ending in "?" (e.g. "Delete expense" → "Delete this expense?"; keep `{name}`/`{kind}` placeholders; a key also used as a non-confirmation title must not change — if shared, report NEEDS_CONTEXT instead of adding keys); (b) every destructive confirmation's body ends with the exact irreversibility sentence — en "This action cannot be undone.", pt "Esta ação não pode ser desfeita.", es "Esta acción no se puede deshacer.", fr "Cette action est irréversible." — replacing variants ("It can't be undone.", "This can't be undone.") and appended to the existing body value where absent (Delete item, Clear purchased, Delete category/kind); Make admin is not destructive-irreversible in that sense: keep its own sentence but drop the contraction ("This cannot be undone in the app."); Discard changes keeps no irreversibility line (it discards a draft, not data); (c) one-line hints/helper texts (`*Hint`, `*Helper`, field descriptions) never end with a period; multi-sentence descriptions always do. Values only: no component edits for R2-12. Report the before → after list per key in the report.
- [ ] **Step 3 (R2-17):** `Expenses.categoryLabel`/`platformLabel`/`paymentLabel` → plural in 4 locales (en "Categories"/"Platforms"/"Payment methods"; pt "Categorias"/"Plataformas"/"Formas de pagamento"; es "Categorías"/"Plataformas"/"Métodos de pago"; fr "Catégories"/"Plateformes"/"Moyens de paiement" — keep each locale's current wording, just pluralized). New singular keys `categoryLabelOne`/`platformLabelOne`/`paymentLabelOne` with the current singular values, used where ONE value is shown: the filter chips in `expenses/page.tsx` (`label: t("platformLabel")` etc. → `…One`) and the CSV import's single platform `<Select>` (`ImportCsvModal.tsx:195`). Form, Filters modal, detail TagRows and history field names keep the plural keys.
- [ ] **Step 4 (R2-18):** remove the rotated "ACCOUNT" stamp element from the Balances header (`balances/page.tsx`, the element rendering `t("account")`) and delete `Balances.account` from the 4 locales; drop any import the removal makes unused.
- [ ] **Step 5: Gates.** `npm run test`, `npx tsc --noEmit`, `npx eslint src` (only the pre-existing login error), i18n parity.
- [ ] **Step 6: Controller live check:** same-currency POST → no new Activity entry; Delete expense dialog reads "Delete this expense?" + "This action cannot be undone."; expense form label "CATEGORIES", filter chip "CATEGORY: …"; Balances header without the stamp.
- [ ] **Step 7: Loop checks for Task 12:** j2 step `label:text-is("Category")` → `"Categories"`; R2-08/12/17/18 recorded as implemented.
- [ ] **Step 8: Leave changes unstaged.**

---

### Task 13: Final-review fixes (added 2026-10-04)

> Source: `.superpowers/sdd/2026-10-03-ui-loop-phase-3-round-2-fixes/final-review.md` (opus, whole phase). Runs AFTER round 3 finishes (code changes would hot-reload under the running roteiros), then targeted re-checks. Two sequential sub-tasks (both touch `tenant-isolation.test.ts`/messages).

**13a — Activity rendering (I1, I4, M4, M5)**
- Files: `src/lib/activity-format.ts` (+ test), `src/app/(app)/activity/page.tsx`, `src/messages/{en,pt,es,fr}.json`, `src/services/tenant-isolation.test.ts` (one pglite test for I1).
- [ ] **I1:** `membershipPhraseKey` also handles UPDATE: `after.leftAt != null && before?.leftAt == null` → `actorId === after.userId ? 'phrase.leftHouse' : 'phrase.removedMember'`; `after.leftAt == null && before?.leftAt != null` → `'phrase.joinedHouse'`. When a phrase key applies, DetailedFeed does not render `noVisibleChange`. New `Activity.phrase.leftHouse` ×4 ("left the house" / "saiu da casa" / "salió de la casa" / "a quitté la maison"). Unit tests for the 3 transitions (red first) + 1 pglite test: `removeMember` → the GroupMember revision in `listForGroup` has `before.leftAt === null` and `after.leftAt` set.
- [ ] **I4 (option a):** Expense rows get a `split` pseudo-field built from `participants` (userId + amount): shown as "Name amount · Name amount" (names via the page's existing member-name resolution, amounts via the existing money formatter), compared by sorted `userId:amount` pairs so a reorder is not a change; included in `revisionFields`/`changedFields` so a split-only edit shows `~~old~~ → new` instead of "No visible field changed". New `Activity.field.split` ×4 (match the existing field-label key shape). Unit test: 50/50 → 70/30 is a change; same shares in another order is not.
- [ ] **M5:** Summary change rows where `from === to` are not rendered (legacy pre-R2-08 "BRL → BRL").
- [ ] **M4:** drop the final period of `Household.shareCode`, `Currency.adminOnly`, `Household.noMembers` ×4 (one-line helpers, R2-12 rule c).

**13b — Write paths (I2, I3, M1, M6, M2)**
- Files: `src/services/shopping-item.service.ts`, `src/app/api/shopping-items/[itemId]/expenses/route.ts`, `src/services/tag-service.ts` (+ its caller route for the actor), `src/services/tenant-isolation.test.ts`, new `src/app/api/groups/active/currency/route.test.ts`, new `docs/decisions/0009-derived-before-and-explicit-revisions.md` + `docs/decisions/README.md` index.
- [ ] **I2 (mirror R2-08):** `replaceExpenseLinks` compares the current linked expense ids with the requested set; equal → no delete/create, no revision, returns `{ item, changed: false }`; the route calls `recordActivity` only when `changed`. pglite test: same set twice → one revision + one AuditLog row; `[]` on a never-linked item → none.
- [ ] **I3:** the raw-SQL tag removal (`tag-service.ts:~104`) becomes `UPDATE … WHERE "groupId" = $1 AND $2 = ANY(col) RETURNING *` inside the existing transaction, followed by explicit UPDATE revisions (`tx.entityRevision.createMany`, `before`/`after` through `sanitize`, `actorId` from the session passed down like `togglePurchased`). pglite test: delete a tag used by an expense, then edit the expense → the edit's derived `before` has no phantom category diff.
- [ ] **M1:** move the 3 R2-08 tests out of `tenant-isolation.test.ts` (and its file-wide `vi.mock("@/lib/api-helpers")` if only they need it) into `src/app/api/groups/active/currency/route.test.ts` (pattern: `groups/active/members/[userId]/route.test.ts`; beware the shared pglite instance — Task 11b hit a race with a standalone file, so follow exactly how the members route test sets up its DB).
- [ ] **M6:** assert the first link revision in `listForGroup` keeps its explicit `before.linkedExpenses === 0`.
- [ ] **M2:** ADR 0009 (MADR, append-only): "Activity › Detailed derives `before` on read from the previous revision (same entity, same house); writes the audit extension cannot see (raw SQL, relation-only changes) write an explicit revision, transactional with the write" — context, decision, alternatives rejected (store `before` on every write path; leave gaps), consequences; README index line.

- [ ] **Gates (each sub-task):** `npm run test`, `npx tsc --noEmit`, `npx eslint src`, i18n parity.
- [ ] **Controller re-check (QA):** leave/kick/rejoin read as phrases; split-only edit shows the split diff; "Save" with an unchanged set writes nothing; deleting a used tag then editing the expense shows no phantom diff; spec 003 task 6 and 005 task 8 ticked (M3) once round 3 confirms R2-03/06/07.

---

### Task 12: Round 3 of the loop (verification)

> **Prerequisite (owner):** reconnect the browser runner first — the `pw-edge` Playwright MCP in Edge extension mode. Implementers never start dev servers or browsers; the controller drives the QA server on 127.0.0.1:3100 (DB `homeshare-qa-pg`, 127.0.0.1:55432). Restart `homeshare-qa` before the run (the parallel plan changes `prisma-audit.ts`, and the Prisma client lives on `globalThis`).

- [ ] **Step 1:** `npm run test`, `npx tsc --noEmit`, `npx eslint src` (no new errors; only the pre-existing one in `src/app/auth/login/page.tsx`).

- [ ] **Step 2: Fix the probe defects found in round 2** (`screenshots/loop-2026-09-27/modelo/`):
  - **T5** (`j0-caminho-feliz.js`): the visually-hidden label measured `1014x0` — accept either dimension collapsed:
    ```js
    confere('[T5] rótulo "Currency" do campo não aparece repetido (só para leitor de tela)', !!r && (r.width <= 4 || r.height <= 4), r && `${Math.round(r.width)}x${Math.round(r.height)}`);
    ```
  - **D1** (`j0-caminho-feliz.js`): since D3, `PageHeader` renders a second `<header>` inside `main`, so "last menu trigger under a header" became the Expenses ⋮ menu. Target the app header's trigger that contains the name:
    ```js
    const r = await p.evaluate(() => {
      const u = [...document.querySelector('header').querySelectorAll('button[aria-haspopup="menu"]')].find((b) => /Júlia/.test(b.textContent));
      const s = u && [...u.querySelectorAll('span')].find((x) => x.children.length === 0 && /Júlia/.test(x.textContent));
      return s ? { cortado: s.scrollWidth > s.clientWidth + 1, largura: Math.round(s.getBoundingClientRect().width), title: s.getAttribute('title') || u.getAttribute('title') || '' } : null;
    });
    ```
  - **I11** (`ajudantes.js` + `j2-despesas.js`): the history line reads `edited03/10/2026 18:54` in `innerText` (no space before Task 5), so `\b\d{2}` never matched. In `ajudantes.js`:
    ```js
    const HORA_COMPLETA = /(?<!\d)\d{2}\/\d{2}\/\d{4}[  ]\d{2}:\d{2}(?!\d)/;
    ```
    and inside `medirHorasDoFeed` use the same literal: `const re = /(?<!\d)\d{2}\/\d{2}\/\d{4}[  ]\d{2}:\d{2}(?!\d)/;`. In `j2-despesas.js` replace the `[I11]` line with one that opens the disclosure when needed and reads only the history list:
    ```js
    await seguro('[I11]', async () => {
      const alternar = dialogo().locator('button[aria-expanded]').filter({ hasText: 'History' }).first();
      if ((await alternar.getAttribute('aria-expanded')) !== 'true') { await alternar.click(); await espera(1200); await esperarCarregamento(); }
      confereI11('histórico da despesa', await dialogo().locator('ol').first().innerText());
    });
    ```
  - **jx-smoke**: `confere('fetch do Node disponível no roteiro', typeof fetch === 'function')` tests the runner, not the app (`apiComo` goes through the loop server) → `confere('ctx.request disponível no roteiro', typeof ctx.request?.get === 'function');`.

- [ ] **Step 3: Follow the intentional UI changes in existing steps:**
  - `j0` `[U6]`: From/To are stacked everywhere now and the cut must be measured, not read from the option text:
    ```js
    const m = await p.evaluate(() => {
      const d = [...document.querySelectorAll('[role=dialog]')].pop();
      const de = d.querySelector('#pay-from'), para = d.querySelector('#pay-to');
      const rde = de.getBoundingClientRect(), rpara = para.getBoundingClientRect(), cs = getComputedStyle(para);
      const g = document.createElement('canvas').getContext('2d'); g.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const escolhido = para.options[para.selectedIndex].text;
      return { empilhados: rpara.top > rde.top + 10 && Math.abs(rpara.left - rde.left) < 3, escolhido, textoPx: Math.ceil(g.measureText(escolhido).width), util: Math.floor(para.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) };
    });
    confere('[U6] From/To empilhados em todo tamanho', m.empilhados, JSON.stringify(m));
    confere('[U6] "To" mostra "Júlia Caminho Feliz" sem corte (texto cabe na largura útil)', /Júlia Caminho Feliz/.test(m.escolhido) && m.textoPx <= m.util, JSON.stringify(m));
    ```
  - `j2`: `botao('Delete selected', { exact: true })` → `botao('Delete 2', { exact: true })` (R2-21).
  - `j7` Deferred 2: `/currency USD/` → `/currency (BRL → )?USD/` (R2-09 adds the old value); the Membership check accepts the new phrases: `entradas.every((t) => /\b(joined the house|added a member|removed a member|a membership)\b/.test(t))` (R2-27).

- [ ] **Step 4: Add the round-2 checks** (contract unchanged: `[ID]` prefix, wrapped in `seguro`). Shared helpers for `ajudantes.js`:
  ```js
  // Round 3: elements whose text is cut (scrollWidth beyond the box) among `seletor`.
  const cortados = (seletor) => p.evaluate((seletor) => [...document.querySelectorAll(seletor)].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && e.scrollWidth > e.clientWidth + 1; }).map((e) => e.textContent.trim().slice(0, 40)), seletor);
  // Round 3 (A7, R2-11): visible elements with their own text under 12px.
  const fontesMiudas = () => p.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1 && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()); }).map((e) => ({ t: e.textContent.trim().slice(0, 24), px: parseFloat(getComputedStyle(e).fontSize) })).filter((x) => x.px < 12));
  // Round 3 (R2-06/R2-07): visible boxes of `seletor` shorter than 44px.
  const alvosBaixos = (seletor) => p.evaluate((seletor) => [...document.querySelectorAll(seletor)].map((e) => ({ t: e.textContent.trim().slice(0, 24), h: Math.round(e.getBoundingClientRect().height) })).filter((x) => x.h > 0 && x.h < 44), seletor);
  ```
  | ID | Journey / viewport | Check |
  |---|---|---|
  | R2-01 | J2 celular (list + selection mode), J0 celular360, J8 360 | `cortados('main [role=button][aria-label] .truncate')` is empty; every visible `·` separator inside a card's metadata row has `left ≥` its overflow wrapper's `left` (none starts a line) |
  | R2-02 | J0 celular / celular360 | below-sm names line (`main li p[aria-hidden=true]` next to MARK PAID) not cut and contains "Júlia Caminho Feliz" |
  | R2-03 | J7 (API setup like Deferred 1: create item, toggle, `PUT /api/shopping-items/{id}/expenses` with one expense, then with `[]`) | Summary has "linked 1 expense to an item" and "removed the expense links of an item"; Detailed › Shopping item shows `linked expenses` with `0 → 1` and `1 → 0` |
  | R2-04 | J0 celular360, J8 360 (New expense) | `#exp-date` top ≥ `#exp-amount` bottom (stacked) and, at 390, side by side |
  | R2-05 | J0 desktop, J9 celular (modal open) | fixed overlay `right === innerWidth`; `[U14]` brand x unchanged |
  | R2-06 / R2-07 | J10, J2, J9, J1 celular | `alvosBaixos('[role=menuitem], [role=menuitemradio]')` empty with a menu open; History toggle, Equalize, top Clear filters, template link, auth footer link, brand link ≥ 44px |
  | R2-09 | J7 Detailed › House | an "updated the house" entry has `dd span.line-through` (old currency) |
  | R2-10 | J8 fr Catalogs | custom section label reads "DE LA MAISON" |
  | R2-11, A7 | J0 celular360, J1/J2/J7 celular | `fontesMiudas()` empty on Expenses, Balances, Activity, Filters, drawer, login |
  | R2-13 | J0 celular, J3 celular | Record payment / MARK PAID have a non-transparent `borderTopColor`; MARK PAID right = amount right ±1; House tag/Leave house/⋯ glyph right edges within 2px |
  | R2-14 | J2 desktop By person | one `thead` per visible person card; Date cells' `left` equal across months (±1) |
  | R2-15 | J2 desktop History | the Split row's value container `left` > its label `right` (hanging indent) |
  | R2-16 | J2 desktop custom split | "Matches ✓" visible in both modes at a matching split; Amount-mode TOTAL color = `text-credit` |
  | R2-20 | J0 celular (welcome) | `document.scrollingElement.scrollHeight <= innerHeight` |
  | R2-21 | J2 celular selection mode | counter and delete button each 1 visual line (`linhasDe`) |
  | R2-22 | J2 celular Filters | placeholder width (canvas `measureText`) ≤ input inner width |
  | R2-23 | J2 celular History | each date-time span has 1 visual line |
  | R2-24 | J3 celular | every recorded-payment row shows its date inside the phone names line |
  | R2-25 | J2 celular filter with 0 results | exactly 1 visible "Clear filters" control |
  | R2-26 | J7 Summary | no "updated the house — " entry |
  | R2-27 | J7 Detailed › Membership | no "created a membership" |
  | R2-29 | J8 360 / J3 Balances | no `0%` label next to a positive amount (`<1%` instead) |
  | R2-30 | J8 fr 360 | visual review (last line of the Dépenses subtitle and of the confirm-password label has ≥ 2 words) |
  | R2-31 | J0 celular360 House | `cortados('main li button .text-sm.font-medium')` empty in Your houses |
  | U11 | J3, J5, J6 | `erroSob(id).invalido === 'true'` and the control's `borderTopColor` = `estiloDoToken('border-debt', 'borderTopColor')` |

  Then run `cd screenshots/loop-2026-09-27 && bash reset-qa.sh && python gerar-roteiros.py 3` and run every roteiro in `rodada-3/roteiros/` via `pw-edge`; `python resumo.py 3`.

- [ ] **Step 5: Review.** `python montar-lotes-revisao.py 3`, then parallel reviewers with `rodada-2/revisao/INSTRUCOES-REVISOR.md` (copied to `rodada-3/revisao/`), focused on: every R2 id fixed above, U6/U11/A7, regressions from this phase (Task 1 overlays/menus at every viewport, Task 4 card heights, Task 7 desktop menu density) and the owner-decision items (should look unchanged).

- [ ] **Step 6: Consolidate (same shape as round 2):** `achados.json` gets a `rodada3` field per finding (U6/U11/A7 → "corrigido e conferido" or "não ok"); `rodada-2/achados-r2.json` entries get `"rodada3"` + `"estado"` — fixed ones "corrigido e conferido"/"não confirmado", R2-08/R2-12/R2-17/R2-18 `"decidir"` with the recommendation from "Decided by owner", R2-19/R2-28 `"não corrigir"` with the reason from "Won't fix"; new findings go to `rodada-3/achados-r3.json`; write `rodada-3/RESUMO.md`; regenerate the report (`python gerar-relatorio.py` and `python gerar-relatorio.py --embutido`).
