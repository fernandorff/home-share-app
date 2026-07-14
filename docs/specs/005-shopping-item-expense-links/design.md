# Shopping item expense links — Design

## Approach

Use an explicit many-to-many join between `ShoppingItem` and `Expense`. The shopping service owns
link replacement and validates both sides against the active group inside one transaction. Marking
an item purchased remains the existing atomic toggle; only a successful false-to-true response opens
the optional picker.

## Data model

Add `ShoppingItemExpense` with the composite primary key `(shoppingItemId, expenseId)`, `linkedAt`,
and cascading foreign keys. Both parent models expose relation fields. The join stores no money and
does not affect balance calculations.

## API contract

- `GET /api/shopping-items` includes `linkedExpenses` summaries.
- `PUT /api/shopping-items/:itemId/expenses` with `{ expenseIds: string[] }` replaces all links.
- The array may be empty to unlink all and is capped at 100 unique UUIDs.
- Invalid input returns `400 INVALID_EXPENSE_LINKS`; an item or expense outside the active house
  returns `404` without revealing which foreign entity exists.

## UI

After a successful purchase toggle, open a modal with a debounced description search, multi-select
rows, Save, and Skip. Purchased rows show a localized linked-expense count and expose "Link
expenses" in their actions menu. Add keys in all four locale files.

## Error handling & edge cases

Link replacement is transactional. Duplicate ids are collapsed by input normalization. Canceling the
modal never undoes the purchase. Deleting either parent cascades only the join rows. A house change
closes the picker and reloads house-scoped items.

## Alternatives considered

- Store expense UUIDs in a shopping-item array — rejected because referential integrity and cascade cleanup would be lost.
- Create one expense automatically when checking an item — rejected because payer, total, split, tags, and receipt grouping require user decisions.
