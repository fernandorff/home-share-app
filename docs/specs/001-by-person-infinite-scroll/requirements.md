# By-person infinite scroll — Requirements

## Problem

The expenses "By person" view requests up to 100,000 matching expenses at once. Long-lived
households therefore pay an unbounded network, memory, and render cost before seeing the view.

## User story

As a household member, I want older expenses to load as I scroll through the by-person view so
that the initial screen stays responsive without losing the grouped ledger or its exact totals.

## Acceptance criteria (EARS)

1. WHEN a member first opens the by-person view, THE SYSTEM SHALL request page 1 with at most 50 expenses ordered by date descending.
2. WHEN the by-person sentinel enters the viewport and another page exists, THE SYSTEM SHALL request exactly the next page and append its expenses without duplicates.
3. WHILE only part of the filtered result is loaded, THE SYSTEM SHALL group every loaded expense by payer and calendar month in newest-first month order.
4. WHILE only part of the filtered result is loaded, THE SYSTEM SHALL display each payer's exact total across the complete filtered result, as aggregated by PostgreSQL rather than inferred from loaded pages.
5. WHEN filters or the active house change, THE SYSTEM SHALL discard accumulated by-person pages and request a new page 1 for the new query scope.
6. WHEN an expense is created, edited, deleted, or imported after the by-person view has been requested, THE SYSTEM SHALL reload its page 1 and its complete payer totals.
7. WHEN the first by-person page is loading, THE SYSTEM SHALL show the existing grouped skeleton; WHEN a later page is loading, THE SYSTEM SHALL preserve loaded groups and show the existing loading-more indicator.
8. WHEN no matching expense exists, THE SYSTEM SHALL preserve the existing empty-house and filtered-no-results states.

## Out of scope

- Changing the expense data model, money representation, filters, or list-view pagination.
- Virtualizing already-loaded rows.
- Changing control sizes, colors, typography, or modal loading.
