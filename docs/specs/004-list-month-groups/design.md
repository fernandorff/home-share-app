# List month groups — Design

## Approach

Extract the existing calendar-month grouping rule into a pure client helper. Both List and By
person use the helper, preventing label, order, and subtotal rules from drifting. The List feed
continues to use its existing server-side filters, sort, and infinite-scroll state; grouping is a
presentation transform over the loaded items. Month subtotals come from the server (owner decision
B5, 2026-10-03): the list and by-person feeds request includeMonthTotals=true and the helper prefers
that total over the loaded sum.

## Data model

None.

## API contract

`GET /api/expenses` gains optional `includeMonthTotals=true`. `ExpenseService.list` runs
`groupBy(['payerId', 'date'])` with the exact same group/filter `where` as the page and buckets the
Decimal sums in integer cents by UTC calendar month (dates are written at local noon, so the UTC
month equals the writer's local month for offsets UTC−11…UTC+11). The `pagination` object then
contains `monthTotals: [{ month: "2026-06", totalAmount: "123.45" }]` and
`payerMonthTotals: [{ payerId: 12, month: "2026-06", totalAmount: "50.00" }]`. Without the flag
the response shape and query count are unchanged. No new error codes.

## UI

`src/app/(app)/expenses/page.tsx` renders the same dashed month header and subtotal pattern already
used by By person. Desktop inserts a full-width table row before each month; mobile inserts a
header followed by that month's card list. Existing memoized row/card elements are reused by id.

## Error handling & edge cases

- Empty feeds retain the existing empty state.
- A month split across pages is merged when the next page arrives.
- Subtotals describe the complete filtered month (server aggregate); only a month missing from the server totals falls back to its loaded rows.
- Non-date sorts preserve their order inside each month; month sections remain newest-first.

## Alternatives considered

- Separate monthly API endpoint — rejected because grouping is presentation-only and the current
  paged feed already contains every required field.
- Duplicate the By person grouping loop in the page — rejected because the two views could drift.
- Subtotals from loaded rows only — superseded on 2026-10-03 (B5): a month split across pages showed a partial total.
