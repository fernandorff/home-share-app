# Promote admin — Tasks

- [x] 1. Service: `promoteToAdmin` + `lastAdminGroupIds` with pglite tests (promote + revision,
      non-admin 403, other house 404, ex-member 404, last-admin flag) — `src/services/group.service.ts`,
      `src/services/tenant-isolation.test.ts` _Requirements: 1, 2, 3, 5, 7_
- [x] 2. Route `PATCH` + route tests — `src/app/api/groups/active/members/[userId]/route.ts`,
      `src/app/api/groups/active/members/[userId]/route.test.ts` _Requirements: 1, 2, 3, 4_
- [x] 3. `lastAdmin` on `/api/auth/me` — `src/app/api/auth/me/route.ts`, `src/lib/types.ts` _Requirements: 7_
- [x] 4. House menu + confirmation, leave and delete-account warnings, i18n (4 locales) —
      `src/app/(app)/house/page.tsx`, `src/app/(app)/account/page.tsx`, `src/messages/*.json` _Requirements: 6, 8_
- [x] 5. Rejoin resets the role (a kicked admin stays a member; a house with no admin promotes the returner,
      also when the person joins for the first time) —
      `src/services/group.service.ts` (`joinByCode`), `src/services/tenant-isolation.test.ts` _Requirements: 9_
- [ ] 6. Verify: `npx tsc --noEmit` + `npm run test` green; criteria 6 and 8 checked in round 2 of
      the UI loop (journey J6).
