# List month groups — Tasks

- [x] 1. Extract and test exact month grouping — `src/lib/expense-month-groups.ts`,
      `src/lib/expense-month-groups.test.ts` _Requirements: 1, 2, 4_
- [x] 2. Reuse month grouping in List and By person — `src/app/(app)/expenses/page.tsx`
      _Requirements: 1, 3, 4_
- [x] 3. Verify TypeScript, lint, tests, production build, and live desktop/mobile behavior
      _Requirements: 1, 2, 3, 4_
- [x] 4. Server month totals (exact cents, same filters) — `src/lib/month-totals.ts`,
      `src/services/expense.service.ts`, `src/app/api/expenses/route.ts`,
      `src/services/tenant-isolation.test.ts` _Requirements: 2_
- [x] 5. Month headers use the server totals in List and By person — `src/lib/expense-month-groups.ts`,
      `src/lib/expense-query.ts`, `src/lib/use-infinite-expenses.ts`, `src/app/(app)/expenses/page.tsx` _Requirements: 2_
