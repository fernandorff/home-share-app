# Database balance aggregation — Requirements

## Problem

The production balance calculation aggregates expenses in PostgreSQL, while its tests exercise a
separate in-memory implementation. The database path must be independently testable so tests cannot
pass while the production query is wrong.

## User story

As a household member, I want balances to be exact and isolated to my active house so that the
amounts shown never include another household or lose a cent.

## Acceptance criteria (EARS)

1. WHEN balances are requested for a group, THE SYSTEM SHALL aggregate payer credits and participant
   debits in PostgreSQL and return the difference in integer-cent-safe values.
2. WHEN two groups contain expenses, THE SYSTEM SHALL include only expenses and participants whose
   expense belongs to the requested group.
3. WHEN participant shares sum to each expense total, THE SYSTEM SHALL return balances whose sum is
   exactly zero cents, including repeated decimal amounts and uneven splits.
4. WHEN recorded settlements are applied, THE SYSTEM SHALL keep settlement application and debt
   simplification in Node.js using integer cents.

## Out of scope

- Precomputed or cached balances.
- Moving settlement simplification or insight aggregation into SQL.
- API response shape changes.
