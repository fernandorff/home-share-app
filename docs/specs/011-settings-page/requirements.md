# Settings page — Requirements

Handoff: `.superpowers/handoffs/2026-10-08-settings-page.md` (scope, routes and entry points decided by the
owner on 2026-10-08). Builds on PR #73 (sliding session, "Log out of all devices").

## Problem

Settings are scattered: theme and language are radio items inside the avatar menu (desktop) and a sub-panel
of the mobile drawer, notice preferences hide in a tab of the Notices page, and account/security share one
long `/account` page. The theme is chosen by name only — nobody can see what "La Casa das Bolitas" looks like
before switching to it.

## User story

As a member, I want one Settings page grouped by category, with a live preview of each theme, so that I find
every preference in one place and see a theme before applying it.

## Acceptance criteria (EARS)

Each criterion must be verifiable by a test (or a single curl) in ~10 seconds.

1. THE SYSTEM SHALL serve four settings categories at `/settings/appearance`, `/settings/notifications`,
   `/settings/account` and `/settings/security`, each listed (label + one-line hint) in the category list
   of `/settings`; the current category SHALL be marked with `aria-current="page"`.
2. WHILE the viewport is `md` or wider, THE SYSTEM SHALL show the category list on the left of the open
   category; WHILE it is narrower, `/settings` SHALL show only the list and each category SHALL show only
   its content with a back link to `/settings`. On `md` or wider, `/settings` SHALL show the list and a
   short "Choose a category" note (owner, 2026-10-08); desktop entry points link to `/settings/appearance`.
3. THE SYSTEM SHALL show one card per theme in `THEMES` on Appearance, each with a miniature (header, two
   expenses, a balance) rendered with that theme's real tokens — also for a theme that is not the active one.
4. WHEN a member clicks a theme card, THE SYSTEM SHALL apply that theme to the whole app at once (no reload)
   and remember it (cookie `homeshare_theme`, as today); the active card SHALL be marked (`aria-pressed`).
5. WHEN a member picks a language on Appearance, THE SYSTEM SHALL apply it (cookie `locale`, as today) and
   re-render the page in that language.
6. THE SYSTEM SHALL show on `/settings/notifications` what the Notices "Preferences" tab shows today (push
   card, one switch per notice type, "App on home screen" card), with the same behavior and install steps.
7. THE SYSTEM SHALL show on `/settings/account` the profile, password and delete-account sections, and on
   `/settings/security` "Log out of all devices" — each with today's behavior (incl. the push re-sync after a
   password change).
8. WHEN `/account` (or the legacy `/conta`) is requested, THE SYSTEM SHALL redirect (308) to
   `/settings/account`.
9. THE SYSTEM SHALL show the Notices page without tabs (the list only) and with a gear link labelled
   "Notification settings" to `/settings/notifications`.
10. THE SYSTEM SHALL replace the theme/language radios of the avatar menu with a "Settings" item that opens
    `/settings/appearance`, and the drawer's settings panel with a "Settings" link to `/settings`; "My
    account" (menu and drawer) SHALL open `/settings/account`.
11. THE SYSTEM SHALL provide every new text in en/pt/es/fr (`Settings` namespace); the "Not now" toast of the
    install banner SHALL point to Settings › Notifications instead of "Preferences".

## Out of scope

- New preferences (density, currency, default house…) — only what exists today moves.
- Theme on the public auth pages / onboarding (they keep their own language selector, no theme picker).
- Per-device vs. per-account storage of theme/language (stays a cookie per browser).
- A dark theme.
