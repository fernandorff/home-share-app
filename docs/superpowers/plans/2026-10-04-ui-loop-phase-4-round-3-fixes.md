# UI loop — phase 4: round-3 fixes

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** fix the findings of round 3 of the UI-test loop (`screenshots/loop-2026-09-27/rodada-3/achados-r3.json`, R3-01…R3-35: 3 medium — R3-01 list titles cut to 2 lines on phones, so two different expenses look identical in selection mode; R3-02 dateless CSV rows dated tomorrow in the evening; R3-03 login/register field errors only in a banner at the top — and 32 low), apply the owner decisions below, then verify with round 4.

**Architecture:** same as phases 1–3 — surgical fixes in the Next.js monolith; pure helpers in `src/lib` with unit tests, framework-agnostic services with pglite integration tests, thin routes (route tests with the session gate and services faked), presentation-only component changes verified live and by the loop; i18n in 4 locales. No commits (owner commits later on a branch he picks). Four design decisions worth knowing up front:
1. **Dialogs are anchored, not centered** (Task 5): from `sm` up a dialog sits 4.5rem from the top, and the phone sheet stops 4.5rem short of the top. One change in `Modal.tsx` fixes the jump when an error/result grows a dialog (R3-13) and the top toast (16–62px) covering the tallest dialog's title (R3-06).
2. **A join-code regeneration is visible without leaking the code** (Task 6, ADR 0012): the audit extension records a boolean `joinCodeChanged: true` on the Group UPDATE (generic rule: an update whose payload sets a sensitive field records `<field>Changed`, never the value), the regenerate route logs a Summary entry with the same marker, and both tabs read "regenerated the house code" (R3-19).
3. **One Activity vocabulary** (Task 6): Detailed reuses the Summary's `act.<ACTION>_<TYPE>` phrases (Prisma model name → SCREAMING_SNAKE) whenever one exists; verbs become added / updated / removed in both tabs (R3-20).
4. **Auth field errors through a pure helper** (Task 2): `src/lib/auth-form.ts` maps client checks and API codes to a field, rendered by `Field`'s U11 error state; the banner stays for whole-form errors only (R3-03).

No schema change.

**Tech Stack:** Next.js 16 App Router, React 19, Tailwind v4 (CSS-first; `cn()` only joins strings), Radix Dialog/DropdownMenu, next-intl 4 (EN/PT/ES/FR), Prisma 7 + Postgres, Vitest + pglite.

**Spec / inputs:** `screenshots/loop-2026-09-27/rodada-3/achados-r3.json` (R3-01…R3-35, each with onde/achado/causa/correcao/antes), `rodada-3/RESUMO.md` (§5 open doubts), `rodada-3/revisao/achados-lote-{A..Q}.md` · format and loop task from `docs/superpowers/plans/2026-10-03-ui-loop-phase-3-round-2-fixes.md` · `docs/decisions/0005-audit-trail-prisma-extension.md` and `0009-derived-before-and-explicit-revisions.md` (relied on by Task 6).

**Ledger:** `.superpowers/sdd/2026-10-04-ui-loop-phase-4-round-3-fixes/progress.md`.

## Global Constraints

- Build on the CURRENT working tree (many changed/untracked files from phases 1–3), not on HEAD. Never `git stash`, `git checkout --`, or reset those files.
- **Parallel plan — finished.** The observability plan's ledger ends with "OBSERVABILITY PLAN COMPLETE", so its "do not edit" list no longer applies. This supersedes the parallel-plan bullet copied into `.superpowers/sdd/2026-10-04-ui-loop-phase-4-round-3-fixes/global-constraints.md`. The only file of that list this plan touches is `src/lib/prisma-audit.ts` (Task 6: one helper + one line of the update branch) — re-read it right before editing and keep everything there. `src/lib/api-helpers.ts` is NOT edited (Task 6 only calls `recordActivity`).
- English in all code, comments, identifiers and URLs. UI text only through `src/messages/{en,pt,es,fr}.json`: every new key in all 4 files; change values, never keys, of existing messages unless the task says so. Edit by key with the Edit tool — never rewrite or reformat a whole messages file. A non-breaking space in a message value is written as the JSON escape ` ` (valid JSON; next-intl receives U+00A0).
- `cn()` in `src/components/ui/cn.ts` only joins strings (no tailwind-merge): never stack two utilities for the same CSS property under the same variant/breakpoint (`max-h-[…]` + `sm:max-h-[…]` is fine: different variants).
- Money is integer cents (`lib/currency`); DB is `Decimal(10,2)`; API amounts serialize as strings; exact comparisons.
- API errors carry a `code` translated client-side (`useApiError`, namespaces `ApiErrors`/`CsvErrors`). Tenant isolation via `requireActiveGroup`; `groupId` never comes from the body.
- Mobile-first: 44px touch floor below `md` (spec 003 criterion 7); 12px text floor (A7); animations stay behind `prefers-reduced-motion`.
- Gates per task: `npm run test` green, `npx tsc --noEmit` clean, `npx eslint src` with no new errors (1 pre-existing error in `src/app/auth/login/page.tsx`, `react-hooks/set-state-in-effect` on the `?error=` effect — do not fix it).
- i18n parity check (run after every task that touches messages; must print `i18n parity OK`):
  ```bash
  node -e 'const f=o=>Object.entries(o).flatMap(([k,v])=>v&&typeof v==="object"?f(v).map(s=>k+"."+s):[k]);const L=["en","pt","es","fr"].map(l=>new Set(f(require("./src/messages/"+l+".json"))));const all=new Set(L.flatMap(s=>[...s]));const miss=[...all].filter(k=>!L.every(s=>s.has(k)));console.log(miss.length?"MISSING "+miss.join(", "):"i18n parity OK")'
  ```
- **NO commits.** Leave every change unstaged — the owner commits later on a branch he picks.
- NEVER run `npm run build`, `prisma db push`, or anything that reads `.env` / `.env.local` (they point at the PRODUCTION Neon DB). This plan needs no schema change.
- Implementers do not start dev servers or browsers. Visual tasks end with a **Controller live check** that the controller runs on the QA server (127.0.0.1:3100, DB `homeshare-qa-pg` on 127.0.0.1:55432) BEFORE approving the task. Restart `homeshare-qa` after Task 6 (it changes `prisma-audit.ts`; the Prisma client lives on `globalThis`).

## Coverage map

