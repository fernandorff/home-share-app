# Settings page — Design

## Approach

A route group `src/app/(app)/settings/` with a client `layout.tsx` (category list + content) and one page per
category. Nothing new on the server: theme and language keep their cookies (`lib/client-preferences`), and
the moved sections keep calling the same endpoints. Existing code is **moved, not rewritten**: the account
page's sections and the Notices "Preferences" panel change file, not behavior. Redirects use the
`redirects()` list already in `next.config.ts`.

## Data model

None.

## API contract

None (no endpoint added or changed).

## UI

**Layout** — `settings/layout.tsx`: `PageHeader` "Settings" + a two-column grid from `md` (`<nav>` with the 4
categories on the left, `children` on the right). Below `md`: on `/settings` only the nav; on a category only
its content, with "← Settings" back link. Decided by `usePathname()` + CSS (`hidden md:block`), no viewport JS.

**Appearance** — `settings/appearance/page.tsx`:
- Theme: one `<button aria-pressed>` card per theme in `THEMES`; inside, `<ThemePreview theme={…} />`
  (`src/components/settings/ThemePreview.tsx`): a `<div data-theme={theme}>` with a mini header, two expense
  rows and a balance, drawn only with the token utilities (`bg-paper`, `text-ink`, `border-rule`,
  `text-stamp`, `text-credit`, `font-mono`…). Click → `applyThemePreference(theme)` + local state (same as
  today's pickers). Initial state read from `document.documentElement.dataset.theme` after mount.
- Language: the 4 `LANGUAGES` as the same segmented buttons, `applyLocalePreference` + `router.refresh()`.

**Theme tokens (the hard part)** — `globals.css`:
- The bolitas selectors drop `html` (`html[data-theme="bolitas"]` → `[data-theme="bolitas"]`, also for
  `.paper-grain` / `.skeleton`), so a preview wrapper picks them up. Same specificity class as before and still
  unlayered, so it keeps winning over Tailwind's `@theme` (layered) on `<html>`.
- New block `[data-theme="default"] { … }` re-declaring the default token values, because a default-theme
  preview inside a bolitas page would otherwise inherit bolitas values. Drift guard: a test parses
  `globals.css` and checks (a) every value in that block equals the `@theme` one and (b) every token the
  bolitas block overrides exists in the default block.

**Notifications** — `settings/notifications/page.tsx`: `NotificationPreferences` + its install flow
(`useInstallPrompt`, `startInstall`, `InstallSheet`). The flow (sheet state, `startInstall`,
`promptFromSheet`, `iosDone`) moves into a hook `useInstallFlow(fallbackFocus)` in
`src/components/notifications/InstallSheet.tsx`, used by both the Notices page (banner) and this page (card)
— one copy of the focus rules. Notices page: tabs, tablist keyboard code and the preferences panel removed;
`InstallBanner` stays; a gear `Link` "Notification settings" next to the title.

**Account / Security** — `ProfileSection`, `PasswordSection`, `DeleteAccountSection` move to
`settings/account/page.tsx`; `SessionsSection` to `settings/security/page.tsx`. They keep the `Account`
namespace (no key churn). `src/app/(app)/account/page.tsx` is deleted.

**Entry points** — `AppChrome` user menu: `<SettingsMenu />` and its separator → `MenuItem` "Settings" →
`/settings/appearance`; "My account" → `/settings/account`. `MobileNavDrawer`: the `"settings"` panel, theme
state and language handlers removed; "My account" → `/settings/account`; "Settings" becomes a `Link` to
`/settings`. `SettingsMenu.tsx` is deleted.

**Redirects** — `next.config.ts`: `conta` now points straight to `/settings/account` (no chain) and `account`
→ `/settings/account` is added (both permanent).

**i18n** — new `Settings` namespace (title, subtitle, back, chooseCategory, theme, themeHint,
`categories.<id>.label|hint`, `preview.*` sample texts) and `Notifications.settingsLink`; the reworded
`Notifications.install.notNowToast`. `Theme.<id>` names the cards and `Common.language` titles the language block.
Removed: `Notifications.tabs.*` (only the tablist used them) and `Account.title`/`subtitle` (the old page header).

**Mobile** — list rows and cards ≥ 44px tall; preview cards stack on one column below `sm`, two from `sm`.

## Error handling & edge cases

- Cookie write fails / blocked: same as today (theme still applied for the page; nothing to report).
- Unknown theme in the attribute: `isTheme` guard keeps `default` as the marked card.
- Deep links to the removed Preferences tab: there were none (`grep` of `tabs.preferences` usage = the page).

## Alternatives considered

- Keep Settings as one long page with anchors — rejected: owner chose categories (list → detail on mobile).
- Restructure all tokens into `[data-theme=…]` blocks and keep only non-swappable tokens in `@theme` —
  rejected: touches every token and Tailwind's utility generation; the duplicated default block + parity test
  is a smaller diff with the same guarantee.
- Preview via `<iframe>` of a real page — rejected: heavy, needs auth, slow on mobile.
- Server redirect `/settings` → `/settings/appearance` — rejected: would kill the mobile list.
