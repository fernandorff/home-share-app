# Theme Selector — Design Spec

**Date:** 2026-06-30 · **Scope:** DEV only (no commit, no deploy until user says so)

## Goal

A theme selector that swaps the **entire visual style** (colors, fonts, border
radius, textures, shadows) while keeping the **layout/diagramming EXACTLY the
same** — same DOM, same spacing, same positions. Only token *values* change.

Ship **two themes**:
1. **`default`** — the current retro-mono look (the existing tokens). Default.
2. **`bolitas`** — replicates the original *La Casa das Bolitas* cozy
   cottage-ledger style (sibling project `../la-casa-das-bolitas`).

## Why token-based (the only allowed approach)

The app already drives all styling through CSS custom properties declared in
`src/app/globals.css` under `@theme` (e.g. `--color-paper/card/panel/ink/
ink-soft/faint/rule`, `--color-stamp/stamp-soft/credit/debt`, `--color-cat/
plat/pay` + `-soft`, `--font-mono/--font-display`, `--radius-sm/md/lg`).
Components reference these **semantic tokens** via Tailwind utilities
(`bg-paper`, `text-ink`, `border-rule`, `font-mono`, `rounded-sm`, …).

Therefore a theme = a block that **overrides the VALUES of those same tokens**.
Switching themes never touches component markup or layout classes → layout is
provably identical across themes.

## Architecture

### 1. `data-theme` on `<html>`
- Default token values stay in `@theme` / `:root` (theme `default`).
- Add an override block scoped to **`html[data-theme="bolitas"]`** (specificity
  beats `:root`, source-ordered after `@theme`) that redefines the `--color-*`,
  `--font-*`, `--radius-*` tokens with cozy values.
- Switching = setting `document.documentElement.dataset.theme`.

### 2. SSR application (no FOUC)
- Root layout (`src/app/layout.tsx`) reads a `bolitas_theme` cookie via
  `cookies()` (next/headers) and renders `<html data-theme={theme}>`.
- Absent/invalid cookie → `default`.
- Because the attribute is server-rendered, there is no flash on reload.

### 3. Persistence
- Cookie **`bolitas_theme`** (values `default` | `bolitas`). **Not** httpOnly —
  it is a non-sensitive UI preference the client sets directly; mirrors the
  existing `bolitas_*` cookie naming but is readable by JS.
- On switch the client does both: set `document.documentElement.dataset.theme`
  (instant re-skin) **and** write the cookie (`document.cookie`, `path=/`,
  ~1yr, `SameSite=Lax`) so the next SSR load is correct.

### 4. Fonts
- Current: `Space_Mono` (`--font-space-mono` → display) + `JetBrains_Mono`
  (`--font-jetbrains-mono` → mono), set as `className` vars on `<html>`.
- Add **`Nunito`** (`--font-nunito`) + **`Fredoka`** (`--font-fredoka`) via
  `next/font/google` in the layout; append their variables to the `<html>`
  className (all font vars are always present; the theme picks which apply).
- In `html[data-theme="bolitas"]`, override `--font-mono: var(--font-nunito)`
  and `--font-display: var(--font-fredoka)`. (`default` keeps the mono fonts.)

### 5. Selector UI
- A small control in the app header (`src/components/app/AppChrome.tsx`), next
  to the language (`PT`) switcher, following existing `components/ui` patterns
  (e.g. `Menu`/`MenuItem` or a compact toggle). Labels in pt-BR + i18n.
- Lists the available themes; current one marked active; selecting one applies
  immediately and persists.
- Keep it a tiny client component; do not restructure the header layout.

### 6. i18n
- New UI strings (theme button label, theme names) added to **all four**
  locales: `src/messages/{en,pt,es,fr}.json` (namespace e.g. `Theme`).

## The `bolitas` token map

Read `../la-casa-das-bolitas/src/app/globals.css` (source of truth) and map its
cozy palette onto the Home Share semantic tokens. Light theme only (the original
has a dark mode; out of scope here). Concrete targets:

| Home Share token | bolitas value (cozy, light) |
|---|---|
| `--color-paper` | warm cream `#f7eed9` / `#faf3e8` (page parchment) |
| `--color-card` | `#fdf8f0` (lighter parchment) |
| `--color-panel` | `#f0e4cc` (warm beige surface) |
| `--color-ink` | `#4a3520` (cozy ink brown) |
| `--color-ink-soft` | `#5a4510` |
| `--color-faint` | `rgba(90,69,16,0.55)` |
| `--color-rule` | tan border `rgba(160,114,92,0.35)` → solid approx `#c9a98f` |
| `--color-stamp` (accent) | terracotta `#8B4332` (companion `--color-stamp-soft` ≈ `#f1e3dc`) |
| `--color-credit` | cozy green `#3D7A4E` |
| `--color-debt` | rust `#A44B2A` |
| `--color-cat / plat / pay` | pick 3 cozy hues (e.g. terracotta-muted, sage `#3D7A4E`, amber `#8B6914`) + soft tints, keeping them distinct |
| `--radius-sm/md/lg` | rounded: ~`8px / 12px / 16px` (original `--radius: 1rem`) |
| `--font-mono` | `var(--font-nunito)` |
| `--font-display` | `var(--font-fredoka)` |

Also re-skin any global texture rules in `globals.css` that are theme-specific
(e.g. the paper-grain / dotted-rule / `::selection` accent) so `bolitas` reads
cozy, not retro — but **only colors/texture, never geometry/spacing**.

Exact final values are at the implementer's discretion as long as the result
visibly matches the cozy cottage-ledger aesthetic of the original app.

## Out of scope (YAGNI)
- No dark mode. No per-component theme overrides. No theme beyond these two.
- No DB/user-profile storage (cookie only). No commit/deploy.

## Success criteria (completion gates — ALL must pass)
1. `npx tsc --noEmit` clean (run `rm -rf .next/types` first if stale).
2. `npm run test` (vitest) green.
3. `npm run build` green.
4. Visual (Playwright on localhost, logged-in): switching to `bolitas` re-skins
   **every** page (despesas, saldos, compras, catálogos, atividade, casa);
   switching back to `default` is identical to today; the **layout does not
   move** between themes (same structure/spacing — verify by comparing element
   positions/DOM, not just the screenshot); no FOUC on reload.
5. Engineering standards (CLAUDE.md): code in English / UI pt-BR; imports at top
   (no inline); surgical changes; i18n in 4 locales; retro-mono conventions kept
   for the `default` theme.
