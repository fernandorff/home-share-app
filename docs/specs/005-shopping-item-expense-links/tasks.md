# Shopping item expense links — Tasks

- [x] 1. Add the explicit join model — `prisma/schema.prisma` _Requirements: 2, 4, 5_
- [x] 2. Include and atomically replace links in the shopping service — `src/services/shopping-item.service.ts` _Requirements: 2, 3, 4_
- [x] 3. Add the group-scoped replacement route — `src/app/api/shopping-items/[itemId]/expenses/route.ts` _Requirements: 2, 4_
- [x] 4. Add picker UI, linked count, and four-locale copy — `src/app/(app)/shopping/page.tsx`, `src/lib/types.ts`, `src/messages/*.json` _Requirements: 1, 3, 6_
- [x] 5. Prove replacement, unlink, cascade, and tenant isolation — `src/services/tenant-isolation.test.ts` _Requirements: 2, 4, 5_
- [ ] 6. Verify the live shopping flow after the schema reaches a review deployment; local `npx tsc --noEmit`, `npm run test`, and `npx next build` are green _Requirements: 1–6_