| Finding | Severity | Decision | Where |
|---|---|---|---|
| R3-01 titles cut to 2 lines on phones; identical cards in selection mode; bulk dialog without names | média | owner (applied) | Decided §1 → Task 3 |
| R3-02 dateless CSV row dated tomorrow (+ export file name) | média | fix | Task 1 (import, done) + Task 3 Step 7 (export file name) |
| R3-03 login/register field errors only in the top banner | média | fix | Task 2 |
| R3-04 "PAYER" singular on a multi-choice filter | baixa | fix | Task 3 |
| R3-05 split-sum error only in the footer, far from TOTAL | baixa | fix | Task 4 |
| R3-06 top toast covers "EDIT EXPENSE" | baixa | fix | Task 5 |
| R3-07 "old → new" breaks between a name and its value (history, Summary) | baixa | fix | Task 7 |
| R3-08 sidebar jumps 3–4px when scrolling starts | baixa | fix | Task 10 |
| R3-09 % slider 16px tall | baixa | fix (hit area) | Task 4 (+ Won't fix §1) |
| R3-10 conflict footer ~21% of the screen; Save enabled | baixa | owner (applied) | Decided §3 → Task 4 |
| R3-11 "Dividir igualmente"/"Répartir également" wraps at 360 | baixa | fix | Task 4 |
| R3-12 CSV result/error below the fold, file field not marked | baixa | fix | Task 5 |
| R3-13 centered dialog jumps when content grows | baixa | fix | Task 5 |
| R3-14 Recorded payments: amount/× off the avatar line | baixa | fix | Task 8 |
| R3-15 "Who pays whom" without its dotted rule at 360 | baixa | fix | Task 8 |
| R3-16 text buttons off the block margin (Clear purchased, Clear filters) | baixa | fix | Task 3 |
| R3-17 Catalogs duplicate/delete sentences without subject | baixa | fix | Task 9 |
| R3-18 Catalogs toasts "Added"/"Deleted" without object | baixa | fix | Task 9 |
| R3-19 "Regenerate code" shows as "updated the house · No visible field changed" | baixa | fix | Task 6 (+ Won't fix §2) |
| R3-20 Summary × Detailed use different verbs and entity names | baixa | owner (applied) | Decided §4 → Task 6 |
| R3-21 Detailed ends without the "most recent" notice | baixa | fix | Task 6 |
| R3-22 Summary payments without amount | baixa | fix | Task 6 |
| R3-23 Summary breaks surname/dash at bad points (360) | baixa | fix | Task 6 (helper) + Task 7 |
| R3-24 Detailed value column moves between rows | baixa | fix | Task 7 |
| R3-25 Activity chips are pills in mixed case | baixa | fix | Task 7 |
| R3-26 chip "All" 43px wide | baixa | fix | Task 7 |
| R3-27 fr "devise:" without the space before the colon | baixa | fix | Task 7 |
| R3-28 House members' actions on a 2nd line at 360 | baixa | fix | Task 8 |
| R3-29 identical "C" house avatars in the drawer | baixa | fix | Task 8 |
| R3-30 empty E-mail field without placeholder/"optional" | baixa | fix | Task 11 |
| R3-31 "Settings ▸" submenu opens to the left | baixa | owner (applied) | Decided §5 → Task 10 |
| R3-32 welcome page scrolls ~94px at 360×740 | baixa | owner (applied: no change) | Decided §6 |
| R3-33 R2-12 copy policy leftovers | baixa | owner (applied) | Decided §2 → Tasks 3, 8, 11 |
| R3-34 remaining orphan words | baixa | fix | Tasks 3, 7, 8, 11 (+ Won't fix §3) |
| R3-35 informal pt ("pros", "pra", "deslogado") | baixa | fix | Task 11 |
| RESUMO §5 quick checks (U14 on phones, A10, R2-29 seed, Clear purchased, new category in the form) | — | verify | Task 12 Step 2 |

## Decided by owner

Product calls. The owner's standing instruction is "do the recommended option for everything", so each recommendation below is **applied** by the task named; Task 12 records them in `rodada-3/achados-r3.json` with `"estado": "decidido"` + the recommendation, so round 4 does not re-report them.

1. **R3-01 — revisit U4 (2-line list titles on phones)?** At 360–390px the title column is ~130–200px wide; in selection mode two different expenses ("Jantar personalizado…" R$120 and R$130) read the same, and the bulk dialog names nothing.
   *Recommended (applied, Task 3):* list titles on phones get 3 lines (Expenses and Shopping); in selection mode the per-row ⋯ is hidden (the tap selects; its 56px go to the title); the "Delete selected expenses?" dialog lists the first 3 selected expenses (description · amount · date) plus "and N more". Moving the ⋯ or the amount to the metadata line was not taken: it restructures the card and its R2-01 metadata row for less gain than the third line. The full text stays in the detail view and in the card's `aria-label`.
2. **R3-33 — finish the R2-12 copy policy.**
   *Recommended (applied, Tasks 3, 8, 11):* (a) the irreversibility sentence always closes the dialog body, never the subtitle (Delete this expense?, Delete selected expenses?, Delete this payment? move it); (b) it is stated for actions that destroy data or cannot be undone in the app — Make admin now ends with the standard "This action cannot be undone." (there is no demote in the app); Remove member and Leave house do not carry it (reversible: a new invite brings the person back and the history is kept); Discard changes keeps its own "If you close now, they'll be lost." (a draft, not stored data); (c) single-sentence helpers, list footers, empty states and the 404 text never end with a period ("All bought", "Showing the 50 most recent — search to find older ones", "Showing the 100 most recent changes", "This address doesn't exist or has moved"). Delete this payment? also states its effect: "Who pays whom goes back to how it was before this payment." The loop's `[R2-12]` for Make admin flips to `irreversivel: true` (Task 12 Step 3).
3. **R3-10 (+ RESUMO §5) — edit-conflict footer.** "Save" stays enabled next to "load the latest version to continue", and the footer takes ~180px at 390.
   *Recommended (applied, Task 4):* while the stale-conflict error shows, Save is not offered (it can only fail with the same 409) — "Load latest" becomes the primary button next to Cancel, on one row. "Load latest discards a typed note" stays as it is: loading the other device's version is what the action means.
4. **R3-20 — one Activity vocabulary.**
   *Recommended (applied, Task 6):* added / updated / removed in both tabs, per language (pt adicionou/atualizou/removeu; es añadió/actualizó/eliminó; fr a ajouté/a mis à jour/a supprimé); payments keep "recorded", platforms "renamed", the house "created"; "shopping item" instead of "item" in the Summary; Detailed shows the Summary's phrase for the same event whenever one exists.
5. **R3-31 — "Settings ▸" opens against its arrow** (the user menu sits at the right edge, so the submenu always flips left and starts above its row).
   *Recommended (applied, Task 10):* no submenu — Skin and Language become two labelled sections of the user menu itself (the drawer's Settings panel already shows them that way); `MenuSub` is removed.
6. **R3-32 — must the welcome page fit 360×740 without scrolling?**
   *Recommended (applied: no change):* no. The no-scroll target stays 390×844 (R2-20, passing). Fitting 360×740 needs ~94px (padding, card spacing and shorter hints together) on a screen seen once, before joining a house, where a short scroll to "log out" is harmless; moving "log out" up to the language row collides with the brand in fr ("SE DÉCONNECTER"). The orphan hints on this page are fixed by Task 11 either way.

## Won't fix

1. **R3-09 — a bigger custom slider thumb.** Task 4 gives the range input a 44px hit area below `md`; the native thumb stays. Restyling it needs `::-webkit-slider-thumb`/`::-moz-range-thumb` rules for both skins, for a control that already has a typed % field beside it (U21).
2. **R3-19 — regenerations recorded before Task 6.** They carry no marker and keep "No visible field changed": the code was never stored, so nothing tells them apart from other no-op updates; guessing from "Group UPDATE with nothing visible" would mislabel old same-currency rows (pre-R2-08).
3. **R3-34 — fr "Au moins 8 caractères, avec lettres / et chiffres".** The last line has two words; the R2-30 rule (never a single word) is met.
4. **`Platforms.*` / `Categories.*` single-sentence values with a period (`emptyHint`).** Never rendered: no component reads those namespaces since Catalogs replaced the two pages. A dead-key cleanup, not copy.
5. **R3-06 alternative "dismiss the toast when a dialog opens".** Not needed once dialogs are anchored at 4.5rem (Task 5): the top toast (16–62px) no longer reaches any dialog, and dismissing would also drop confirmations raised while a dialog is open (the CSV import toast).

**Not findings — RESUMO §5 doubts.** Resolved as side effects: Save next to "load the latest version" (Decided §3); the register banner persisting while editing (field errors clear on edit, Task 2); identical stacked "Added" toasts now name the object (Task 9). Moved to Task 12 Step 2 (one run answers them): U14 shift on phones and the desktop house dropdown, A10 `aria-pressed`, R2-29 "<1%" seed, Clear purchased leaving items, a new category in the form's dropdown. Untouched, left for the owner: initial focus on ✕ in destructive dialogs; red primary button after a click (hover residue); merging identical toasts; EQUALIZE looking like a label; 32px chips in the Filters modal; CSV import's CLOSE as primary and "Optional — default: you"; two NEW EXPENSE buttons on the empty state; 81-character names; language selector position (welcome vs auth); avatar color per house; "Your houses" name/tag stacking; the colored dot before "Select…"; es/fr number format and "$"; Balances amounts at different x across cards; Activity's full date on every row, "member Bruno QA", unchanged Detailed fields without an arrow.

## Task order and shared files

Tasks run in order (1 → 11, then the final whole-plan review, then 12). Files touched by more than one task: `src/messages/*.json` (2, 3, 4, 6, 7, 8, 9, 11), `src/app/(app)/activity/page.tsx` (6, 7), `src/lib/activity-format.ts` + test (6; 7 only imports from it), `src/app/(app)/shopping/page.tsx` (3, 11), `src/app/(app)/house/page.tsx` (8, 11), `src/app/(app)/expenses/page.tsx` (3), `src/components/expenses/ExpenseDetailModal.tsx` (7), `src/components/ui/Menu.tsx` (10). Search by content — line numbers drift.

---

### Task 1: CSV rows without a date get the importer's LOCAL today (R3, medium, functional)

**Finding (round 3, lot O, O1):** a CSV row with no date is saved with tomorrow's date in the evening (Brazil, UTC−3): the import runs on the server (`expenseService.importFromCsv` → `parseCSVDetailed`), and `src/lib/csv-parser.ts:127` defaults to `new Date().toISOString().split('T')[0]` — the server's UTC date (Vercel runs in UTC). The server cannot know the user's local day, so the browser must send it.

**Files:**
- Modify: `src/lib/csv-parser.ts` (`parseCSVDetailed(csvText, options?: { defaultDate?: string })`; default stays the UTC date when no option is given)
- Modify: `src/services/expense.service.ts` (`importFromCsv` takes and forwards `defaultDate`)
- Modify: `src/app/api/expenses/import/route.ts` (read `defaultDate` from the form data and from the JSON body; validate)
- Modify: `src/components/expenses/ImportCsvModal.tsx` (`form.append("defaultDate", todayInputValue())` — `todayInputValue` from `@/lib/format` is the browser's local YYYY-MM-DD)
- Test: the existing csv-parser test file + the closest existing import route/service test

- [ ] **Step 1 (red):** csv-parser unit tests — a row without a date uses `options.defaultDate` when given; without the option it still uses today's UTC date (current behavior); a row WITH a date ignores `defaultDate`.
- [ ] **Step 2:** implement the option in `parseCSVDetailed` (`parseCSV` keeps its signature).
- [ ] **Step 3 (red → green):** route validation helper (pure, unit-tested): accept `defaultDate` only if it matches `^\d{4}-\d{2}-\d{2}$`, is a real calendar date, and is within ±1 day of the server's UTC date (time zones span UTC−12..+14, so a real local "today" is never further); otherwise ignore it (fall back to the UTC default) — no new error code, imports never fail because of this field.
- [ ] **Step 4:** route reads it (FormData `defaultDate` and JSON `body.defaultDate`), service forwards it, modal sends it. Comment in the route explaining why the browser's date is needed (server runs in UTC).
- [ ] **Step 5: Gates.** `npm run test`, `npx tsc --noEmit`, `npx eslint src`, i18n parity (no new keys expected).
- [ ] **Step 6: Controller live check (QA):** import a CSV with a dateless row after 21:00 local (or by sending a `defaultDate` one day off the UTC date) → the row gets the local date; a garbage `defaultDate` falls back without error.

---

### Task 2: Login and register — field errors under the field (R3-03)

**Finding (lots A1, J1):** login and register show every error as a pink banner at the top of the card; the field it belongs to gets no red border, no message under it and no `aria-invalid` (U11 covers every other form). "Please fill in all fields" doesn't say which; a short password repeats in red at the top the hint already under the field (twice on screen); "This password is too common…" and "This username is already taken" sit 120–250px away from their field — with the phone keyboard open the banner can be off screen. For wrong credentials the generic banner is right.

**Fix:** a pure helper classifies each error: client-side checks and the API codes that belong to one field go under that field (`Field` already paints the debt border, sets `aria-invalid` and renders the message with `role="alert"`), and the first invalid field gets focus; the banner stays for whole-form errors (wrong credentials, rate limit, Google, network). A field's error clears as soon as it is edited (this also answers the RESUMO doubt "the previous banner stays while editing"). Errors are stored as keys / API errors, never as translated text, so a language switch re-translates them (I2). The short-username and short-password messages ARE the field's hint — `Field` shows the error instead of the hint, so the text appears once, in red.

**Files:**
- Create: `src/lib/auth-form.ts` · Create test: `src/lib/auth-form.test.ts`
- Modify: `src/app/auth/login/page.tsx`, `src/app/auth/register/page.tsx`
- Modify: `src/messages/{en,pt,es,fr}.json` (`Auth.fieldRequired` added; `Auth.fieldsRequired` removed — its only two callers go away)

**Interfaces:**
- Produces in `src/lib/auth-form.ts`: `export type AuthField = "name" | "username" | "password"`; `export type AuthFieldKeys = Partial<Record<AuthField, string>>` (values are `Auth` message keys); `export function authErrorField(code: string | undefined): AuthField | null`; `export function validateLogin(v: { username: string; password: string }): AuthFieldKeys`; `export function validateRegister(v: { name: string; username: string; password: string }): AuthFieldKeys`; `export function firstErrorField(order: readonly AuthField[], errors: Partial<Record<AuthField, unknown>>): AuthField | null`.

- [ ] **Step 1: Write the failing test.** Create `src/lib/auth-form.test.ts`:
  ```ts
  import { describe, it, expect } from "vitest";
  import { authErrorField, firstErrorField, validateLogin, validateRegister } from "./auth-form";

  describe("authErrorField (R3-03)", () => {
    it("routes a field's API codes to that field", () => {
      expect(authErrorField("MISSING_USERNAME")).toBe("username");
      expect(authErrorField("INVALID_USERNAME")).toBe("username");
      expect(authErrorField("USERNAME_TAKEN")).toBe("username");
      expect(authErrorField("INVALID_PASSWORD")).toBe("password");
      expect(authErrorField("PASSWORD_TOO_COMMON")).toBe("password");
      expect(authErrorField("PASSWORD_NO_COMPLEXITY")).toBe("password");
      expect(authErrorField("INVALID_NAME")).toBe("name");
    });
    it("keeps whole-form errors in the banner", () => {
      for (const code of ["INVALID_CREDENTIALS", "RATE_LIMITED", "USE_GOOGLE", "SOMETHING_ELSE", undefined]) {
        expect(authErrorField(code)).toBeNull();
      }
    });
  });

  describe("validateLogin (R3-03)", () => {
    it("marks every empty field as required", () =>
      expect(validateLogin({ username: " ", password: "" })).toEqual({ username: "fieldRequired", password: "fieldRequired" }));
    it("passes filled fields", () => expect(validateLogin({ username: "ana", password: "x" })).toEqual({}));
  });

  describe("validateRegister (R3-03)", () => {
    it("empty first, then each field's own rule — its hint", () => {
      expect(validateRegister({ name: "", username: "", password: "" }))
        .toEqual({ name: "fieldRequired", username: "fieldRequired", password: "fieldRequired" });
      expect(validateRegister({ name: "Ana", username: "an", password: "short1" }))
        .toEqual({ username: "usernameHint", password: "passwordHint" });
      expect(validateRegister({ name: "Ana", username: "ana", password: "longenough1" })).toEqual({});
    });
  });

  describe("firstErrorField (R3-03)", () => {
    it("follows the form's order", () =>
      expect(firstErrorField(["name", "username", "password"], { password: 1, username: 1 })).toBe("username"));
    it("is null without errors", () => expect(firstErrorField(["name"], {})).toBeNull());
  });
  ```

- [ ] **Step 2: Run it to verify it fails.**
  Run: `npx vitest run src/lib/auth-form.test.ts`
  Expected: FAIL — cannot resolve `./auth-form`.

- [ ] **Step 3: Implement.** Create `src/lib/auth-form.ts`:
  ```ts
  // R3-03: login and register put an error that belongs to one field under that field (U11: debt
  // border, aria-invalid, message below — Field does all three) and keep the banner at the top for
  // whole-form errors only (wrong credentials, rate limit, Google sign-in, network).

  export type AuthField = "name" | "username" | "password";

  /** Field-level messages as `Auth` translation keys. */
  export type AuthFieldKeys = Partial<Record<AuthField, string>>;

  const FIELD_BY_CODE: Record<string, AuthField> = {
    INVALID_NAME: "name",
    MISSING_USERNAME: "username",
    INVALID_USERNAME: "username",
    USERNAME_TAKEN: "username",
    INVALID_PASSWORD: "password",
    PASSWORD_TOO_COMMON: "password",
    PASSWORD_NO_COMPLEXITY: "password",
  };

  /** The field an API error code belongs to; null = the whole form (banner). */
  export function authErrorField(code: string | undefined): AuthField | null {
    return (code && FIELD_BY_CODE[code]) || null;
  }

  /** Checks before POST /api/auth/login: every empty field is required. */
  export function validateLogin(v: { username: string; password: string }): AuthFieldKeys {
    const errors: AuthFieldKeys = {};
    if (!v.username.trim()) errors.username = "fieldRequired";
    if (!v.password) errors.password = "fieldRequired";
    return errors;
  }

  /** Checks before POST /api/auth/register — empty first, then the field's own rule. The rule's
   *  message is the field's hint, shown in red in its place (Field renders the error instead of the
   *  hint), so it is no longer repeated in a banner. */
  export function validateRegister(v: { name: string; username: string; password: string }): AuthFieldKeys {
    const errors: AuthFieldKeys = {};
    if (!v.name.trim()) errors.name = "fieldRequired";
    if (!v.username.trim()) errors.username = "fieldRequired";
    else if (v.username.trim().length < 3) errors.username = "usernameHint";
    if (!v.password) errors.password = "fieldRequired";
    else if (v.password.length < 8) errors.password = "passwordHint";
    return errors;
  }

  /** The first field, in form order, that has an error — it receives focus. */
  export function firstErrorField(
    order: readonly AuthField[],
    errors: Partial<Record<AuthField, unknown>>
  ): AuthField | null {
    return order.find((f) => errors[f] !== undefined) ?? null;
  }
  ```

- [ ] **Step 4: Run it to verify it passes.**
  Run: `npx vitest run src/lib/auth-form.test.ts`
  Expected: PASS (7 tests).

- [ ] **Step 5: Login page.** In `src/app/auth/login/page.tsx`:
  - imports: `import { api } from "@/lib/api";` → `import { api, ApiError } from "@/lib/api";` and add `import { authErrorField, firstErrorField, validateLogin, type AuthField } from "@/lib/auth-form";`.
  - below `CODE_TO_KEY` add:
    ```tsx
    type ErrorRef = { key: string } | { api: unknown; fallbackKey: string };
    const LOGIN_FIELDS: readonly AuthField[] = ["username", "password"];
    ```
  - replace the `error` state line `const [error, setError] = useState<{ key: string } | { api: unknown; fallbackKey: string } | null>(null);` with:
    ```tsx
    const [error, setError] = useState<ErrorRef | null>(null);
    // R3-03: an error that belongs to one field renders under it (Field: debt border, aria-invalid,
    // message) and that field gets focus; the banner stays for whole-form errors. Stored as keys /
    // API errors too, so a language switch re-translates them (I2).
    const [fieldErrors, setFieldErrors] = useState<Partial<Record<AuthField, ErrorRef>>>({});
    const message = (e: ErrorRef) => ("key" in e ? t(e.key) : apiErr(e.api, t(e.fallbackKey)));
    function showFieldErrors(errors: Partial<Record<AuthField, ErrorRef>>) {
      setFieldErrors(errors);
      const first = firstErrorField(LOGIN_FIELDS, errors);
      if (first) document.getElementById(first)?.focus();
    }
    function clearFieldError(field: AuthField) {
      if (fieldErrors[field]) setFieldErrors((prev) => ({ ...prev, [field]: undefined }));
    }
    ```
    (keep the I2 comment above it and the `?error=` `useEffect` exactly as it is — it carries the pre-existing lint error.)
  - replace the body of `onSubmit` from `setError(null);` to the end of the `catch` with:
    ```tsx
    setError(null);
    setFieldErrors({});
    const u = username.trim().toLowerCase();

    // Validated here (not via `required`) so the message is a styled inline error in the UI's
    // chosen language, not the browser's native validation bubble (renders in the browser/OS
    // locale regardless of the app's language — U1).
    const invalid = validateLogin({ username: u, password });
    if (Object.keys(invalid).length > 0) {
      const refs: Partial<Record<AuthField, ErrorRef>> = {};
      for (const [field, key] of Object.entries(invalid) as [AuthField, string][]) refs[field] = { key };
      showFieldErrors(refs);
      return;
    }

    setLoading(true);
    try {
      await api.post("/api/auth/login", { username: u, password });
      router.replace("/");
    } catch (err) {
      const field = authErrorField(err instanceof ApiError ? err.code : undefined);
      if (field) showFieldErrors({ [field]: { api: err, fallbackKey: "errorLogin" } });
      else setError({ api: err, fallbackKey: "errorLogin" });
      setLoading(false);
    }
    ```
  - banner content: `{"key" in error ? t(error.key) : apiErr(error.api, t(error.fallbackKey))}` → `{message(error)}`.
  - `<Field label={t("username")} htmlFor="username">` → `<Field label={t("username")} htmlFor="username" error={fieldErrors.username && message(fieldErrors.username)}>` and its Input `onChange={(e) => setUsername(e.target.value)}` → `onChange={(e) => { setUsername(e.target.value); clearFieldError("username"); }}`; same for the password Field (`error={fieldErrors.password && message(fieldErrors.password)}`, `onChange={(e) => { setPassword(e.target.value); clearFieldError("password"); }}`).

- [ ] **Step 6: Register page.** In `src/app/auth/register/page.tsx`, the same pattern:
  - imports as in Step 5 but with `validateRegister` instead of `validateLogin`; `type ErrorRef` as above and `const REGISTER_FIELDS: readonly AuthField[] = ["name", "username", "password"];` above the component.
  - the same state block (with `REGISTER_FIELDS` in `showFieldErrors`).
  - `onSubmit`: replace the three `if (…) { setError({ key: … }); return; }` checks with
    ```tsx
    // Validated here (not via required/minLength) so the message is a styled inline error in the
    // UI's chosen language, not the browser's native validation bubble (U1). R3-03: under the field.
    const invalid = validateRegister({ name, username, password });
    if (Object.keys(invalid).length > 0) {
      const refs: Partial<Record<AuthField, ErrorRef>> = {};
      for (const [field, key] of Object.entries(invalid) as [AuthField, string][]) refs[field] = { key };
      showFieldErrors(refs);
      return;
    }
    ```
    keep `setError(null);` and add `setFieldErrors({});` right after it; in the `catch`, the same `authErrorField` routing as login with `fallbackKey: "errorRegister"`.
  - banner content → `{message(error)}`; the three Fields get `error={fieldErrors.<field> && message(fieldErrors.<field>)}` (username and password keep their `hint`) and their `onChange` calls `clearFieldError("<field>")` after the existing setter (the username one keeps its scrubbing expression).

- [ ] **Step 7: Messages.** In `"Auth"` delete `"fieldsRequired"` and add `"fieldRequired"`: en `"Required"`, pt `"Obrigatório"`, es `"Obligatorio"`, fr `"Obligatoire"`.

- [ ] **Step 8: Gates.** `npm run test`, `npx tsc --noEmit`, `npx eslint src` (only the pre-existing login error), i18n parity OK.

- [ ] **Step 9: Controller live check** (1440 and 390, en + fr): empty login → both fields red with "Required" under each, focus in Username, no banner; wrong password → banner "Wrong username or password", no field red; register with `an` / `short1` → the hints under Username and Password turn red (each text once on screen); `password1` → "This password is too common…" under Password; an existing username → under Username; typing in a red field clears its error; switching the language with an error showing re-translates it.

- [ ] **Step 10: Loop checks for Task 12 (J1 desktop + celular):** R3-03 (table in Task 12).

- [ ] **Step 11: Leave changes unstaged** (no commits — the owner commits later on a branch he picks).

---

### Task 3: Expenses and Shopping lists — R3-01, R3-04, R3-16, R3-33 (expense dialogs), R3-02 (export file name)

- **R3-01 (Decided §1):** phone cards: 3-line titles, no ⋯ while selecting, bulk dialog names the expenses. Shopping item names: 3 lines.
- **R3-04:** the Filters modal labels its multi-choice payer chips with the column's singular `colPayer` → new plural key `payersLabel` (the applied-filter chip "Payer: Ana" keeps the singular).
- **R3-16:** "Clear purchased" is a ghost button whose 12px padding ends the text 12px before the card edge → `secondary` (bordered: the R2-13 rule for text buttons next to a section's edge); "Clear filters" starts 8px in from the chips/summary bar → `-ml-2` cancels its `px-2`.
- **R3-33 §2(a):** the two expense delete dialogs carry "This action cannot be undone." as the subtitle → it closes the body.
- **R3-02 remainder:** the export file name still uses the server's UTC date ("despesas-casa-2026-10-04.csv" at 22:41 on 03/10) → the menu sends the browser's local day and the route validates it with Task 1's `sanitizeDefaultDate`.

**Files:**
- Modify: `src/app/(app)/expenses/page.tsx` (`ExpenseCard`, bulk/single delete modals, filters row, export menu item)
- Modify: `src/components/expenses/ExpenseFiltersModal.tsx` (payer Field label)
- Modify: `src/app/(app)/shopping/page.tsx` (Clear purchased button, `ItemRow` name)
- Modify: `src/app/api/expenses/export/route.ts` · Create test: `src/app/api/expenses/export/route.test.ts`
- Modify: `src/messages/{en,pt,es,fr}.json` (`Expenses.payersLabel`, `Expenses.bulkDeleteMore`)

**Interfaces:** `GET /api/expenses/export?date=YYYY-MM-DD` — `date` optional; used for the file name only when `sanitizeDefaultDate` accepts it, else the UTC date (unchanged behavior).

- [ ] **Step 1 (R3-01): phone card.** In `ExpenseCard` replace
  ```tsx
            {/* U4: up to 2 lines before ellipsis (was 1, cutting most descriptions to ~15-24 chars). */}
            <span className="line-clamp-2 break-words text-sm font-medium text-ink">{e.description}</span>
  ```
  with
  ```tsx
            {/* U4 → R3-01: up to 3 lines before the ellipsis (was 2). At 360-390px the title column is
                ~130-200px wide and 2 lines made different expenses look identical, right when choosing
                what to delete. The full text is in the detail view and in the card's aria-label.
                text-pretty (R3-34): no single word alone on the last line. */}
            <span className="line-clamp-3 break-words text-pretty text-sm font-medium text-ink">{e.description}</span>
  ```
  and replace
  ```tsx
        <div className="shrink-0">
          <RowMenu onEdit={handleEdit} onDelete={handleDelete} />
        </div>
  ```
  with
  ```tsx
        {/* R3-01: no per-row menu while selecting — the tap toggles the checkbox, and the 56px the ⋯
            took go to the title. */}
        {!selectionMode && (
          <div className="shrink-0">
            <RowMenu onEdit={handleEdit} onDelete={handleDelete} />
          </div>
        )}
  ```

- [ ] **Step 2 (R3-01 + R3-33): delete dialogs.** After `const selectedCount = selected.size;` add
  ```tsx
  // R3-01: the bulk-delete dialog names what it is about to delete (first 3 + "and N more").
  const selectedExpenses = listState.items.filter((e) => selected.has(e.publicId));
  ```
  In the single-delete `<Modal>` delete the line `description={t("deleteUndoNote")}` and replace its body paragraph with
  ```tsx
        <p className="text-sm text-ink">
          {t.rich("deletePrompt", {
            name: deleteTarget?.description ?? "",
            strong: (chunks) => <span className="font-display font-bold">{chunks}</span>,
          })}{" "}
          {/* R3-33: the irreversibility sentence closes the body, as in every other confirmation (was the subtitle). */}
          {t("deleteUndoNote")}
        </p>
  ```
  In the bulk `<Modal>` delete `description={t("deleteUndoNote")}` and replace `<p className="text-sm text-ink">{t("bulkDeletePrompt", { count: selectedCount })}</p>` with
  ```tsx
        <p className="text-sm text-ink">
          {t("bulkDeletePrompt", { count: selectedCount })} {t("deleteUndoNote")}
        </p>
        {/* R3-01: two cards cut to the same lines are told apart here — description, amount, date. */}
        {selectedExpenses.length > 0 && (
          <ul className="mt-3 flex flex-col gap-1.5 rounded-md border border-dashed border-rule bg-panel/40 p-3">
            {selectedExpenses.slice(0, 3).map((e) => (
              <li key={e.publicId} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 break-words text-ink">{e.description}</span>
                <span className="shrink-0 whitespace-nowrap text-xs text-faint tnum">
                  <Money value={e.amount} className="text-ink-soft" /> · {formatDateLocale(e.date)}
                </span>
              </li>
            ))}
          </ul>
        )}
        {selectedExpenses.length > 3 && (
          <p className="mt-1.5 text-xs text-faint">{t("bulkDeleteMore", { count: selectedExpenses.length - 3 })}</p>
        )}
  ```

- [ ] **Step 3 (R3-04).** In `ExpenseFiltersModal.tsx` replace `<Field label={t("colPayer")}>` with
  ```tsx
        {/* R3-04: plural like Platforms/Categories/Payment methods below — several payers can be picked. */}
        <Field label={t("payersLabel")}>
  ```

- [ ] **Step 4 (R3-16).** In `expenses/page.tsx`, the top "Clear filters" button class `"label-mono inline-flex min-h-11 shrink-0 items-center rounded-md px-2 py-1.5 text-stamp-text …"` → `"label-mono -ml-2 inline-flex min-h-11 shrink-0 items-center rounded-md px-2 py-1.5 text-stamp-text …"` (rest unchanged), with `{/* R3-16: -ml-2 cancels px-2, so the text starts on the edge of the chips' second row and the summary bar. */}` added under the R2-25 comment. In `shopping/page.tsx`, the Purchased section's `<Button variant="ghost" size="sm" loading={clearingPurchased} …>` → `variant="secondary"`, with `{/* R3-16: bordered like R2-13's text buttons — its edge sits on the cards' edge (ghost padding ended the text 12px short). */}` above `<SectionTitle`.

- [ ] **Step 5 (R3-01): Shopping names.** In `ItemRow` replace
  ```tsx
              // U4: up to 2 lines before ellipsis (was 1, cutting most item names short).
              "line-clamp-2 break-words text-sm",
  ```
  with
  ```tsx
              // U4 → R3-01: up to 3 lines before the ellipsis (was 2) — same rule as the expense cards.
              "line-clamp-3 break-words text-pretty text-sm",
  ```

- [ ] **Step 6: Messages.** Inside `"Expenses"` add `payersLabel` and `bulkDeleteMore`:
  - en `"payersLabel": "Payers"`, `"bulkDeleteMore": "and {count} more"`
  - pt `"payersLabel": "Pagadores"`, `"bulkDeleteMore": "e mais {count}"`
  - es `"payersLabel": "Pagadores"`, `"bulkDeleteMore": "y {count} más"`
  - fr `"payersLabel": "Payeurs"`, `"bulkDeleteMore": "et {count} de plus"`

- [ ] **Step 7 (R3-02 remainder, TDD): export file name.** Create `src/app/api/expenses/export/route.test.ts` (same faking pattern as `src/app/api/expenses/import/route.test.ts`):
  ```ts
  import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

  const { mockRequireActiveGroup, mockExportToCSV } = vi.hoisted(() => ({
    mockRequireActiveGroup: vi.fn(),
    mockExportToCSV: vi.fn(),
  }));
  vi.mock("@/lib/api-helpers", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/api-helpers")>();
    return { ...actual, requireActiveGroup: mockRequireActiveGroup };
  });
  vi.mock("@/services/expense.service", () => ({ expenseService: { exportToCSV: mockExportToCSV } }));

  import { GET } from "./route";

  // 01:30 UTC on Oct 4 — still Oct 3 (22:30) for someone exporting in Brazil.
  const SERVER_NOW = new Date("2026-10-04T01:30:00Z");
  const fileName = (res: Response) => res.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1];
  const exportAt = (query = "") => GET(new Request(`http://localhost/api/expenses/export${query}`));

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SERVER_NOW);
    mockRequireActiveGroup.mockResolvedValue({ ok: true, session: { userId: 1 }, groupId: 7, role: "MEMBER" });
    mockExportToCSV.mockResolvedValue("description,amount\n");
  });
  afterEach(() => vi.useRealTimers());

  describe("GET /api/expenses/export — file name date (R3-02)", () => {
    it("uses the browser's local day", async () => {
      expect(fileName(await exportAt("?date=2026-10-03"))).toBe("despesas-casa-2026-10-03.csv");
    });
    it("falls back to the UTC day when the date is missing or implausible", async () => {
      expect(fileName(await exportAt())).toBe("despesas-casa-2026-10-04.csv");
      expect(fileName(await exportAt("?date=2026-09-01"))).toBe("despesas-casa-2026-10-04.csv");
      expect(fileName(await exportAt("?date=garbage"))).toBe("despesas-casa-2026-10-04.csv");
    });
  });
  ```
  Run `npx vitest run src/app/api/expenses/export/route.test.ts` → FAIL (the first case gets 2026-10-04). Then in `route.ts`: `export async function GET() {` → `export async function GET(request: Request) {`, add `import { sanitizeDefaultDate } from '@/lib/csv-parser'` and replace the `filename` line with
  ```ts
      // R3-02: the server runs in UTC, so in the evening its "today" is already tomorrow in Brazil —
      // the browser sends its local day (?date=), accepted only within ±1 day of UTC (Task 1's rule).
      const day = sanitizeDefaultDate(new URL(request.url).searchParams.get('date')) ?? new Date().toISOString().split('T')[0]
      const filename = `despesas-casa-${day}.csv`
  ```
  Re-run → PASS. In `expenses/page.tsx`: `import { money } from "@/lib/format";` → `import { money, todayInputValue } from "@/lib/format";` and the Export CSV item becomes
  ```tsx
              <MenuItem onSelect={() => { window.location.href = `/api/expenses/export?date=${todayInputValue()}`; }}>
  ```
  with `R3-02: the browser's local day names the file.` appended to the R2-07 comment above it.

- [ ] **Step 8: Gates.** `npm run test`, `npx tsc --noEmit`, `npx eslint src`, i18n parity OK.

- [ ] **Step 9: Controller live check (390, 360, 1440):** long descriptions show 3 lines on phone cards; selection mode shows no ⋯ in cards and wider titles; select the two "Jantar personalizado" → the dialog lists both with R$120.00 and R$130.00, no subtitle, body ends "This action cannot be undone."; Filters label "PAYERS"; "Clear filters" text starts at the chips' left edge (x=16 at 390); Shopping "CLEAR PURCHASED" bordered, right edge = card edge; Export CSV after 21:00 local (or with the system clock past UTC midnight) downloads `despesas-casa-<local day>.csv`; desktop table unchanged.

- [ ] **Step 10: Loop checks for Task 12 (J2 celular + desktop, J4, J0 notebook, J8 360, J9):** R3-01, R3-02 (export), R3-04, R3-16, R3-33 (expense dialogs).

- [ ] **Step 11: Leave changes unstaged** (no commits — the owner commits later on a branch he picks).

---

### Task 4: Expense form — R3-05, R3-09, R3-10, R3-11

- **R3-05:** a wrong custom split shows "Over by R$25.00"/"Missing R$20.00" only in the footer (12px, far from TOTAL), while "Matches ✓" appears right under TOTAL → the reason also appears under TOTAL; the footer keeps it (visible when the list is scrolled — round-1 fix #3).
- **R3-09:** the % slider is 16px tall → 44px hit area below `md` (24px from `md`); the native track stays thin and centered.
- **R3-10 (Decided §3):** stale conflict → Cancel + Load latest on one row, no Save.
- **R3-11:** "DIVIDIR IGUALMENTE"/"RÉPARTIR ÉGALEMENT" wrap at 360 inside the segmented control → shorter pt/fr labels in the same style as es "Partes iguales".

**Files:**
- Modify: `src/components/expenses/ExpenseFormModal.tsx`
- Modify: `src/messages/pt.json`, `src/messages/fr.json` (`Expenses.splitEqually` values)

**Interfaces:** none.

- [ ] **Step 1 (R3-05): the reason as one node.** Right after the `const customMismatch = …;` line add
  ```tsx
  // R3-05: the reason as a node — shown under TOTAL (next to the numbers it explains) and repeated in
  // the always-visible footer (round-1 fix #3: still readable when the member list is scrolled).
  const mismatchReason = !customMismatch
    ? null
    : customMode === "amount"
    ? diffCents > 0
      ? <>{t("missing")} <Money value={fromCents(diffCents)} className="text-debt" /></>
      : <>{t("over")} <Money value={fromCents(-diffCents)} className="text-debt" /></>
    : totalPct < 100
    ? t("percentMissing", { pct: 100 - totalPct })
    : t("percentOver", { pct: totalPct - 100 });
  ```
  In the `customMismatch ? (…)` footer branch replace the whole `<p className="text-xs text-debt">{customMode === "amount" ? (…) : …}</p>` with `<p className="text-xs text-debt">{mismatchReason}</p>`. In the Amount block, replace the two-line comment that starts `{/* The "missing"/"over" reason lives in the modal footer (always visible) — see` with
  ```tsx
                  {/* R3-05: the reason sits right under TOTAL, where "Matches ✓" appears (the footer repeats it). */}
                  {customMismatch && <p className="text-xs text-debt">{mismatchReason}</p>}
  ```
  (the `(amountMatches || totalCents <= 0) && …` paragraph below it stays). In the % block, replace the two-line comment that starts `{/* Round-1 fix #3: the missing/over reason now lives in the modal footer (always` with the same two lines.

- [ ] **Step 2 (R3-09).** The range input's `className="w-full accent-ink"` → `className="h-11 w-full cursor-pointer accent-ink md:h-6"`, with `{/* R3-09: 44px hit area below md (24px from md) — the native track stays thin and centered. */}` above the `<input type="range"`.

- [ ] **Step 3 (R3-10): conflict footer.** In the `formError ? (…)` footer branch replace everything from the comment `{/* Always stacked: Load latest full-width on top, Cancel + Save right-aligned below.` to the closing `</div>` of `<div className="flex flex-col gap-2">` with
  ```tsx
              {/* R3-10: in the stale-conflict state Save is not offered (it can only fail with the same
                  409 until the latest version is loaded) — Load latest takes its place next to Cancel,
                  one row instead of two (the footer took ~21% of a 390px screen). flex-wrap: the fr
                  label is long. */}
              <div className="flex flex-wrap justify-end gap-2">
                {staleError ? (
                  <>
                    <Button variant="ghost" onClick={requestClose}>
                      {tc("cancel")}
                    </Button>
                    <Button type="button" id="exp-load-latest" loading={loadingLatest} onClick={loadLatest}>
                      {t("loadLatest")}
                    </Button>
                  </>
                ) : (
                  actionButtons
                )}
              </div>
  ```
  (the focus effect on `exp-load-latest` keeps working; the `role="alert"` message above stays.)

- [ ] **Step 4 (R3-11): messages.** `Expenses.splitEqually` pt `"Dividir igualmente"` → `"Partes iguais"`; fr `"Répartir également"` → `"Parts égales"` (en "Split equally" and es "Partes iguales" fit at 360).

- [ ] **Step 5: Gates.** `npm run test`, `npx tsc --noEmit`, `npx eslint src`, i18n parity OK.

- [ ] **Step 6: Controller live check (1440, 390, 360 pt/fr):** custom split 70/20 of 100 → "Missing R$10.00" under TOTAL and in the footer, both modes; at 100% → "Matches ✓" only; slider rows 44px tall at 390, compact at 1440; edit conflict (save from a second session first) → message + [Cancel] [Load latest] on one row, no Save, focus on Load latest, clicking it reloads the form; pt/fr at 360: "PARTES IGUAIS"/"PARTS ÉGALES" on one line.

- [ ] **Step 7: Loop checks for Task 12 (J2 desktop + celular, J8 360):** R3-05, R3-09, R3-10, R3-11; `[U3]` with the updated probe (Task 12 Step 3).

- [ ] **Step 8: Leave changes unstaged** (no commits — the owner commits later on a branch he picks).

---

### Task 5: Dialog placement and CSV import outcome — R3-13, R3-06, R3-12

- **R3-13:** from `sm` up every `Modal` is centered vertically, so when its body grows (Add category's error, Import CSV's result) the title moves up and the buttons move down (11px in Add category; Import CSV's top went 180 → 139 → 65 → 152 → 162). Anchor it 4.5rem from the top: growth only pushes the footer down until the max height, then the body scrolls.
- **R3-06:** with a dialog open the toast region moves to the top (16–62px, U1, intentional); the expense form (max height) started at y≈37, so "Expense created" covered half of "EDIT EXPENSE". A top at 4.5rem (72px) clears it; the phone sheet also stops 4.5rem short of the top.
- **R3-12:** on a phone the import outcome sits at the end of the sheet, below the fold (2 of 4 invalid rows visible) while the toast fades; a file error ("The file needs the columns…", "The file is empty") shows at the end of the form, far from the file → scroll the outcome into view; put a file error right under the file row (U11 proximity: `aria-invalid` on the input, file name in debt color).

**Files:**
- Modify: `src/components/ui/Modal.tsx`
- Modify: `src/components/expenses/ImportCsvModal.tsx`

**Interfaces:** none.

- [ ] **Step 1 (R3-13 + R3-06).** In `Modal.tsx` replace the two class strings
  ```tsx
              "inset-x-0 bottom-0 max-h-[92dvh] rounded-t-lg",
              "sm:inset-auto sm:left-1/2 sm:top-1/2 sm:bottom-auto sm:-translate-x-1/2 sm:-translate-y-1/2",
  ```
  with
  ```tsx
              // R3-13 / R3-06: anchored 4.5rem from the top, not centered — a centered dialog jumped
              // (title up, buttons down) whenever an error or a result grew its body, and the tallest one
              // (expense form) started at y≈37, under the top toast (16-62px) dialogs move toasts to.
              // Below sm the bottom sheet stops 4.5rem short of the top for the same toast.
              "inset-x-0 bottom-0 max-h-[calc(100dvh-4.5rem)] rounded-t-lg",
              "sm:inset-auto sm:left-1/2 sm:top-[4.5rem] sm:bottom-auto sm:-translate-x-1/2 sm:max-h-[calc(100dvh-6rem)]",
  ```
  (`anim-sheet` animates `transform`; the `-translate-x-1/2` utility uses the separate `translate` property — no conflict.)

- [ ] **Step 2 (R3-12): outcome and file error.** In `ImportCsvModal.tsx`:
  - imports: add `import { cn } from "@/components/ui/cn";`.
  - after `const fileHintId = useId();` add
    ```tsx
    const fileErrorId = useId();
    const fileErrorRef = useRef<HTMLParagraphElement>(null);
    const resultRef = useRef<HTMLDivElement>(null);

    // R3-12: after an import, bring its outcome into view — on a phone the summary and the invalid
    // rows sat below the fold of the sheet while the toast faded away.
    useEffect(() => {
      if (formError) fileErrorRef.current?.scrollIntoView({ block: "nearest" });
      else if (result) resultRef.current?.scrollIntoView({ block: "start" });
    }, [result, formError]);
    ```
  - the hidden file `<input>`: `aria-describedby={fileHintId}` → ``aria-describedby={formError ? `${fileErrorId} ${fileHintId}` : fileHintId}`` and add `aria-invalid={formError ? true : undefined}`.
  - the file-name span: `className="min-w-0 flex-1 truncate text-sm text-ink-soft"` → `className={cn("min-w-0 flex-1 truncate text-sm", formError ? "text-debt" : "text-ink-soft")}`.
  - right after the closing `</div>` of the `flex flex-wrap items-center gap-3` file row (before `<p id={fileHintId}`) add
    ```tsx
            {/* R3-12: a file-level error (missing columns, empty file, no valid rows) sits under the
                file it is about — it used to be the last line of the form. */}
            {formError && (
              <p id={fileErrorId} ref={fileErrorRef} role="alert" className="mt-1.5 text-pretty text-xs text-debt">
                {formError}
              </p>
            )}
    ```
  - delete the old block `{formError && (<p role="alert" className="text-sm text-debt">{formError}</p>)}` near the end.
  - the result wrapper `<div className="flex flex-col gap-3">` (inside `{result && (`) → `<div ref={resultRef} className="flex flex-col gap-3">`.

- [ ] **Step 3: Gates.** `npm run test`, `npx tsc --noEmit`, `npx eslint src`.

- [ ] **Step 4: Controller live check:** 1440×900 and 1093×600: Add category → submit a duplicate → the title does not move (±1px) and only the footer moves down; Import CSV top stays at 72px through valid / invalid / wrong-header results; save an expense and immediately Edit it → the toast sits above the dialog (toast bottom ≤ dialog top); stacked Discard changes over the form still dims and covers the form; 390×844 and 360×740: the sheet top ≥ 72px; import the 4-invalid-rows CSV → the summary and the rows are scrolled into view; wrong header → the red message is under the file row and the file name is red; the U14 brand x is unchanged with each dialog open.

- [ ] **Step 5: Loop checks for Task 12 (J2 desktop, J5 desktop, J9 desktop + celular):** R3-06, R3-12, R3-13; `[U14]`, `[R2-05]`, `[U2]`/`[U1]` still pass.

- [ ] **Step 6: Leave changes unstaged** (no commits — the owner commits later on a branch he picks).

---

### Task 6: Activity — what is recorded and how it is named: R3-19, R3-20, R3-21, R3-22

- **R3-19:** "Regenerate code" appears in Detailed as "updated the house · name Casa QA · currency BRL · No visible field changed" and not at all in the Summary: the audit extension drops `joinCode` (`SENSITIVE_FIELDS`, `src/lib/prisma-audit.ts:42`), so nothing visible changed. **How the UI knows without the code:** the update's own payload tells the extension a sensitive field was set → it adds `joinCodeChanged: true` to the snapshot (generic: `<field>Changed`, never the value; `sanitize` keeps the marker because it is not a sensitive key). The regenerate route also logs a Summary entry with the same marker (`changes: { joinCodeChanged: true }`, no code). Both tabs read "regenerated the house code"; the Detailed entry shows no name/currency rows (they would read as the change).
- **R3-20 (Decided §4):** Summary "added/edited/removed/recorded … an item" vs Detailed "created/updated/deleted … a shopping item" → new verb values in `act.*` and `action.*`; Detailed uses `act.<ACTION>_<TYPE>` when the key exists.
- **R3-21:** the Summary says "Showing the 100 most recent changes" but Detailed › All just stops (older revisions exist: the House/Membership filters show them) → `/api/revisions` asks for one extra row and returns `hasMore`; Detailed shows the same footer.
- **R3-22:** six identical "recorded/removed a payment — Bruno QA → Ana QA" rows → the Summary complement carries the amount already stored in `AuditLog.changes.amount` ("Bruno QA → Ana QA · R$100.00"). The names are glued with U+00A0 (part of R3-23; the helper lives here).

**Files:**
- Modify: `src/lib/prisma-audit.ts` (update branch) · Test: `src/services/tenant-isolation.test.ts` (describe `"audit trail / EntityRevision (integration, real pglite DB)"`)
- Modify: `src/lib/activity-format.ts` · Test: `src/lib/activity-format.test.ts`
- Modify: `src/app/api/groups/active/regenerate-code/route.ts` · Create test: `src/app/api/groups/active/regenerate-code/route.test.ts`
- Modify: `src/app/api/revisions/route.ts` · Create test: `src/app/api/revisions/route.test.ts`
- Modify: `src/lib/constants.ts` (`ACTIVITY_DETAILED_LIMIT`), `src/lib/types.ts` (`RevisionsResponse.hasMore`)
- Modify: `src/app/(app)/activity/page.tsx` (`SummaryFeed.resolvedSummary`, `DetailedFeed`)
- Modify: `src/messages/{en,pt,es,fr}.json` (`Activity.act.*`, `Activity.action.*`)
- Create: `docs/decisions/0012-sensitive-field-change-markers.md` · Modify: `docs/decisions/README.md` (index line)

**Interfaces:**
- Produces in `src/lib/activity-format.ts`: `export function isJoinCodeRegeneration(r: { entityType: string; action: string; after: Record<string, unknown> | null }): boolean`; `export function summaryActKey(action: string, entityType: string): string`; `export function keepTogether(text: string): string`; `export function settlementLine(from: string, to: string, amount: string | null): string`. `summaryPhrase` now returns `{ key: string; values?: Record<string, number> } | null`.
- Produces: an audited `update` whose `data` sets a sensitive field writes `after: { …snapshot, <field>Changed: true }` (e.g. `joinCodeChanged`).
- Produces: `GET /api/revisions` → `{ revisions, hasMore }`; `POST /api/groups/active/regenerate-code` also records an AuditLog entry `{ entityType: 'GROUP', action: 'UPDATE', summary: '', changes: { joinCodeChanged: true } }`.

- [ ] **Step 1: Write the failing unit tests.** In `src/lib/activity-format.test.ts` add `isJoinCodeRegeneration`, `keepTogether`, `settlementLine`, `summaryActKey` to the import list and append:
  ```ts
  describe('summaryPhrase — join-code regeneration (R3-19)', () => {
    it('names the event from its marker', () =>
      expect(summaryPhrase({ action: 'UPDATE', entityType: 'GROUP', changes: { joinCodeChanged: true } }))
        .toEqual({ key: 'act.REGENERATE_CODE' }))
    it('a currency change keeps the generic phrase', () =>
      expect(summaryPhrase({ action: 'UPDATE', entityType: 'GROUP', changes: { currency: { from: 'BRL', to: 'USD' } } })).toBeNull())
  })

  describe('isJoinCodeRegeneration (R3-19)', () => {
    it('is a Group UPDATE carrying the marker', () => {
      expect(isJoinCodeRegeneration({ entityType: 'Group', action: 'UPDATE', after: { name: 'H', joinCodeChanged: true } })).toBe(true)
      expect(isJoinCodeRegeneration({ entityType: 'Group', action: 'UPDATE', after: { name: 'H', currency: 'USD' } })).toBe(false)
      expect(isJoinCodeRegeneration({ entityType: 'User', action: 'UPDATE', after: { passwordChanged: true } })).toBe(false)
    })
  })

  describe('summaryActKey (R3-20)', () => {
    it('maps a Prisma model name to the Summary key', () => {
      expect(summaryActKey('UPDATE', 'ShoppingItem')).toBe('act.UPDATE_SHOPPING_ITEM')
      expect(summaryActKey('CREATE', 'PaymentMethod')).toBe('act.CREATE_PAYMENT_METHOD')
      expect(summaryActKey('DELETE', 'Expense')).toBe('act.DELETE_EXPENSE')
      expect(summaryActKey('CREATE', 'Group')).toBe('act.CREATE_GROUP')
    })
  })

  describe('keepTogether / settlementLine (R3-22, R3-23)', () => {
    it('glues a name with non-breaking spaces', () => expect(keepTogether('Júlia Caminho Feliz')).toBe('Júlia Caminho Feliz'))
    it('names a payment with unbreakable names, the arrow stuck to the payer and the amount', () =>
      expect(settlementLine('Bruno QA', 'Ana QA', 'R$100.00')).toBe('Bruno QA → Ana QA · R$100.00'))
    it('leaves the amount out when the entry has none (legacy rows)', () =>
      expect(settlementLine('Bruno QA', 'Ana QA', null)).toBe('Bruno QA → Ana QA'))
  })
  ```

- [ ] **Step 2: Run it to verify it fails.**
  Run: `npx vitest run src/lib/activity-format.test.ts`
  Expected: FAIL — the new exports don't exist; the regeneration case returns null.

- [ ] **Step 3: Implement the helpers.** In `src/lib/activity-format.ts` change the `summaryPhrase` signature's return type to `{ key: string; values?: Record<string, number> } | null`, and make its first line (before the SHOPPING_ITEM check):
  ```ts
    // R3-19: a join-code regeneration logs only a marker — never the code (admin-only, while the feed
    // is readable by every member).
    if (entry.entityType === 'GROUP' && entry.action === 'UPDATE' && entry.changes?.joinCodeChanged === true) {
      return { key: 'act.REGENERATE_CODE' }
    }
  ```
  (update its doc comment's first sentence to "…the generic `act.<ACTION>_<TYPE>` can't describe (R2-03 links, R3-19 join-code regeneration)."). Append:
  ```ts
  /** R3-19: a Group UPDATE whose payload set the join code — the audit extension stores the marker
   *  `joinCodeChanged: true`, never the code. */
  export function isJoinCodeRegeneration(r: {
    entityType: string
    action: string
    after: Record<string, unknown> | null
  }): boolean {
    return r.entityType === 'Group' && r.action === 'UPDATE' && r.after?.joinCodeChanged === true
  }

  /** R3-20: the Summary's message key for a Detailed revision (Prisma model "ShoppingItem" →
   *  "act.UPDATE_SHOPPING_ITEM"), so both tabs use one phrase per event whenever the Summary has one. */
  export function summaryActKey(action: string, entityType: string): string {
    return `act.${action}_${entityType.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`
  }

  const NBSP = ' '

  /** R3-23: a person's name never breaks inside ("Ana / QA"); a name longer than the line still wraps
   *  (overflow-wrap). */
  export function keepTogether(text: string): string {
    return text.trim().replace(/\s+/g, NBSP)
  }

  /** R3-22 / R3-23: the Summary complement of a payment — "Bruno QA → Ana QA · R$100.00". Unbreakable
   *  names, the arrow stuck to the payer, and the amount (stored in AuditLog.changes) telling repeated
   *  payments apart. Legacy entries without an amount get no " · …". */
  export function settlementLine(from: string, to: string, amount: string | null): string {
    return `${keepTogether(from)}${NBSP}→ ${keepTogether(to)}${amount ? ` · ${keepTogether(amount)}` : ''}`
  }
  ```

- [ ] **Step 4: Run it to verify it passes.**
  Run: `npx vitest run src/lib/activity-format.test.ts`
  Expected: PASS (existing `summaryPhrase (R2-03)` cases included).

- [ ] **Step 5: Write the failing integration test.** Append inside `describe("audit trail / EntityRevision (integration, real pglite DB)", …)` in `src/services/tenant-isolation.test.ts`:
  ```ts
  it("a join-code regeneration records only a joinCodeChanged marker, never the code (R3-19)", async () => {
    const g = await prisma.group.create({ data: { publicId: randomUUID(), name: "Code House", joinCode: "OLD111" } });
    const fresh = await groupService.regenerateJoinCode(g.id);
    await prisma.group.update({ where: { id: g.id }, data: { currency: "USD" } });
    await flushAudit();

    const feed = await revisionService.listForGroup(g.id, { entityType: "Group" });
    const updates = feed.filter((r) => r.action === "UPDATE").sort((a, b) => a.id - b.id);
    expect(updates).toHaveLength(2);
    expect(updates[0].after?.joinCodeChanged).toBe(true);
    expect(updates[0].after).not.toHaveProperty("joinCode");
    expect(updates[1].after?.joinCodeChanged).toBeUndefined(); // a currency change carries no marker
    const stored = await prisma.entityRevision.findMany({ where: { entityType: "Group", entityId: String(g.id) } });
    expect(JSON.stringify([feed, stored])).not.toContain(fresh);
    expect(JSON.stringify([feed, stored])).not.toContain("OLD111");
  });
  ```
  Run: `npx vitest run src/services/tenant-isolation.test.ts -t "joinCodeChanged marker"` → FAIL (`joinCodeChanged` undefined).

- [ ] **Step 6: Implement the marker.** In `src/lib/prisma-audit.ts` (re-read first), below `SENSITIVE_FIELDS` add
  ```ts
  // R3-19: a sensitive value never enters a snapshot, but THAT it changed is not secret — an update
  // whose payload sets one records `<field>Changed: true` (e.g. joinCodeChanged), so Activity can say
  // "regenerated the house code" instead of an update where nothing visible changed. Only the update's
  // own `data` is inspected (no pre-read: writes stay single round-trip).
  function changeMarkers(data: unknown): AnyRow {
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    return Object.fromEntries(
      Object.keys(data).filter((k) => SENSITIVE_FIELDS.has(k)).map((k) => [`${k}Changed`, true])
    );
  }
  ```
  (place it after `type AnyRow = …`), and in the `operation === "update" || operation === "upsert"` branch change `after: sanitize(row) as Prisma.InputJsonValue` to `after: { ...(sanitize(row) as AnyRow), ...changeMarkers(a.data) } as Prisma.InputJsonValue`. Re-run the test → PASS; then `npx vitest run src/services/tenant-isolation.test.ts` → all PASS (the redaction tests included).

- [ ] **Step 7: Route tests (red), then routes.** Create `src/app/api/groups/active/regenerate-code/route.test.ts` (pattern: `src/app/api/groups/active/currency/route.test.ts` — gate, activity log and service faked; no pglite here):
  ```ts
  import { describe, it, expect, vi, beforeEach } from "vitest";

  const { mockRequireActiveGroup, mockRecordActivity, mockRegenerate } = vi.hoisted(() => ({
    mockRequireActiveGroup: vi.fn(),
    mockRecordActivity: vi.fn(),
    mockRegenerate: vi.fn(),
  }));
  vi.mock("@/lib/api-helpers", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/api-helpers")>();
    return { ...actual, requireActiveGroup: mockRequireActiveGroup, recordActivity: mockRecordActivity };
  });
  vi.mock("@/services/group.service", () => ({ groupService: { regenerateJoinCode: mockRegenerate } }));

  import { POST } from "./route";

  const session = { userId: 1, publicId: "actor", name: "Ana", sessionVersion: 1, iat: 0 };

  beforeEach(() => {
    vi.resetAllMocks();
    mockRegenerate.mockResolvedValue("NEW999");
  });

  describe("POST /api/groups/active/regenerate-code (R3-19)", () => {
    it("records a Summary entry with the marker only — never the code", async () => {
      mockRequireActiveGroup.mockResolvedValue({ ok: true, session, groupId: 7, role: "ADMIN" });
      const res = await POST();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ joinCode: "NEW999" });
      expect(mockRecordActivity).toHaveBeenCalledWith({
        groupId: 7, actorId: 1, entityType: "GROUP", action: "UPDATE", summary: "", changes: { joinCodeChanged: true },
      });
      expect(JSON.stringify(mockRecordActivity.mock.calls)).not.toContain("NEW999");
    });
    it("a member is refused and nothing is recorded", async () => {
      mockRequireActiveGroup.mockResolvedValue({ ok: true, session, groupId: 7, role: "MEMBER" });
      expect((await POST()).status).toBe(403);
      expect(mockRegenerate).not.toHaveBeenCalled();
      expect(mockRecordActivity).not.toHaveBeenCalled();
    });
  });
  ```
  Create `src/app/api/revisions/route.test.ts`:
  ```ts
  import { describe, it, expect, vi, beforeEach } from "vitest";

  const { mockRequireActiveGroup, mockListForGroup } = vi.hoisted(() => ({
    mockRequireActiveGroup: vi.fn(),
    mockListForGroup: vi.fn(),
  }));
  vi.mock("@/lib/api-helpers", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/api-helpers")>();
    return { ...actual, requireActiveGroup: mockRequireActiveGroup };
  });
  vi.mock("@/services/revision.service", () => ({ revisionService: { listForGroup: mockListForGroup } }));

  import { GET } from "./route";

  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: n - i }));
  const list = () => GET(new Request("http://localhost/api/revisions"));

  beforeEach(() => {
    vi.resetAllMocks();
    mockRequireActiveGroup.mockResolvedValue({ ok: true, session: { userId: 1 }, groupId: 7, role: "MEMBER" });
  });

  describe("GET /api/revisions — hasMore (R3-21)", () => {
    it("asks for one extra row and reports older revisions", async () => {
      mockListForGroup.mockResolvedValue(rows(101));
      const body = await (await list()).json();
      expect(mockListForGroup).toHaveBeenCalledWith(7, { entityType: undefined, limit: 101 });
      expect(body.revisions).toHaveLength(100);
      expect(body.hasMore).toBe(true);
    });
    it("exactly the limit is not 'more'", async () => {
      mockListForGroup.mockResolvedValue(rows(100));
      const body = await (await list()).json();
      expect(body.revisions).toHaveLength(100);
      expect(body.hasMore).toBe(false);
    });
  });
  ```
  Run both → FAIL. Implement:
  - `src/lib/constants.ts`, after `ACTIVITY_SUMMARY_LIMIT`: `export const ACTIVITY_DETAILED_LIMIT = 100` with the comment `// Activity › Detailed page size (R3-21: one extra row tells the page that older revisions exist).`
  - `src/app/api/revisions/route.ts`: import `ACTIVITY_DETAILED_LIMIT` next to `REVISION_ENTITY_TYPES`; replace the `limit` and `revisions` lines and the response with
    ```ts
        // R3-21: one extra row tells the page whether older revisions exist (its "most recent" notice).
        // 299 keeps limit + 1 within listForGroup's 300 cap.
        const limit = Math.min(Math.max(Number(searchParams.get('limit')) || ACTIVITY_DETAILED_LIMIT, 1), 299)
        const rows = await revisionService.listForGroup(check.groupId, { entityType, limit: limit + 1 })
        const hasMore = rows.length > limit
        return NextResponse.json({ revisions: hasMore ? rows.slice(0, limit) : rows, hasMore })
    ```
  - `src/lib/types.ts` `RevisionsResponse`: add `hasMore: boolean;` with `// R3-21: more revisions exist beyond the page (the page shows the "most recent" notice).`
  - `src/app/api/groups/active/regenerate-code/route.ts`: import `recordActivity` with the other api-helpers; after `const joinCode = await groupService.regenerateJoinCode(check.groupId)` add
    ```ts
        // R3-19: Activity › Summary names the event ("regenerated the house code"). Only a marker goes
        // into the log — the code itself is admin-only, while the feed is readable by every member.
        await recordActivity({
          groupId: check.groupId,
          actorId: check.session.userId,
          entityType: 'GROUP',
          action: 'UPDATE',
          summary: '',
          changes: { joinCodeChanged: true },
        })
    ```
  Re-run both → PASS.

- [ ] **Step 8: Messages (R3-19, R3-20).** Inside `"Activity"` → `"act"` change values (keys unchanged) and add `CREATE_GROUP` + `REGENERATE_CODE`; inside `"action"` change `CREATE` (and en `DELETE`):
  - en: `UPDATE_EXPENSE` "updated an expense", `DELETE_EXPENSE` "removed an expense", `CREATE_SHOPPING_ITEM` "added a shopping item", `UPDATE_SHOPPING_ITEM` "updated a shopping item", `LINK_SHOPPING_ITEM` "{count, plural, =0 {removed the expense links of a shopping item} one {linked # expense to a shopping item} other {linked # expenses to a shopping item}}", `DELETE_SHOPPING_ITEM` "removed a shopping item", new `CREATE_GROUP` "created the house", new `REGENERATE_CODE` "regenerated the house code"; `action.CREATE` "added", `action.DELETE` "removed".
  - pt: `UPDATE_EXPENSE` "atualizou uma despesa", `DELETE_EXPENSE` "removeu uma despesa", `CREATE_SHOPPING_ITEM` "adicionou um item de compra", `UPDATE_SHOPPING_ITEM` "atualizou um item de compra", `LINK_SHOPPING_ITEM` "{count, plural, =0 {removeu os vínculos de despesas de um item de compra} one {vinculou # despesa a um item de compra} other {vinculou # despesas a um item de compra}}", `DELETE_SHOPPING_ITEM` "removeu um item de compra", `CREATE_GROUP` "criou a casa", `REGENERATE_CODE` "gerou um novo código da casa"; `action.CREATE` "adicionou", `action.DELETE` "removeu".
  - es: `UPDATE_EXPENSE` "actualizó un gasto", `CREATE_SHOPPING_ITEM` "añadió un artículo de compra", `UPDATE_SHOPPING_ITEM` "actualizó un artículo de compra", `LINK_SHOPPING_ITEM` "{count, plural, =0 {quitó los gastos vinculados de un artículo de compra} one {vinculó # gasto a un artículo de compra} other {vinculó # gastos a un artículo de compra}}", `DELETE_SHOPPING_ITEM` "eliminó un artículo de compra", `CREATE_GROUP` "creó la casa", `REGENERATE_CODE` "generó un nuevo código de la casa"; `action.CREATE` "añadió" (`DELETE_EXPENSE` and `action.DELETE` already "eliminó").
  - fr: `UPDATE_EXPENSE` "a mis à jour une dépense", `CREATE_SHOPPING_ITEM` "a ajouté un article de courses", `UPDATE_SHOPPING_ITEM` "a mis à jour un article de courses", `LINK_SHOPPING_ITEM` "{count, plural, =0 {a retiré les dépenses liées d'un article de courses} one {a lié # dépense à un article de courses} other {a lié # dépenses à un article de courses}}", `DELETE_SHOPPING_ITEM` "a supprimé un article de courses", `CREATE_GROUP` "a créé la maison", `REGENERATE_CODE` "a régénéré le code de la maison"; `action.CREATE` "a ajouté" (`DELETE_EXPENSE` and `action.DELETE` already "a supprimé").

- [ ] **Step 9: Activity page.** In `src/app/(app)/activity/page.tsx`:
  - imports: add `isJoinCodeRegeneration`, `settlementLine`, `summaryActKey` to the `@/lib/activity-format` list and `ACTIVITY_DETAILED_LIMIT` to the `@/lib/constants` import.
  - `SummaryFeed.resolvedSummary`, SETTLEMENT branch: replace the template-literal `return` that joins the two `displayName(...)` calls with " → " with
    ```tsx
          // R3-22: the amount tells repeated "recorded a payment — Bruno QA → Ana QA" rows apart;
          // settlementLine also glues each name (R3-23).
          const amount = e.changes.amount;
          return settlementLine(
            displayName(from, fromM?.name ?? "?"),
            displayName(to, toM?.name ?? "?"),
            typeof amount === "string" || typeof amount === "number" ? fmt.money(amount) : null
          );
    ```
    (the GROUP early return and the regeneration phrase need nothing else: `summaryPhrase` now returns `act.REGENERATE_CODE`, and `joinCodeChanged` has no `field.*` translation, so no change row renders.)
  - `DetailedFeed`: add `const [hasMore, setHasMore] = useState(false);` after the `revisions` state; in the fetch, `if (alive) setRevisions(res.revisions);` → `if (alive) { setRevisions(res.revisions); setHasMore(res.hasMore); }`.
  - inside `revisions.map((rev, i) => {` replace
    ```tsx
              const fields = snapshotFields(r);
    ```
    with
    ```tsx
              // R3-19: a join-code regeneration carries only a marker (never the code): its own phrase,
              // and none of the unchanged name/currency rows that would read as the change.
              const codeRegen = isJoinCodeRegeneration(r);
              const fields = codeRegen ? [] : snapshotFields(r);
    ```
    replace `const phraseKey = membershipPhraseKey(r);` with
    ```tsx
              const phraseKey = codeRegen ? "act.REGENERATE_CODE" : membershipPhraseKey(r);
              // R3-20: everything else uses the Summary's phrase for the same event whenever it has one.
              const actKey = summaryActKey(r.action, r.entityType);
    ```
    and replace the phrase JSX
    ```tsx
                        {phraseKey ? (
                          <span className="text-ink-soft">{t(phraseKey)}</span>
                        ) : (
    ```
    with
    ```tsx
                        {phraseKey ? (
                          <span className="text-ink-soft">{t(phraseKey)}</span>
                        ) : t.has(actKey) ? (
                          <span className="text-ink-soft">{t(actKey)}</span>
                        ) : (
    ```
    (the generic `actionLabel` + `entityWithArticle` fallback stays for combinations without a Summary key, e.g. "updated a membership").
  - after the Detailed `</ul>` (inside its `<Card>`) add
    ```tsx
          {/* R3-21: same notice as the Summary — older revisions exist beyond this page. */}
          {hasMore && (
            <p className="border-t border-dotted border-rule px-5 py-3 text-center text-pretty text-xs text-faint">
              {t("limitNotice", { count: ACTIVITY_DETAILED_LIMIT })}
            </p>
          )}
    ```

- [ ] **Step 10: ADR.** Create `docs/decisions/0012-sensitive-field-change-markers.md` (MADR, same shape as 0009): Status accepted, Date 2026-10-04, "Refines [0005]"; `**Decision:**` "An audited update never stores a sensitive value (password, joinCode); when its payload sets one, the revision records `<field>Changed: true` instead, so Activity can name the event without the value." Context: R3-19 ("Regenerate code" read as "No visible field changed"; the code is admin-only, the feed is readable by every member). Options: (1) boolean marker from the update payload — ✅ chosen; (2) store a hash of the code — ❌ a 6-character code is brute-forceable from its hash; (3) the service writes its own revision for regenerations — ❌ a second revision for one write, and the extension would still write the misleading one; (4) infer "nothing visible changed on a Group UPDATE = regeneration" on read — ❌ mislabels legacy same-currency rows. Consequences: regenerations recorded before this decision keep no marker; a User password change gets `passwordChanged` (User revisions belong to no house, no feed shows them). Confirmation: the pglite test "a join-code regeneration records only a joinCodeChanged marker, never the code (R3-19)" and `regenerate-code/route.test.ts`. Add to the `docs/decisions/README.md` index: `- [0010 — Sensitive fields: an audit revision records that they changed, never their value](0012-sensitive-field-change-markers.md)`.

- [ ] **Step 11: Gates.** `npm run test`, `npx tsc --noEmit`, `npx eslint src`, i18n parity OK.

- [ ] **Step 12: Controller live check (restart `homeshare-qa` first):** House › Regenerate code → Summary "Ana QA regenerated the house code"; Detailed › House the same phrase, no name/currency rows, no "No visible field changed"; `fetch('/api/revisions').then(r=>r.json())` and `/api/activity` contain neither the old nor the new code; record and delete a payment → Summary rows "… · R$…"; Detailed and Summary read the same verbs for one new expense ("added an expense"), item events say "a shopping item"; Detailed › All on the QA house (> 100 revisions) ends with the notice.

- [ ] **Step 13: Loop checks for Task 12 (J6 → J7 desktop + celular, J8):** R3-19, R3-20, R3-21, R3-22; `[Deferred 1]`, `[Deferred 2]`, `[R2-26]`, `[R2-27]` still pass; `[R2-03]` texts follow (Task 12 Step 3).

- [ ] **Step 14: Leave changes unstaged** (no commits — the owner commits later on a branch he picks).

---

### Task 7: Activity and history — wrapping, alignment, chips, French colon: R3-07, R3-23, R3-24, R3-25, R3-26, R3-27, R3-34 (Activity)

- **R3-07:** the expense History's Split row breaks inside a share ("→ Ana QA / R$60.00 · …"); the Summary's change row at 360 leaves the arrow at the end of line 1 and restarts the new value at the margin → each share is unbreakable, the arrow travels with the new value (U+00A0 after it), and the Summary change row uses the History's label + value grid (hanging indent). Same for Detailed's split values and arrow.
- **R3-23:** "Bruno QA → Ana / QA", "— Bruno QA…" opening a line (pt/fr/es at 360) → names glued (`keepTogether`, Task 6), U+00A0 before the "—".
- **R3-24:** each Detailed entry's `<dl>` sizes its own label column (`auto`), so values start at x≈399–463 depending on the row → one 10rem label column for every entry (the longest label, pt "despesas vinculadas", is ~137px).
- **R3-25 / R3-26:** the entity chips are pills in mixed case, unlike the square uppercase toggle above; "All" is 43px wide → `rounded-md`, the toggle's type style, `min-w-11`.
- **R3-27:** labels are glued to ":" in code (`field: `), so fr reads "devise: USD → BRL" while the rest of the fr UI writes "caractères :" → `Common.labelColon` ("{label}:"; fr "{label} :") in the Summary and the History.
- **R3-34 (Activity):** fr "Ana QA a mis à jour la / maison", pt/es footer "… mais / recentes", "updated a shopping / item" → `text-pretty` on the Summary sentence, the Detailed sentence and the Summary footer.

**Files:**
- Modify: `src/app/(app)/activity/page.tsx` (`SummaryFeed`, `DetailedFeed`, `FilterChip`)
- Modify: `src/components/expenses/ExpenseDetailModal.tsx` (`ExpenseHistory`)
- Modify: `src/messages/{en,pt,es,fr}.json` (`Common.labelColon`)

**Interfaces:** consumes `keepTogether` from `@/lib/activity-format` (Task 6).

- [ ] **Step 1: Messages.** Inside `"Common"` add `"labelColon"`: en `"{label}:"`, pt `"{label}:"`, es `"{label}:"`, fr `"{label} :"`.

- [ ] **Step 2: Summary (R3-07, R3-23, R3-27, R3-34).** In `SummaryFeed`:
  - add `const tc = useTranslations("Common");` after `const t = useTranslations("Activity");`; add `keepTogether` to the `@/lib/activity-format` import.
  - the sentence paragraph `<p className="break-words text-sm text-ink">` → `<p className="break-words text-pretty text-sm text-ink">`; its actor span content `{displayName(e.actor?.id, e.actor?.name ?? t("system"))}` → `{keepTogether(displayName(e.actor?.id, e.actor?.name ?? t("system")))}`; the separator `{" — "}` → `{" — "}` with `{/* R3-23: names never split ("Ana / QA") and the dash stays at the end of its line, never opening the next. */}` above the `<p`.
  - replace the change-row `<li>`:
    ```tsx
                        <li key={r.field} className="tnum text-xs text-faint">
                          {t(`field.${r.field}`)}: <span className="line-through">{r.from}</span>{" → "}
                          <span className="text-ink-soft">{r.to}</span>
                        </li>
    ```
    with
    ```tsx
                        <li key={r.field} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-1 tnum text-xs text-faint">
                          {/* R3-07: label column + value column (the History's R2-15 layout) — a long
                              "old → new" wraps under the old value and the arrow travels with the new one.
                              R3-27: the label's colon comes from the locale (fr "devise :"). */}
                          <span>{tc("labelColon", { label: t(`field.${r.field}`) })}</span>
                          <span className="min-w-0">
                            <span className="line-through">{r.from}</span>{" → "}
                            <span className="text-ink-soft">{r.to}</span>
                          </span>
                        </li>
    ```
  - the footer `<p className="border-t border-dotted border-rule px-5 py-3 text-center text-xs text-faint">` → `… text-center text-pretty text-xs text-faint">`.

- [ ] **Step 3: Detailed (R3-07, R3-23, R3-24, R3-34).** In `DetailedFeed`:
  - `import { useEffect, useState, type ReactNode } from "react";` → `import { Fragment, useEffect, useState, type ReactNode } from "react";`.
  - `renderValue`'s split branch → 
    ```tsx
        if (field === "split") {
          return (value as SplitShareValue[]).map((s, i) => (
            <Fragment key={s.userId}>
              {i > 0 && " · "}
              {/* R3-07: a share never breaks between the name and its amount. */}
              <span className="whitespace-nowrap">{memberName(s.userId)} <Money value={s.amount} /></span>
            </Fragment>
          ));
        }
    ```
  - the sentence `<p className="text-sm text-ink">` → `<p className="text-pretty text-sm text-ink">`, its actor content → `{keepTogether(displayName(r.actorId, r.actorName ?? t("system")))}`.
  - the `<dl className="mt-1 flex flex-col gap-y-1 sm:grid sm:grid-cols-[auto_1fr] sm:gap-x-2 sm:gap-y-0.5">` → `sm:grid-cols-[10rem_minmax(0,1fr)]` in place of `sm:grid-cols-[auto_1fr]`, and append to its comment: `R3-24: one 10rem label column for every entry (an auto column per entry started the values at a different x on each row).`
  - in the `dd`, `{" → "}` → `{" → "}`.

- [ ] **Step 4: Chips (R3-25, R3-26).** In `FilterChip` replace the comment + first class string with
  ```tsx
          // min-h-11: 44px touch floor on mobile (A3 — was 26px); md:min-h-8 restores the compact desktop size.
          // R3-25: square and uppercase like the Summary/Detailed toggle above (was a rounded pill in mixed
          // case). R3-26: min-w-11 — "All" was 43px wide.
          "inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border px-2.5 py-1 font-display text-xs font-bold uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-stamp md:min-h-8",
  ```

- [ ] **Step 5: History (R3-07, R3-27).** In `ExpenseHistory` (`ExpenseDetailModal.tsx`):
  - `import { useEffect, useState, type ReactNode } from "react";` → `import { Fragment, useEffect, useState, type ReactNode } from "react";`; add `const tc = useTranslations("Common");` after `const t = useTranslations("Expenses");` inside `ExpenseHistory`.
  - `renderValue`'s `participants` case →
    ```tsx
          case "participants":
            return (
              <span>
                {(value as SplitShare[]).map((s, i) => (
                  <Fragment key={s.userId}>
                    {i > 0 && " · "}
                    {/* R3-07: "Ana QA R$60.00" never breaks between the name and its amount. */}
                    <span className="whitespace-nowrap">{memberDisplayName(s.userId)} <Money value={s.amount} /></span>
                  </Fragment>
                ))}
              </span>
            );
    ```
  - the change row: `<span>{fieldLabel(c.field)}:</span>` → `<span>{tc("labelColon", { label: fieldLabel(c.field) })}</span>`, and `<span aria-hidden>→</span>{" "}` → `<span aria-hidden>→</span>{" "}` with `{/* R3-07: U+00A0 after the arrow — it starts the new value's line instead of ending the old one's. */}` above the `<li`.

- [ ] **Step 6: Gates.** `npm run test`, `npx tsc --noEmit`, `npx eslint src`, i18n parity OK.

- [ ] **Step 7: Controller live check:** 1440 History of a 70/30 → 60/40 edit: shares never split, the arrow begins the new value's line; 360 pt/fr Summary: an item rename shows the new value indented under the old one; "Bruno QA → Ana QA" never splits a surname; no line starts with "—"; 1440 Detailed: every value starts at the same x across rows (with and without "linked expenses"); chips square and uppercase, "ALL" ≥ 44px wide at 390; fr Summary "devise : USD → BRL"; fr History "Répartition :".

- [ ] **Step 8: Loop checks for Task 12 (J2 desktop, J7 desktop + celular, J8 desktop fr + 360 pt/fr):** R3-07, R3-23, R3-24, R3-25, R3-26, R3-27, R3-34 (Activity).

- [ ] **Step 9: Leave changes unstaged** (no commits — the owner commits later on a branch he picks).

---

### Task 8: Balances and House rows — R3-14, R3-15, R3-28, R3-29, R3-33 (payment dialog), R3-34 (payment summary)

- **R3-14:** Recorded payments center the amount and ✕ on the whole avatars + note block, so with a note they sit ~10–12px below the avatar line (unlike "Who pays whom") → they ride the avatar line (22px) with or without a note.
- **R3-15:** at 360 "WHO PAYS WHOM" has no dotted rule: `SectionTitle` sits in a `flex-wrap` container and does not grow, so its `flex-1` rule is 0px → `grow` on the title (basis auto: it still wraps above the button when they don't fit).
- **R3-28:** at 360 every member's action (⋯ / "Leave house") drops to a 2nd line of its own (`w-full`, U7) and the ⋯ floats alone → below `sm` the role tag moves under the username (like "Your houses") and the action stays on the first line; `sm` and up unchanged.
- **R3-29:** the drawer's house avatars are 22px, so `avatarLabel` shows 1 initial and every "Casa …" reads "C" → 30px (two initials at the 12px floor, as on the House page).
- **R3-33 §2(a):** Delete this payment? carries "This brings the balance back. This action cannot be undone." as a 2-line subtitle, and "brings the balance back" is vague → the effect + sentence close the body.
- **R3-34:** the payment summary "Bruno QA → Ana QA · R$7,915.43 · / 03/10/2026" leaves the date alone → amount and date travel together.

**Files:**
- Modify: `src/app/(app)/balances/page.tsx`
- Modify: `src/app/(app)/house/page.tsx` (Members row)
- Modify: `src/components/app/MobileNavDrawer.tsx` (two house avatars)
- Modify: `src/messages/{en,pt,es,fr}.json` (`Settlements.deleteUndoNote` values)

**Interfaces:** none.

- [ ] **Step 1 (R3-15).** In `balances/page.tsx`, `<SectionTitle>{t("whoPaysWhom")}</SectionTitle>` → `<SectionTitle className="grow">{t("whoPaysWhom")}</SectionTitle>`, with `{/* R3-15: grow (basis auto) — the title still wraps above the button when they don't fit, and its dotted rule gets the free width (it was 0px at 360). */}` above it.

- [ ] **Step 2 (R3-14).** In Recorded payments replace `<div className="flex items-center gap-3">` (the row holding the chips span, the `Money` and the ✕ button) with `<div className="flex items-start gap-3">`, and wrap `<Money value={p.amount} className="font-display text-sm font-bold" />` plus the ✕ `<button …>` in
  ```tsx
                    {/* R3-14: amount and ✕ ride the avatar line (22px), with or without a note below —
                        they used to center on the whole avatars + note block. The ✕ keeps its 44px hit
                        area, overflowing the line evenly. */}
                    <span className="flex h-[22px] shrink-0 items-center gap-3">
                      {/* existing <Money … /> and <button …>✕</button>, unchanged */}
                    </span>
  ```

- [ ] **Step 3 (R3-33, R3-34): payment dialog.** In the delete-payment `<Modal>` delete `description={ts("deleteUndoNote")}`; in the U17 summary paragraph replace
  ```tsx
              {" · "}
              <Money value={deleteTarget.amount} />
              {" · "}
              {formatDateLocale(deleteTarget.date)}
  ```
  with
  ```tsx
              {" · "}
              {/* R3-34: amount and date travel together — the date no longer drops alone to a line of its own. */}
              <span className="whitespace-nowrap">
                <Money value={deleteTarget.amount} />
                {" · "}
                {formatDateLocale(deleteTarget.date)}
              </span>
  ```
  and add after that paragraph's `)}`:
  ```tsx
        {/* R3-33: the effect and the irreversibility sentence close the body (were a 2-line subtitle). */}
        <p className="mt-2 text-sm text-ink">{ts("deleteUndoNote")}</p>
  ```

- [ ] **Step 4 (R3-28).** In `house/page.tsx`, Members row:
  - replace the `{/* flex-wrap (U7): … */}` comment block above the row with
    ```tsx
                    {/* U7 → R3-28: below sm the role tag sits under the username (like "Your houses"), so
                        the trailing action (⋯ / "Leave house") stays on the first line — it used to drop
                        to a line of its own, leaving the ⋯ alone in an empty strip. From sm up the tag
                        keeps its fixed-width column and the action its sm:w-44 slot (a no-action row
                        reserves the same slot), so both columns line up between rows. */}
    ```
    and `<div className="flex flex-wrap items-center gap-3 px-2 py-3">` → `<div className="flex items-center gap-3 px-2 py-3">`.
  - after `<p className="truncate text-xs text-faint">@{m.username}</p>` add `<span className="mt-1 inline-block sm:hidden"><Tag>{roleLabel(m.role)}</Tag></span>`.
  - `<div className="w-20 shrink-0 text-right">` → `<div className="hidden w-20 shrink-0 text-right sm:block">` (keep the R2-13 comment).
  - the self button class: drop `w-full` → `"label-mono inline-flex min-h-11 shrink-0 items-center justify-end whitespace-nowrap text-debt hover:underline sm:w-44 md:min-h-0"`; in its comment replace "w-full below sm (U7): drops to its own right-aligned line under the name on phones." with "R3-28: no w-full below sm — it stays on the first line.".
  - the admin menu wrapper `<div className="flex w-full shrink-0 justify-end sm:w-44">` → `<div className="flex shrink-0 justify-end sm:w-44">`.

- [ ] **Step 5 (R3-29).** In `MobileNavDrawer.tsx` both house avatars — `<MemberDot colorIndex={activeGroup.colorIndex} name={activeGroup.name} size={22} />` (active-house button) and `<MemberDot colorIndex={group.colorIndex} name={group.name} size={22} />` (houses panel) — get `size={30}`, with `{/* R3-29: 30px = two initials at the 12px floor (avatarLabel), as on the House page — at 22px every "Casa …" read "C". */}` above the houses-panel one.

- [ ] **Step 6: Messages.** `Settlements.deleteUndoNote`:
  - en `"Who pays whom goes back to how it was before this payment. This action cannot be undone."`
  - pt `"Quem paga quem volta a ficar como antes deste pagamento. Esta ação não pode ser desfeita."`
  - es `"Quién paga a quién vuelve a quedar como antes de este pago. Esta acción no se puede deshacer."`
  - fr `"Qui paie qui redevient comme avant ce paiement. Cette action est irréversible."`

- [ ] **Step 7: Gates.** `npm run test`, `npx tsc --noEmit`, `npx eslint src`, i18n parity OK.

- [ ] **Step 8: Controller live check (390, 360 pt/es/fr, 1440, Bolitas too):** Recorded payments: the amount sits on the avatar line on every row, with and without a note; "WHO PAYS WHOM" shows its dotted rule at 360 and at 1440; Members at 360: "SAIR DA CASA"/⋯ on the name's line, tag under the username, a 1-line name row ≤ 92px (name + @username + tag stacked); 640+ unchanged (tag column + sm:w-44 slot aligned); drawer › houses: "CQ", "CC", "CD" avatars; Delete payment: no subtitle, summary line keeps "R$7,915.43 · 03/10/2026" together, body ends with the effect + "This action cannot be undone."

- [ ] **Step 9: Loop checks for Task 12 (J0 celular360, J3 celular + desktop, J6 celular, J8 360):** R3-14, R3-15, R3-28, R3-29, R3-33 (payment), R3-34 (payment summary); `[U5]`, `[R2-13]`, `[R2-24]` still pass.

- [ ] **Step 10: Leave changes unstaged** (no commits — the owner commits later on a branch he picks).

---

### Task 9: Catalogs messages — R3-17, R3-18

- **R3-17:** the two duplicate messages read differently ("This name already exists in this house" vs "This already exists as a system default"), and the delete body starts without a subject ("Will remove "Farmácia" from 7 expenses.") with straight quotes → "This name already exists …" in both, "This will remove “Farmácia” from …" (typographic quotes, as `createTag` and `CsvErrors` already use; fr « »).
- **R3-18:** toasts say only "Added"/"Deleted", and two identical ones stack → the object is named per section ("Category added", "Payment method deleted") through an ICU `select` on the section's `responseKey`.

**Files:**
- Modify: `src/components/app/TagManager.tsx` (two `toast` calls)
- Modify: `src/messages/{en,pt,es,fr}.json` (`ApiErrors.SYSTEM_DEFAULT_COLLISION`, `ApiErrors.DUPLICATE_NAME` pt/es, `Catalogs.deleteExplanation`, `Catalogs.createdToast`, `Catalogs.deletedToast`)

**Interfaces:** `Catalogs.createdToast` / `deletedToast` take `{ kind: "categories" | "platforms" | "paymentMethods" }`.

- [ ] **Step 1: TagManager.** `toast(t("createdToast"), "success");` → `toast(t("createdToast", { kind: responseKey }), "success");` and `toast(t("deletedToast"), "success");` → `toast(t("deletedToast", { kind: responseKey }), "success");`, with `// R3-18: the toast names what was added/deleted ("Category added") — three sections share this component.` above the first.

- [ ] **Step 2: Messages.**
  - en: `SYSTEM_DEFAULT_COLLISION` "This name already exists as a system default"; `deleteExplanation` "This will remove “{name}” from {count, plural, one {# expense} other {# expenses}}. This action cannot be undone."; `createdToast` "{kind, select, categories {Category added} platforms {Platform added} other {Payment method added}}"; `deletedToast` "{kind, select, categories {Category deleted} platforms {Platform deleted} other {Payment method deleted}}".
  - pt: `DUPLICATE_NAME` "Esse nome já existe nesta casa"; `SYSTEM_DEFAULT_COLLISION` "Esse nome já existe como padrão do sistema"; `deleteExplanation` "Isso vai remover “{name}” de {count, plural, =0 {# despesas} one {# despesa} other {# despesas}}. Esta ação não pode ser desfeita."; `createdToast` "{kind, select, categories {Categoria adicionada} platforms {Plataforma adicionada} other {Forma de pagamento adicionada}}"; `deletedToast` "{kind, select, categories {Categoria excluída} platforms {Plataforma excluída} other {Forma de pagamento excluída}}".
  - es: `DUPLICATE_NAME` "Este nombre ya existe en esta casa"; `SYSTEM_DEFAULT_COLLISION` "Este nombre ya existe como predeterminado del sistema"; `deleteExplanation` "Esto quitará “{name}” de {count, plural, one {# gasto} other {# gastos}}. Esta acción no se puede deshacer."; `createdToast` "{kind, select, categories {Categoría añadida} platforms {Plataforma añadida} other {Forma de pago añadida}}"; `deletedToast` "{kind, select, categories {Categoría eliminada} platforms {Plataforma eliminada} other {Forma de pago eliminada}}".
  - fr: `SYSTEM_DEFAULT_COLLISION` "Ce nom existe déjà comme valeur par défaut du système"; `deleteExplanation` "Cela retirera « {name} » de {count, plural, one {# dépense} other {# dépenses}}. Cette action est irréversible."; `createdToast` "{kind, select, categories {Catégorie ajoutée} platforms {Plateforme ajoutée} other {Moyen de paiement ajouté}}"; `deletedToast` "{kind, select, categories {Catégorie supprimée} platforms {Plateforme supprimée} other {Moyen de paiement supprimé}}". (fr `DUPLICATE_NAME` "Ce nom existe déjà dans cette maison" already matches.)

- [ ] **Step 3: Gates.** `npm run test`, `npx tsc --noEmit`, `npx eslint src`, i18n parity OK.

- [ ] **Step 4: Controller live check (1440, en + pt):** add "Mercado" (a system default) → "This name already exists as a system default" under the field; add a duplicate custom name → "This name already exists in this house"; add one item in each section → three different toasts; delete a category in use → body "This will remove “…” from N expenses. This action cannot be undone."; toast "Category deleted".

- [ ] **Step 5: Loop checks for Task 12 (J5 desktop + celular):** R3-17, R3-18; `[U11]` on `tag-name` still passes; j5 texts follow (Task 12 Step 3).

- [ ] **Step 6: Leave changes unstaged** (no commits — the owner commits later on a branch he picks).

---

### Task 10: App chrome — R3-08 (sidebar jump), R3-31 (Settings flattened)

- **R3-08:** the desktop sidebar `nav` is `sticky top-20` (80px) but rests at 83px (header 59px — the bulk bar's `md:top-[3.7rem]` — + the wrapper's `py-6` 24px), so it jumps 3px when scrolling starts → the sticky offset equals the resting position.
- **R3-31 (Decided §5):** `SettingsMenu` renders its pickers as two sections of the user menu; `MenuSub` goes away.

**Files:**
- Modify: `src/components/app/AppChrome.tsx` (sidebar `nav`)
- Modify: `src/components/app/SettingsMenu.tsx`
- Modify: `src/components/ui/Menu.tsx` (remove `MenuSub`, now unused)

**Interfaces:** `SettingsMenu()` renders a fragment (MenuLabel + MenuRadioGroup ×2 + MenuSeparator) — still used only inside `UserMenu`'s `<Menu>`.

- [ ] **Step 1 (R3-08).** In `AppChrome.tsx`, `<nav className="sticky top-20 flex flex-col gap-1">` → `<nav className="sticky top-[5.1875rem] flex flex-col gap-1">`, with `{/* R3-08: top = where the nav already rests (59px header + the wrapper's 24px py-6), so it no longer jumps 3px when the page starts scrolling (was top-20 = 80px). */}` above it.

- [ ] **Step 2 (R3-31).** In `SettingsMenu.tsx`:
  - import line → `import { MenuLabel, MenuSeparator, MenuRadioGroup, MenuRadioItem } from "@/components/ui/Menu";`; delete `const tNav = useTranslations("Nav");`.
  - doc comment → `/** Theme + language pickers as two labelled sections inside the user (avatar) menu. R3-31: they were a "Settings ▸" submenu that always opened to the LEFT (the menu sits at the right edge), against its own arrow and above its row. Logged-in area only — the public auth pages and onboarding keep their own standalone LanguageSelector. */`
  - in the return, `<MenuSub label={tNav("settings")}>` → `<>` and `</MenuSub>` → `</>` (children unchanged).
- [ ] **Step 3: Remove `MenuSub`.** In `src/components/ui/Menu.tsx` delete the `MenuSub` function and its doc comment (no other caller: `rg -n "MenuSub" src` must return nothing afterwards). `Nav.settings` stays (the drawer uses it).

- [ ] **Step 4: Gates.** `npm run test`, `npx tsc --noEmit`, `npx eslint src`.

- [ ] **Step 5: Controller live check:** 1440×900 `/expenses`: note the first sidebar link's `getBoundingClientRect().top`, `scrollBy(0, 400)` → same top (±1); 1093×600 too; user menu: @username, My account, House & members, SKIN (Default ✓ / La Casa das Bolitas), LANGUAGE (4), Log out — fits above the fold at 1093×600; picking Bolitas and a language works with mouse and keyboard; the phone drawer's Settings panel is unchanged.

- [ ] **Step 6: Loop checks for Task 12 (J2 desktop, J6 desktop):** R3-08, R3-31; j6's theme step follows (Task 12 Step 3).

- [ ] **Step 7: Leave changes unstaged** (no commits — the owner commits later on a branch he picks).

---

### Task 11: Copy pass — R3-33 (Make admin, final periods), R3-34 (remaining orphans), R3-35 (pt register), R3-30 (E-mail field)

- **R3-33 (Decided §2 b, c):** Make admin ends with the standard sentence; "All bought." (and its `px-1`, 4px in), the Link-expenses footer, the Activity footer and the 404 text lose their final period.
- **R3-34:** the `<p>` hints that kept orphans get `text-pretty` — welcome's createHint/joinHint, House's join hint, the empty-state hint, the last-admin warnings (account + leave dialog) and the delete-account hint; the register username hint glues "and . - _" with U+00A0 (es "y . - _", fr "et . - _" were alone on the last line).
- **R3-35:** pt alone uses "pros", "pra", "deslogado", "te" → neutral register like es/fr.
- **R3-30:** E-mail shows an empty box beside filled Name/Username, with no hint that it is optional (the account only stores it; a self-set e-mail never links Google, `auth.service.ts:122–131`) → placeholder + hint "Optional".

**Files:**
- Modify: `src/messages/{en,pt,es,fr}.json`
- Modify: `src/app/(app)/shopping/page.tsx` (All bought paragraph)
- Modify: `src/components/app/Onboarding.tsx` (2 hints), `src/app/(app)/house/page.tsx` (join hint, last-admin warning), `src/components/ui/Feedback.tsx` (`EmptyState` hint), `src/app/(app)/account/page.tsx` (E-mail field, delete-account hint, last-admin warning)

**Interfaces:** none.

- [ ] **Step 1: Messages — R3-33.**
  - `Household.makeAdminConfirmPrompt`: en "Admins can remove members, change the currency and regenerate the house code. This action cannot be undone."; pt "Admins podem remover membros, mudar a moeda e gerar um novo código da casa. Esta ação não pode ser desfeita."; es "Los admins pueden quitar miembros, cambiar la moneda y generar un nuevo código de la casa. Esta acción no se puede deshacer."; fr "Les admins peuvent retirer des membres, changer la devise et régénérer le code de la maison. Cette action est irréversible."
  - `Shopping.allBought`: en "All bought", pt "Tudo comprado", es "Todo comprado", fr "Tout est acheté".
  - `Shopping.linkResultsCapped`: en "Showing the {count} most recent — search to find older ones", pt "Mostrando as {count} mais recentes — busque para encontrar outras", es "Mostrando los {count} más recientes — busca para encontrar otros", fr "Affichage des {count} plus récentes — recherchez pour trouver les autres".
  - `Activity.limitNotice`: en "Showing the {count} most recent changes", pt "Mostrando as {count} alterações mais recentes", es "Mostrando los {count} cambios más recientes", fr "Affichage des {count} modifications les plus récentes".
  - `NotFound.description`: en "This address doesn't exist or has moved", pt "Este endereço não existe ou foi movido", es "Esta dirección no existe o fue movida", fr "Cette adresse n'existe pas ou a été déplacée".

- [ ] **Step 2: Messages — R3-34, R3-35, R3-30.**
  - `Auth.usernameHint`: en "3–30 characters: lowercase letters, numbers and . - _"; pt "3–30 caracteres: letras minúsculas, números e . - _"; es "3–30 caracteres: minúsculas, números y . - _"; fr "3–30 caractères : minuscules, chiffres et . - _".
  - pt only: `Expenses.amountHint` "Digite só números — os centavos preenchem da direita para a esquerda"; `Account.currentPasswordHint` "Necessária para confirmar a troca de e-mail ou usuário"; `Account.definePasswordHint` "Sua conta usa login do Google. Defina uma senha para também poder entrar com usuário e senha."; `Account.deleteAccountHint` "Isso anonimiza seu nome, e-mail e usuário. Suas despesas e saldos antigos continuam visíveis para os outros membros, mas sua sessão será encerrada em todos os dispositivos e você não vai conseguir entrar de novo."; `ApiErrors.INVALID_CODE` "Código inválido — confira com quem convidou você".
  - new in `"Account"`: `emailHint` — en "Optional", pt "Opcional", es "Opcional", fr "Facultatif"; `emailPlaceholder` — en "name@example.com", pt "nome@exemplo.com", es "nombre@ejemplo.com", fr "nom@exemple.com".

- [ ] **Step 3: Components.**
  - `shopping/page.tsx`: `<p className="px-1 text-sm text-faint">{t("allBought")}</p>` → `<p className="text-sm text-faint">{t("allBought")}</p>` with `{/* R3-33: no px-1 — the line starts on the cards' edge (was 4px in). */}` above it.
  - `Onboarding.tsx`: both `<p className="text-xs text-faint">` (createHint, joinHint) → `<p className="text-pretty text-xs text-faint">`; add `{/* R3-34: text-pretty — no single word on the last line ("…for the / code"). */}` above the first.
  - `house/page.tsx`: `<p className="text-xs text-faint">{t("joinHint")}</p>` → `<p className="text-pretty text-xs text-faint">{t("joinHint")}</p>`; the leave dialog's `<p className="rounded-md bg-stamp-soft px-3 py-2 text-sm text-ink">{t("lastAdminWarning")}</p>` → add `text-pretty` after `py-2`.
  - `Feedback.tsx` `EmptyState`: `<p className="max-w-xs text-sm text-faint">` → `<p className="max-w-xs text-pretty text-sm text-faint">` (R3-34: "Try adjusting or clearing the / filters").
  - `account/page.tsx`: the E-mail `<Field label={t("email")} htmlFor="account-email" error={emailError}>` → `<Field label={t("email")} htmlFor="account-email" hint={t("emailHint")} error={emailError}>` and its `<Input id="account-email" type="email" …>` gets `placeholder={t("emailPlaceholder")}`; extend the comment inside with `R3-30: the hint says it is optional and the placeholder shows the format.`; `<p className="mt-1 text-sm text-faint">{t("deleteAccountHint")}</p>` → `mt-1 text-pretty text-sm text-faint`; the delete dialog's `<p className="rounded-md bg-stamp-soft px-3 py-2 text-sm text-ink">` (deleteAccountLastAdmin) → add `text-pretty` after `py-2`.

- [ ] **Step 4: Gates.** `npm run test`, `npx tsc --noEmit`, `npx eslint src`, i18n parity OK.

- [ ] **Step 5: Controller live check:** welcome page at 1093, 390 and 360 (a user with no house): both hints end with ≥ 2 words on their last line; House join hint at 360 en/es; empty filtered state at 390; es/fr register at 390: "y . - _"/"et . - _" on one line together; Make admin dialog ends "This action cannot be undone."; Shopping with nothing to buy: "All bought" flush with the cards; 404 and both footers without a final period; pt Account and New expense read "para", "sua sessão será encerrada…"; Account: E-mail shows "name@example.com" and the hint "Optional", and an invalid e-mail still replaces the hint with the red error.

- [ ] **Step 6: Loop checks for Task 12 (J0 all sizes, J1 es/fr, J4, J6, J7, J8 pt):** R3-30, R3-33, R3-34, R3-35; `[U11]` on `account-email` still passes.

- [ ] **Step 7: Leave changes unstaged** (no commits — the owner commits later on a branch he picks).

---

## Final whole-plan review

After Task 11 and BEFORE Task 12's run (code changes hot-reload under running roteiros): one opus reviewer over all phase-4 changes against this plan (spec compliance per R3 id, regressions across tasks — especially Task 5's anchored dialogs at every size and with stacked dialogs, Task 3's 3-line cards, Task 6's audit marker and route contracts, Task 10's menu length at 1093×600), writing `.superpowers/sdd/2026-10-04-ui-loop-phase-4-round-3-fixes/final-review.md`. Fixes it asks for are applied as a "Task 11b" (same gates + controller re-check) before Task 12 starts.

---

### Task 12: Round 4 of the loop (verification)

> **Prerequisite (owner):** reconnect the browser runner — the `pw-edge` Playwright MCP in Edge extension mode. Implementers never start dev servers or browsers; the controller drives the QA server on 127.0.0.1:3100 (DB `homeshare-qa-pg`, 127.0.0.1:55432). Restart `homeshare-qa` before the run (Task 6 changed `prisma-audit.ts`; the Prisma client lives on `globalThis`).

- [ ] **Step 1:** `npm run test`, `npx tsc --noEmit`, `npx eslint src` (no new errors; only the pre-existing one in `src/app/auth/login/page.tsx`).

- [ ] **Step 2: Carry-overs and RESUMO §5 quick checks** (`screenshots/loop-2026-09-27/modelo/`, contract unchanged: `[ID]` prefix, wrapped in `seguro`):
  - **R2-29 (not confirmed in round 3):** J3 setup creates, via the API, one R$1.00 expense dated 2025-01-15 in the journey's house (whose total is ≥ R$200.00) before visiting Balances; `[R2-29]` must then see `menorQue1 >= 1` (a "<1%" label) besides `zeroComValor` empty.
  - **A10:** `[A10]` J2 and J7: List/By person and Summary/Detailed toggles and the Activity chips expose `aria-pressed`, `"true"` exactly on the selected one.
  - **U14 on phones and the desktop house dropdown:** `[U14]` J2/J9 celular — `xMarca()` unchanged with New expense, Filters, Import CSV, the ⋮ menu and the drawer open; J6 desktop — unchanged with the house dropdown open.
  - **Clear purchased (lot L):** J4 — after confirming "Clear purchased" the Purchased section is gone, the toast reads "N items removed", and the DELETE `/api/shopping-items/clear-purchased` status is logged.
  - **New category in the form (lots D, J, M):** J5 → J2 — after creating "Streaming <suffix>", the expense form's Categories search finds it (`menuitemcheckbox` with that name).

- [ ] **Step 3: Follow the intentional UI changes in existing steps:**
  - `ajudantes.js` `medirMotivoDivisao` (U3): `const status = [...d.querySelectorAll('p')].filter(vis).find((e) => /^(over by|missing|\d+% (short|over))/i.test(e.textContent.trim()) && e.textContent.trim().length < 60);` → `….filter(vis).filter((e) => /^(over by|missing|\d+% (short|over))/i.test(e.textContent.trim()) && e.textContent.trim().length < 60).pop();` (R3-05 adds the same reason under TOTAL; U3 measures the footer one — the last).
  - `ajudantes.js` `simbolosJuntos` (T7): the hint now glues the last word to ". - _" with U+00A0 —
    ```js
    const simbolosJuntos = () => p.evaluate(() => {
      const c = document.getElementById('username'); if (!c) return null;
      const h = (c.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean).map((i) => document.getElementById(i)).find(Boolean);
      if (!h) return null;
      // Round 4 (R3-34): "and . - _" joined by U+00A0 (\s matches it in JS).
      const tn = [...h.childNodes].find((nd) => nd.nodeType === 3 && /\.\s-\s_/.test(nd.textContent));
      if (!tn) return { achou: false, texto: h.textContent };
      const m = tn.textContent.match(/\S+\s\.\s-\s_/);
      const rg = document.createRange(); rg.setStart(tn, m.index); rg.setEnd(tn, m.index + m[0].length);
      return { achou: true, linhas: new Set([...rg.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size, texto: h.textContent };
    });
    ```
  - `j2-despesas.js` `[B12]` (the "Load latest stacked above Cancel/Save" check before the `#exp-load-latest` click) → replaced by `[R3-10]`:
    ```js
    await seguro('[R3-10]', async () => {
      const m = await p.evaluate(() => {
        const d = [...document.querySelectorAll('[role=dialog]')].pop();
        const rod = [...d.children].filter((c) => /\bborder-t\b/.test(c.className)).pop();
        const q = (re) => [...rod.querySelectorAll('button')].find((b) => re.test(b.textContent.trim()));
        const topo = (b) => (b ? Math.round(b.getBoundingClientRect().top) : null);
        return { carregar: topo(rod.querySelector('#exp-load-latest')), cancelar: topo(q(/^cancel$/i)), salvar: !!q(/^save$/i), altura: Math.round(rod.getBoundingClientRect().height) };
      });
      confere('[R3-10] conflito: sem Save; "Load latest" ao lado de Cancel (mesma linha); rodapé ≤ 140px', m.carregar !== null && m.cancelar !== null && Math.abs(m.carregar - m.cancelar) <= 1 && !m.salvar && m.altura <= 140, JSON.stringify(m));
    });
    ```
  - `j5-catalogos.js`: `/\bAdded\b/.test(t) && !/Added!/.test(t)` → `/\b(Category|Platform|Payment method) added\b/.test(t)`; `/\bDeleted\b/.test(t) && !/Deleted!/.test(t)` → `/\b(Category|Platform|Payment method) deleted\b/.test(t)`; `/Will remove/` → `/This will remove “/` (descriptions follow).
  - `j6-casa-conta.js`, desktop branch of the Bolitas theme step → no submenu (R3-31):
    ```js
    } else {
      await menuUsuario();
      await print('menu-ajustes');
      // R3-31: Skin and Language are sections of the user menu itself (no "Settings" submenu).
      await p.locator('[role=menuitemradio]', { hasText: 'La Casa das Bolitas' }).click({ timeout: 4000 });
      await espera(900);
    }
    ```
  - `j6-casa-conta.js`: `await confereR212('Make admin', { irreversivel: false });` → `await confereR212('Make admin');` (Decided §2).
  - `j7-atividade-navegacao.js` `[R2-03]`: `'linked 1 expense to an item — '` → `'linked 1 expense to a shopping item — '` and `'removed the expense links of an item — '` → `'removed the expense links of a shopping item — '` (descriptions and the comment above follow).
  - `j4-compras.js` `[D6]`: description `"All bought."` → `"All bought"` (the `textoNaTela('All bought')` test is unchanged).

- [ ] **Step 4: Add the round-3 checks** (same contract). Shared helpers for `ajudantes.js`:
  ```js
  // Round 4: top (px) of the topmost open dialog.
  const topoDoDialogo = () => p.evaluate(() => { const d = [...document.querySelectorAll('[role=dialog], [role=alertdialog]')].pop(); return d ? Math.round(d.getBoundingClientRect().top) : null; });
  // Round 4 (R3-33): the open dialog's subtitle (Dialog.Description = <p> right after the <h2>) and its body text.
  const corpoDoDialogo = () => p.evaluate(() => { const d = [...document.querySelectorAll('[role=dialog], [role=alertdialog]')].pop(); if (!d) return null; const corpo = d.querySelector('.overflow-y-auto'); return { subtitulo: !!d.querySelector('h2 + p'), texto: corpo ? corpo.innerText.replace(/\s+/g, ' ').trim() : '' }; });
  ```
  | ID | Journey / viewport | Check |
  |---|---|---|
  | R3-01 | J2 celular (list + selection mode), J8 360 pt | phone card titles compute `-webkit-line-clamp: 3`; in selection mode no visible `button[aria-label="Actions"]` inside a card `li`, and the title box is ≥ 180px wide at 390; the bulk dialog lists `min(selected, 3)` rows and shows both "Jantar personalizado" amounts |
  | R3-02 | J9 desktop + celular | dateless CSV rows show the browser's local date; the export `download.suggestedFilename()` ends with the browser's local `YYYY-MM-DD.csv` |
  | R3-03 | J1 desktop + celular | empty login: `confereU11('username')` and `confereU11('password')` with "Required", `document.activeElement.id === 'username'`, no `form > [role=alert]` banner; register `an`/`short1`: `erroSob('password').texto` = the password hint and "At least 8 characters" appears once in `main`; existing username: `erroSob('username').texto` matches /already taken/; wrong credentials: banner shown, neither field `aria-invalid` |
  | R3-04 | J2 Filters | the payer chips' label reads "Payers" |
  | R3-05 | J2 desktop + celular, wrong custom split (Amount and %) | a reason `p` inside the scrollable body, top ≤ 40px below the TOTAL row's bottom; `[U3]` (updated probe) still finds the footer reason |
  | R3-06 | J2 desktop, Edit right after a save | the toast's bottom ≤ `topoDoDialogo()` |
  | R3-07 | J2 desktop History; J8 360 pt/fr Activity Summary | each `.whitespace-nowrap` share in the Split row has 1 visual line and the "→" shares its line with the first new share; a Summary change row is a 2-column grid (new value's left > label's right) |
  | R3-08 | J2 desktop | the first sidebar link's `top` at `scrollY = 0` equals its `top` after `scrollBy(0, 400)` (±1) |
  | R3-09 | J2 celular, custom % | every `input[type=range]` in the dialog is ≥ 44px tall |
  | R3-10 | J2 celular, edit conflict | see Step 3 (replaces `[B12]`) |
  | R3-11 | J8 360 pt and fr, New expense | both split segmented buttons have 1 visual line (`linhasDe`) |
  | R3-12 | J9 celular | after the invalid-rows import the "Invalid rows" label is inside the dialog body's visible box; after the wrong-header file the `role=alert` p sits between the file row and the Platform field, and the file name's color = `estiloDoToken('text-debt')` |
  | R3-13 | J5 desktop Add category duplicate; J9 desktop | the dialog title's `top` is unchanged before/after the error (±1); Import CSV's `topoDoDialogo()` is equal in steps 01/03/04 (±1) |
  | R3-14 | J3 celular, J8 360 Balances | in Recorded payments, each amount's vertical center is within ±2px of its first avatar's, rows with and without a note |
  | R3-15 | J0 celular360 Balances | the "Who pays whom" title's dashed rule is > 16px wide |
  | R3-16 | J4 desktop, J0 notebook Shopping; J2 celular filtered | "Clear purchased" has a non-transparent `borderTopColor` and its right edge = the Purchased card's right edge (±1); "Clear filters" text start (Range rect) = the card's left edge (±1) |
  | R3-17 | J5 desktop | the system-default duplicate reads "This name already exists as a system default"; the delete body starts "This will remove “" |
  | R3-18 | J5 desktop + celular | toasts "Category added" / "Platform added" / "Payment method added" and "… deleted"; never a bare "Added"/"Deleted" |
  | R3-19 | J6 (regenerate code) → J7 desktop + celular | Summary and Detailed › House each have "regenerated the house code"; that Detailed entry has no `dl` and no "No visible field changed"; neither `/api/activity` nor `/api/revisions` JSON contains the house's current join code (read from House first) |
  | R3-20 | J7 desktop | no entry in either tab matches `/\b(created|deleted|edited) (an?|the)\b/` except "created the house"; no `/\ban item\b/`; one expense created in the journey reads "added an expense" in both tabs |
  | R3-21 | J7 desktop Detailed › All (QA house, > 100 revisions) | the card ends with "Showing the 100 most recent changes" (no final period) |
  | R3-22 | J7 celular Summary | every "recorded a payment"/"removed a payment" entry contains a money value |
  | R3-23 | J8 360 pt/fr Summary | no "—" is the first glyph of a visual line (its Range rect is not the leftmost on its line); person names contain U+00A0 between first name and surname (textContent) |
  | R3-24 | J7 desktop Detailed | all visible `dd` share the same `left` (±1) |
  | R3-25 | J7 desktop | Activity chips: computed `border-radius` ≤ 4px (Default skin) and `text-transform: uppercase` |
  | R3-26 | J7 celular | every chip box is ≥ 44×44 |
  | R3-27 | J8 desktop fr Activity Summary | change labels match `/devise :/`; none reads "devise:" |
  | R3-28 | J8 360, J0 celular360 House | each member row's action (⋯ / leave) has its vertical center within ±6px of its avatar's; a 1-line-name row is ≤ 72px tall |
  | R3-29 | J6 celular drawer › houses | every house avatar shows 2 letters |
  | R3-30 | J0 desktop + celular Account | `#account-email` has a placeholder and `dicaDe('account-email') === 'Optional'` |
  | R3-31 | J6 desktop | the "La Casa das Bolitas" `menuitemradio` is visible right after opening the user menu; no `menuitem` named "Settings" |
  | R3-33 | J2 + J3 delete dialogs, J6 Make admin, J4, J7, `/rota-que-nao-existe` | `corpoDoDialogo()`: no subtitle and the body ends with "This action cannot be undone." (Delete this expense?, Delete selected expenses?, Delete this payment? — the payment body also has "Who pays whom goes back"); `confereR212('Make admin')`; "All bought", the Link-expenses footer, both Activity footers and the 404 text end without a period; "All bought" left = the cards' left (±1) |
  | R3-34 | J0 notebook/celular/celular360 welcome, J0 celular360 House, J1 es/fr register, J3 celular Delete payment | `palavrasNaUltimaLinha` ≥ 2 words for the welcome createHint/joinHint and House's join hint; `simbolosJuntos()` 1 line; the payment summary's amount and date on one line |
  | R3-35 | J8 360 pt Account + New expense | the page text has no " pra ", " pros ", "deslogado" |
  | R3-32 | — | decided, no check (Decided §6) |

  Then run `cd screenshots/loop-2026-09-27 && bash reset-qa.sh && python gerar-roteiros.py 4`, run every roteiro in `rodada-4/roteiros/` via `pw-edge`, and `python resumo.py 4`.

- [ ] **Step 5: Review.** `python montar-lotes-revisao.py 4`, then parallel reviewers with `rodada-3/revisao/INSTRUCOES-REVISOR.md` (copied to `rodada-4/revisao/`), focused on: every R3 id fixed above; regressions from this phase — Task 5's anchored dialogs at all four sizes (short dialogs now near the top, stacked confirmations, the phone sheet's height), Task 3's 3-line cards and selection mode without ⋯, Task 2's auth pages in 4 locales, Task 10's flattened user menu at 1093×600, Task 7's Detailed label column at 640–767px, Task 8's member rows at 360–640px; the owner-decision items (Decided §1–§6) should look as described there.

- [ ] **Step 6: Consolidate (same shape as round 3):** `achados.json` gets a `rodada4` field per finding (U14 and A10 → "corrigido e conferido" or "não ok"); `rodada-2/achados-r2.json` entries get `"rodada4"` + `"estado"` (R2-12 → "corrigido e conferido" via R3-33, R2-29 → confirmed or not with the seeded month); `rodada-3/achados-r3.json` entries get `"rodada4"` + `"estado"` — fixed ones "corrigido e conferido"/"não ok", R3-01/R3-10/R3-20/R3-31/R3-33 also note "decidido (aplicado)" with the recommendation from "Decided by owner", R3-32 `"decidido (sem mudança)"`, the parts listed in "Won't fix" `"não corrigir"` with the reason; new findings go to `rodada-4/achados-r4.json`; write `rodada-4/RESUMO.md`; regenerate the report (`python gerar-relatorio.py` and `python gerar-relatorio.py --embutido`).
