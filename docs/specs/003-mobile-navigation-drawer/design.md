# Mobile navigation drawer — Design

## Approach

Use Radix Dialog, already installed for accessible modals, as a controlled right-side drawer below
the `md` breakpoint. The dialog owns three in-panel views (`main`, `houses`, `settings`) so mobile
never stacks floating dropdowns. Desktop keeps the existing dropdowns and sidebar. Touch-density
rules switch at the same 768px breakpoint as the navigation architecture.

## Data model

None.

## API contract

None. House switching continues to use the existing session `switchGroup` method and logout
continues to use `POST /api/auth/logout`.

## UI

- `AppChrome` hides the desktop house/user controls below `md`, removes the bottom nav, and mounts
  a mobile menu trigger.
- `MobileNavDrawer` uses the existing navigation routes and visual tokens. Main items are at least
  48px tall; the trigger and close/back buttons are at least 44px.
- Theme and locale mutation move to shared client preference helpers so desktop and mobile menus
  exercise one implementation.
- Expenses uses a mobile action grid: full-width primary action plus overflow; its view selector
  uses equal columns. Desktop ordering and density remain unchanged.
- New navigation text is added to all four locales.

## Error handling & edge cases

- Switching a house leaves the drawer open and returns to the main panel only after success.
- Long account and house names truncate without widening the drawer.
- Radix handles Escape, outside click, focus trapping, scroll locking, and focus restoration.
- Reduced-motion users receive no drawer animation.

## Alternatives considered

- Bottom navigation — rejected: six truncated destinations consume persistent vertical space.
- Nested dropdown menus — rejected: narrow screens cannot reliably accommodate side-opening menus.
- Hiding page actions in global navigation — rejected: contextual actions must remain discoverable
  on their owning page.
