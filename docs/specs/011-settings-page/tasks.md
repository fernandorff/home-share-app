# Settings page — Tasks

Each task names its exact file(s) and the requirement it satisfies. Order = dependency order.
TDD: tests first (the project pins UI contracts on the source — no DOM environment), run red, then the code.
Never `npm run build` locally (`.env*` = production Neon).

- [x] 1. Redirects, test first: `/account` and `/conta` → `/settings/account` (permanent) —
      `next.config.ts`, `src/components/settings/settings-ui.test.ts` _Requirements: 8_
- [x] 2. Theme tokens, test first: bolitas selectors without `html`; `[data-theme="default"]` block; parity
      test (values equal `@theme`, every bolitas token present) — `src/app/globals.css`,
      `src/lib/theme-tokens.test.ts` _Requirements: 3_
- [x] 3. `ThemePreview` (token utilities only, `data-theme` wrapper) — `src/components/settings/ThemePreview.tsx`
      _Requirements: 3_
- [x] 4. Settings layout + category list (aria-current, list → detail below md, back link) and the index page —
      `src/app/(app)/settings/layout.tsx`, `src/app/(app)/settings/page.tsx` _Requirements: 1, 2_
- [x] 5. Appearance page: theme cards (aria-pressed, apply at once) + language buttons —
      `src/app/(app)/settings/appearance/page.tsx` _Requirements: 3, 4, 5_
- [x] 6. Account + Security pages: move the sections; delete the old page; repoint the tests that read it —
      `src/app/(app)/settings/account/page.tsx`, `src/app/(app)/settings/security/page.tsx`,
      `src/app/(app)/account/page.tsx` (deleted), `src/components/app/ServiceWorkerRegistrar.test.ts`,
      `src/lib/phase4-final-review.test.ts` _Requirements: 7_
- [x] 7. Install flow hook, tests first (moved focus rules): `useInstallFlow` —
      `src/components/notifications/InstallSheet.tsx`, `src/components/notifications/notifications-ui.test.ts`
      _Requirements: 6, 9_
- [x] 8. Notifications settings page + Notices page without tabs (gear link), tests updated first —
      `src/app/(app)/settings/notifications/page.tsx`, `src/app/(app)/notifications/page.tsx`,
      `src/components/notifications/notifications-ui.test.ts` _Requirements: 6, 9_
- [x] 9. Entry points, tests first: avatar menu "Settings" + "My account" links, drawer without settings panel;
      delete `SettingsMenu` and the menu radio items it alone used — `src/components/app/AppChrome.tsx`,
      `src/components/app/MobileNavDrawer.tsx`, `src/components/app/SettingsMenu.tsx` (deleted),
      `src/components/ui/Menu.tsx`, `src/components/app/AppChrome.test.ts` _Requirements: 10_
- [x] 10. i18n (4 locales): `Settings` namespace, `Notifications.settingsLink`, reworded `notNowToast`; removed
      `Notifications.tabs` and `Account.title`/`subtitle` (no longer read) — `src/messages/en.json`,
      `src/messages/pt.json`, `src/messages/es.json`, `src/messages/fr.json`, `src/lib/i18n-parity.test.ts`
      _Requirements: 11_
- [x] 11. Verify: `npx tsc --noEmit` + `npm run test` + `npm run lint`; live check on a local instance
      (throwaway Postgres on 127.0.0.1:58432 + `next dev` on 127.0.0.1:3110 — the QA container's port 55432 now
      falls in a Windows-reserved range): each criterion, both themes active, 375px and 1280px widths.
