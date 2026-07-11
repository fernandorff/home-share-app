# <Feature name> — Tasks

Each task names its exact file(s) and the requirement it satisfies. Order = dependency order.

- [ ] 1. <Schema/migration change> — `prisma/schema.prisma` _Requirements: 1_
- [ ] 2. <Service method + unit tests> — `src/services/<x>.service.ts`, `src/services/<x>.service.test.ts` _Requirements: 1, 2_
- [ ] 3. <Route handler (validate → service → respond)> — `src/app/api/<x>/route.ts` _Requirements: 2_
- [ ] 4. <UI + i18n keys (4 locales)> — `src/app/(app)/<x>/page.tsx`, `src/messages/*.json` _Requirements: 3_
- [ ] 5. Verify: `npx tsc --noEmit` + `npm run test` green; each acceptance criterion has a
      test (or documented manual check); live check on the deployed app.
