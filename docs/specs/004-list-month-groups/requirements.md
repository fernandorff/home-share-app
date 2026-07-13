# List month groups — Requirements

## Problem

The List expense view renders one uninterrupted ledger, while By person already separates expenses
into scannable month sections. Long household histories are therefore harder to navigate in List.

## User story

As a household member, I want the List view separated by month so that I can scan expenses and
monthly subtotals without switching to By person.

## Acceptance criteria (EARS)

1. WHILE the List view contains expenses, THE SYSTEM SHALL group loaded expenses by calendar month
   and display a localized month/year header before each group on desktop and mobile.
2. WHILE month groups are displayed, THE SYSTEM SHALL show the subtotal of the loaded expenses in
   each month using exact cent arithmetic.
3. WHEN more expenses load through infinite scroll, THE SYSTEM SHALL merge them into their matching
   month group without changing selection, row numbering, filters, or row actions.
4. WHILE a non-date column sort is active, THE SYSTEM SHALL keep months newest-first and preserve
   the selected server sort within each month; WHILE date sort is active, month order SHALL follow
   the selected date direction.

## Out of scope

- New API aggregates or database queries for full-month totals beyond the currently loaded feed.
- Collapsible month sections.
- Changes to the By person layout.
