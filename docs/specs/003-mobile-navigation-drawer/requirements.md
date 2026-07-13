# Mobile navigation drawer — Requirements

## Problem

The authenticated mobile shell exposes a house selector in the header and six more destinations
in a fixed bottom bar. At widths between 640px and 767px, controls also mix desktop and touch
densities, making the layout feel inconsistent and reducing usable content space.

## User story

As a household member using a phone or small tablet, I want one predictable top-right menu so
that navigation, house switching, account access, and settings do not compete with page content.

## Acceptance criteria (EARS)

1. WHILE the viewport is narrower than 768px, THE SYSTEM SHALL show only the brand and one
   44-by-44-pixel menu trigger in the global header.
2. WHILE the viewport is narrower than 768px, THE SYSTEM SHALL NOT render a fixed bottom
   navigation bar or a standalone house selector.
3. WHEN the mobile menu trigger is activated, THE SYSTEM SHALL open a focus-trapped right-side
   dialog containing the active account, active house, all six application destinations, account,
   settings, and logout actions.
4. WHEN the active-house row is activated, THE SYSTEM SHALL show the available houses and the
   manage-house action inside the same dialog, with a back action to the main menu.
5. WHEN settings is activated, THE SYSTEM SHALL show theme and language choices inside the same
   dialog, with a back action to the main menu.
6. WHEN a navigation destination is activated, THE SYSTEM SHALL navigate to it and close the
   dialog, with the current destination exposed through `aria-current`.
7. WHILE the viewport is narrower than 768px, THE SYSTEM SHALL keep primary buttons, icon buttons,
   and segmented controls at least 44px tall; removable filter chips SHALL be at least 32px tall.
8. WHILE the viewport is at least 768px wide, THE SYSTEM SHALL preserve the existing desktop
   header, house selector, user menu, and left sidebar.
9. WHILE viewing Expenses below 768px, THE SYSTEM SHALL display New expense as the primary action,
   expose CSV actions through a 44px overflow trigger, and render the List/By person selector with
   equal-width choices.

## Out of scope

- Changing routes, permissions, APIs, or persisted navigation preferences.
- Redesigning page content below each page's toolbar.
- Gesture-only drawer interactions.
