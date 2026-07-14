# Shopping item expense links — Requirements

## Problem

Completing a shopping-list item records that it was bought, but loses the connection to the
expense records that paid for it. A purchase may be split across more than one receipt/expense.

## User story

As a household member, I want to link a completed shopping item to one or more expenses so that the
shopping list and financial history remain connected.

## Acceptance criteria (EARS)

1. WHEN an unpurchased item is marked as purchased, THE SYSTEM SHALL offer an optional expense-linking dialog without reverting the completed state when the dialog is skipped.
2. WHEN a member saves one or more selected expenses, THE SYSTEM SHALL replace that item's links atomically and return the linked expense summaries.
3. WHEN a purchased item already has links, THE SYSTEM SHALL display their count and allow the member to edit or remove those links.
4. WHEN a request references an item or expense outside the active house, THE SYSTEM SHALL reject the request without creating or removing any link.
5. WHEN a shopping item or expense is deleted, THE SYSTEM SHALL remove its link rows without deleting the related entity.
6. WHILE the picker is open, THE SYSTEM SHALL support searching expenses by description and selecting multiple results with 44 px mobile touch targets.

## Out of scope

- Creating a new expense from the shopping dialog.
- Assigning a portion of an expense amount to an individual shopping item.
- Automatically guessing links from item or expense descriptions.
