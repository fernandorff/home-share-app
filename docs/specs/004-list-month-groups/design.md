# List month groups — Design

## Approach

Extract the existing calendar-month grouping rule into a pure client helper. Both List and By
person use the helper, preventing label, order, and subtotal rules from drifting. The List feed
continues to use its existing server-side filters, sort, and infinite-scroll state; grouping is a
presentation transform over the loaded items.

## Data model

None.

## API contract

None. Existing paged `GET /api/expenses` responses remain unchanged.

## UI

`src/app/(app)/expenses/page.tsx` renders the same dashed month header and subtotal pattern already
used by By person. Desktop inserts a full-width table row before each month; mobile inserts a
header followed by that month's card list. Existing memoized row/card elements are reused by id.

## Error handling & edge cases

- Empty feeds retain the existing empty state.
- A month split across pages is merged when the next page arrives.
- Subtotals describe loaded rows, matching the existing By person infinite-scroll behavior.
- Non-date sorts preserve their order inside each month; month sections remain newest-first.

## Alternatives considered

- Separate monthly API endpoint — rejected because grouping is presentation-only and the current
  paged feed already contains every required field.
- Duplicate the By person grouping loop in the page — rejected because the two views could drift.
