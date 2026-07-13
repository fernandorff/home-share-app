# By-person infinite scroll — Design

## Approach

The by-person view reuses `useInfiniteExpenses` with its own stable date-descending query and a
50-row page size. Its sentinel follows the list view's callback-ref `IntersectionObserver`
pattern. Pages are global (not one cursor per member), then the existing memoized UI projection
groups the accumulated rows by payer and month. The expenses endpoint accepts an opt-in
`includePayerTotals=true`; `ExpenseService.list` uses PostgreSQL `groupBy` with the exact same
group/filter `where` clause and serializes Decimal sums as strings. This keeps header totals exact
before all pages have arrived without adding client-side money arithmetic beyond existing display
conversion. The hook gains an `enabled` option so the second feed remains lazy until the view is
opened.

## Data model

None. Stored money remains `Decimal(10,2)` and API money remains a decimal string.

## API contract

`GET /api/expenses` gains optional query parameter `includePayerTotals=true`.

When requested, the response's `pagination` object additionally contains:

```json
{ "payerTotals": [{ "payerId": 12, "totalAmount": "123.45" }] }
```

The aggregate is scoped to the active-group cookie and to exactly the same filters as the page.
Without the flag, the response shape and query count remain unchanged. No new error codes.

## UI

`src/app/(app)/expenses/page.tsx` replaces the one-shot by-person fetch with a lazy infinite feed.
Loaded rows retain the current person/month cards, mobile person selector, menus, filters, loading,
and empty states. Person headers read the full filtered totals returned by the API. A sentinel below
the grouped grid loads the next chronological page and shows the existing `loadingMore` copy.

## Error handling & edge cases

- `useInfiniteExpenses` keeps its request-id guard, preventing an old filter/house response from
  contaminating the new accumulated feed.
- Stable server ordering (`date`, then `id`) prevents offset-page ties from duplicating/skipping rows.
- Repeated observer callbacks are ignored while a page is loading or no page remains.
- A member without matching expenses remains visible with an exact zero total and empty message.

## Alternatives considered

- One 100,000-row request — rejected: unbounded initial cost is the defect being fixed.
- Independent pagination per payer — rejected: multiple observers/cursors complicate mobile tabs and
  can multiply requests by household size.
- Totals from loaded pages — rejected: changes the meaning of the existing person header while loading.
- Row virtualization — rejected: it reduces DOM cost but not the oversized API response.
