# Money as integer cents

- Status: accepted
- Date: 2026-07-11 (backfilled — decision predates this record)

**Decision:** all money arithmetic happens on integer cents (`lib/currency`); the DB
stores `Decimal(10,2)`; `amount` / `participant.amount` serialize as **strings** in JSON
(computed balances as numbers); comparisons are exact — no epsilon, anywhere.

## Context and Problem Statement

The app splits expenses among house members and settles balances. Splits rarely divide
evenly (R$ 100,00 / 3), and balances must reconcile to exactly zero after settle-up. How
is money represented in code, database, and JSON so no cent is ever created or lost?

## Decision Drivers

- Split + settle must be exact: participant shares must sum to the expense total, always.
- Comparisons must be exact equality — an epsilon hides real off-by-one-cent bugs.
- JSON must not silently degrade precision in transit.

## Considered Options

1. **Integer cents in code; `Decimal(10,2)` in DB; strings in JSON** — ✅ chosen.
2. IEEE-754 floats end to end — ❌ binary floats can't represent most decimal fractions;
   split/settle accumulates drift until balances don't zero out or an epsilon papers over
   it. Disqualifying for money.
3. Decimal library (decimal.js / big.js) end to end — ❌ a dependency and a wrapper type
   on every value for a problem integer cents already solve at BRL's fixed two-decimal
   scale; easy to leak a plain number at a boundary and silently lose the guarantee.

## Decision Outcome

[src/lib/currency.ts](../../src/lib/currency.ts) (`toCents` / `fromCents` / `splitCents`)
is the only place money math lives. `splitCents` distributes the remainder
deterministically (first *r* parts get the extra cent), so shares always sum to the exact
total.

### Consequences

- Good: integer arithmetic is exact by definition; `0.1 + 0.2` never happens.
- Good: an off-by-one-cent bug surfaces as a failing exact comparison instead of hiding
  under a tolerance.
- Bad: boundary discipline — every DB read/JSON parse must convert through `toCents`
  before math; a raw `parseFloat` on an amount string is a bug by convention.
- Bad: two representations side by side (cents in code, decimal strings at the edges) —
  newcomers must learn this before touching money paths.

### Confirmation

- `lib/currency` unit tests (incl. `splitCents` remainder distribution); expense service
  tests assert participant shares sum exactly to the total.
