# Database balance aggregation — Tasks

- [x] 1. Extract the grouped Prisma queries into a framework-agnostic service —
      `src/services/balance.service.ts` _Requirements: 1, 2, 3_
- [x] 2. Make the balances route orchestrate the service and Node.js settlement rules —
      `src/app/api/balances/route.ts` _Requirements: 1, 4_
- [x] 3. Replace the duplicate Node aggregation with PostgreSQL integration coverage —
      `src/services/tenant-isolation.test.ts`, `src/lib/balance.ts`,
      `src/lib/balance.test.ts`, `src/lib/balance-settlements.test.ts` _Requirements: 1, 2, 3, 4_
- [x] 4. Verify targeted tests and `npx tsc --noEmit` — _Requirements: 1, 2, 3, 4_
