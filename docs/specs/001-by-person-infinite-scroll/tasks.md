# By-person infinite scroll — Tasks

- [x] 1. Add opt-in, filter-scoped PostgreSQL payer aggregates and unit coverage — `src/services/expense.service.ts`, `src/services/expense.service.test.ts` _Requirements: 4_
- [x] 2. Parse and expose the opt-in API contract and query-builder flag — `src/app/api/expenses/route.ts`, `src/lib/expense-query.ts`, `src/lib/expense-query.test.ts`, `src/lib/types.ts` _Requirements: 1, 4_
- [x] 3. Make the infinite-expense feed lazily enableable — `src/lib/use-infinite-expenses.ts` _Requirements: 1, 5_
- [x] 4. Replace the by-person one-shot fetch with a paged feed, exact totals, reload behavior, and a dedicated sentinel — `src/app/(app)/expenses/page.tsx` _Requirements: 1, 2, 3, 4, 5, 6, 7, 8_
- [x] 5. Verify with targeted Vitest suites and `npx tsc --noEmit` _Requirements: 1, 2, 3, 4, 5, 6, 7, 8_
- [ ] 6. Manually inspect initial, next-page, filtered, empty, mobile-tab, and house-switch states in the visible browser _Requirements: 1, 2, 3, 4, 5, 6, 7, 8_
