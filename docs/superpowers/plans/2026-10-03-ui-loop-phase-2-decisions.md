# UI Test Loop · Phase 2 (Owner Decisions) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the 12 findings the owner decided after round 1 of the UI test loop (B5, B9, B10, D3, D4, D5, D6, I7, I11, I12, T8, U21) plus the two items deferred by the phase-1 review (purchase toggles missing from Activity › Detailed; no "House" filter in Activity › Detailed), then run round 2 of the loop.

**Architecture:** Server changes stay in the existing layers — framework-agnostic services (`src/services`) with pglite integration tests, thin route handlers, pure helpers in `src/lib` with unit tests — and need NO schema change. Month totals (B5) reuse the exact `where` of `ExpenseService.list` through a Prisma `groupBy` bucketed in integer cents; promotion (B10) is a service method behind a new `PATCH` on the existing member route, audited automatically by the Prisma extension (ADR 0005). UI changes are presentation-only and are verified by round 2 of the loop (prints + layout measurements in `screenshots/loop-2026-09-27`).

**Tech Stack:** Next.js 16 App Router, React 19, Tailwind v4 (CSS-first), Radix Dialog/DropdownMenu, next-intl 4 (EN/PT/ES/FR), Prisma 7 + Postgres, Vitest + pglite.

**Spec:** Owner decisions on the 12 `"estado": "decidir"` entries of `screenshots/loop-2026-09-27/achados.json` (chosen option is final, restated per task below) · `docs/specs/004-list-month-groups/` (changed by Task 1) · `docs/specs/005-shopping-item-expense-links/` (changed by Task 2) · `docs/specs/006-promote-admin/` (created by Task 3) · `docs/decisions/0002-*` (active house), `0003-*` (integer cents), `0005-*` (audit extension) · phase-1 plan `docs/superpowers/plans/2026-09-27-ui-loop-round-1-fixes.md` (its Task 16 is reused as Task 12).

## Global Constraints

- Build on the CURRENT working tree (≈60 unstaged files from phase 1, 274 tests green), not on HEAD. Never `git stash`, `git checkout --`, or reset those files.
- English in all code, comments, identifiers and URLs. UI text only through `src/messages/{en,pt,es,fr}.json`: every new key in all 4 files; change values, never keys, of existing messages unless the task says so.
- `cn()` in `src/components/ui/cn.ts` only joins strings (no tailwind-merge): never stack two utilities for the same CSS property at the same breakpoint.
- Money is integer cents (`lib/currency`: `toCents`/`fromCents`/`splitCents`); DB is `Decimal(10,2)` and API amounts serialize as strings; comparisons are exact (no epsilon).
- API errors carry a `code` translated client-side (`useApiError`, namespaces `ApiErrors`/`CsvErrors`).
- Tenant isolation via `requireActiveGroup`; `groupId` never comes from the body.
- Mobile-first (44px touch floor below `md`, spec 003 criterion 7); animations stay behind `prefers-reduced-motion`.
- Gates per task: `npm run test` green, `npx tsc --noEmit` clean, `npx eslint src` with no new errors (1 pre-existing error in `src/app/auth/login/page.tsx`).
- i18n parity check (run after every task that touches messages; must print `i18n parity OK`):
  ```bash
  node -e 'const f=o=>Object.entries(o).flatMap(([k,v])=>v&&typeof v==="object"?f(v).map(s=>k+"."+s):[k]);const L=["en","pt","es","fr"].map(l=>new Set(f(require("./src/messages/"+l+".json"))));const all=new Set(L.flatMap(s=>[...s]));const miss=[...all].filter(k=>!L.every(s=>s.has(k)));console.log(miss.length?"MISSING "+miss.join(", "):"i18n parity OK")'
  ```
- **NO commits.** Leave every change unstaged — the owner commits later on a branch he picks.
- NEVER run `npm run build`, `prisma db push`, or anything that reads `.env` / `.env.local` (they point at the PRODUCTION Neon DB). This plan needs no schema change; if one ever became necessary it would be a Prisma migration file applied only to the QA Docker DB `homeshare-qa-pg` (127.0.0.1:55432).
- Implementers do not start dev servers or browsers; the controller verifies visually on the QA server at 127.0.0.1:3100.

## Decided without code change

- **I12 — date filter fields:** keep the native `<input type="date">` in `ExpenseFiltersModal`. No code change; Task 12 marks the finding as decided in `achados.json`.

## Task order and shared files

Tasks run in order (1 → 12). Files touched by more than one task: `src/messages/*.json` (3, 4, 6, 8, 9, 10), `src/app/(app)/shopping/page.tsx` (2, 9, 10), `src/app/(app)/house/page.tsx` (4, 9, 10), `src/app/(app)/expenses/page.tsx` (1, 9), `src/app/(app)/activity/page.tsx` (5, 6, 7, 9), `src/lib/prisma-audit.ts` (5, 6), `src/services/tenant-isolation.test.ts` (1, 2, 3, 5, 6), `src/lib/types.ts` (1, 3). Search by content — line numbers drift.

---

### Task 1: B5 — month headers show the server's full-month total

Decision: the server returns the total of each month for the current filtered query (like the per-payer totals of spec 001), and every month header (List desktop table, List mobile cards, By person desktop and mobile) shows that total instead of the sum of the loaded pages (50 per page). This changes spec 004 criterion 2.

**Files:**
- Modify: `docs/specs/004-list-month-groups/requirements.md`, `docs/specs/004-list-month-groups/design.md`, `docs/specs/004-list-month-groups/tasks.md`
- Create: `src/lib/month-totals.ts` · Test: `src/lib/month-totals.test.ts`
- Modify: `src/lib/expense-month-groups.ts` · Test: `src/lib/expense-month-groups.test.ts`
- Modify: `src/lib/expense-query.ts` · Test: `src/lib/expense-query.test.ts`
- Modify: `src/services/expense.service.ts` (`PaginationParams`, `ExpenseService.list`)
- Modify: `src/app/api/expenses/route.ts` (`GET`)
- Modify: `src/lib/types.ts` (`Pagination`)
- Modify: `src/lib/use-infinite-expenses.ts`
- Modify: `src/app/(app)/expenses/page.tsx` (`buildListUrl`, `buildByPersonUrl`, `byPerson` and `listMonths` memos)
- Test: `src/services/tenant-isolation.test.ts` (describe `"expense list filters + totalAmount aggregate (integration, real pglite DB)"`)

**Interfaces:**
- Produces (`src/lib/month-totals.ts`):
  - `export interface MonthTotal { month: string; totalAmount: string }` (`month` = `"YYYY-MM"`, `totalAmount` = decimal string with 2 places)
  - `export interface PayerMonthTotal { payerId: number; month: string; totalAmount: string }`
  - `export function utcMonthKey(date: Date): string`
  - `export function bucketMonthTotals(rows: readonly { payerId: number; date: Date; amount: { toString(): string } | null }[]): { monthTotals: MonthTotal[]; payerMonthTotals: PayerMonthTotal[] }`
- Produces (API): `GET /api/expenses?includeMonthTotals=true` → `pagination.monthTotals: MonthTotal[]` and `pagination.payerMonthTotals: PayerMonthTotal[]` (both omitted without the flag). `PaginationParams.includeMonthTotals?: boolean`.
- Produces (client): `BuildExpenseQueryParams.includeMonthTotals?: boolean`; `UseInfiniteExpensesResult.monthTotals` / `.payerMonthTotals`; `groupExpensesByMonth(expenses, locale, monthDirection = "desc", monthTotals?: ReadonlyMap<string, number>)` — map value is reais as a number (same unit as the existing `subtotal`).

- [ ] **Step 1: Update spec 004 (the decision changes it).**
  In `docs/specs/004-list-month-groups/requirements.md` replace criterion 2 with:
  ```markdown
  2. WHILE month groups are displayed, THE SYSTEM SHALL show each month's subtotal across the
     complete filtered result (every page, not only the loaded expenses), as aggregated by the
     server with exact cent arithmetic; a month without a server total SHALL fall back to the sum
     of its loaded expenses.
  ```
  and delete the Out-of-scope bullet `- New API aggregates or database queries for full-month totals beyond the currently loaded feed.`
  In `design.md`: append to the Approach paragraph `Month subtotals come from the server (owner decision B5, 2026-10-03): the list and by-person feeds request includeMonthTotals=true and the helper prefers that total over the loaded sum.`; replace the API contract section body `None. Existing paged GET /api/expenses responses remain unchanged.` with:
  ```markdown
  `GET /api/expenses` gains optional `includeMonthTotals=true`. `ExpenseService.list` runs
  `groupBy(['payerId', 'date'])` with the exact same group/filter `where` as the page and buckets the
  Decimal sums in integer cents by UTC calendar month (dates are written at local noon, so the UTC
  month equals the writer's local month for offsets UTC−11…UTC+11). The `pagination` object then
  contains `monthTotals: [{ month: "2026-06", totalAmount: "123.45" }]` and
  `payerMonthTotals: [{ payerId: 12, month: "2026-06", totalAmount: "50.00" }]`. Without the flag
  the response shape and query count are unchanged. No new error codes.
  ```
  Replace the edge-case bullet `- Subtotals describe loaded rows, matching the existing By person infinite-scroll behavior.` with `- Subtotals describe the complete filtered month (server aggregate); only a month missing from the server totals falls back to its loaded rows.` and append to Alternatives: `- Subtotals from loaded rows only — superseded on 2026-10-03 (B5): a month split across pages showed a partial total.`
  In `tasks.md` append:
  ```markdown
  - [ ] 4. Server month totals (exact cents, same filters) — `src/lib/month-totals.ts`,
        `src/services/expense.service.ts`, `src/app/api/expenses/route.ts`,
        `src/services/tenant-isolation.test.ts` _Requirements: 2_
  - [ ] 5. Month headers use the server totals in List and By person — `src/lib/expense-month-groups.ts`,
        `src/lib/expense-query.ts`, `src/lib/use-infinite-expenses.ts`, `src/app/(app)/expenses/page.tsx` _Requirements: 2_
  ```

- [ ] **Step 2: Write the failing unit tests.**
  Create `src/lib/month-totals.test.ts`:
  ```ts
  import { describe, it, expect } from "vitest";
  import { bucketMonthTotals, utcMonthKey } from "./month-totals";

  describe("bucketMonthTotals (B5)", () => {
    it("sums per-day rows into exact month and payer-month totals in integer cents", () => {
      const { monthTotals, payerMonthTotals } = bucketMonthTotals([
        { payerId: 1, date: new Date("2026-06-02T12:00:00Z"), amount: "0.10" },
        { payerId: 2, date: new Date("2026-06-18T12:00:00Z"), amount: "0.20" },
        { payerId: 1, date: new Date("2026-06-30T12:00:00Z"), amount: "12.34" },
        { payerId: 1, date: new Date("2026-05-20T12:00:00Z"), amount: "100.00" },
      ]);
      expect(monthTotals).toEqual([
        { month: "2026-06", totalAmount: "12.64" },
        { month: "2026-05", totalAmount: "100.00" },
      ]);
      expect(payerMonthTotals).toEqual([
        { payerId: 1, month: "2026-06", totalAmount: "12.44" },
        { payerId: 2, month: "2026-06", totalAmount: "0.20" },
        { payerId: 1, month: "2026-05", totalAmount: "100.00" },
      ]);
    });

    it("treats a null sum as zero", () => {
      expect(bucketMonthTotals([{ payerId: 1, date: new Date("2026-06-02T12:00:00Z"), amount: null }]).monthTotals)
        .toEqual([{ month: "2026-06", totalAmount: "0.00" }]);
    });

    it("keys months in UTC", () => {
      expect(utcMonthKey(new Date("2026-01-31T23:30:00Z"))).toBe("2026-01");
      expect(utcMonthKey(new Date("2026-12-01T00:00:00Z"))).toBe("2026-12");
    });
  });
  ```
  Append inside the `describe("groupExpensesByMonth", …)` block of `src/lib/expense-month-groups.test.ts`:
  ```ts
  it("uses the server's full-month total when one is given, else the loaded sum (B5)", () => {
    const groups = groupExpensesByMonth(expenses, "en", "desc", new Map([["2026-06", 999.99]]));
    expect(groups[0]?.subtotal).toBe(999.99);
    expect(groups[1]?.subtotal).toBe(0.1);
  });
  ```
  Append inside the `describe("buildExpenseQuery", …)` block of `src/lib/expense-query.test.ts`:
  ```ts
  it("opts into exact month totals only when asked (B5)", () => {
    const withTotals = buildExpenseQuery({ page: 1, pageSize: 50, sortField: "amount", sortDirection: "asc", filters: EMPTY_FILTERS, includeMonthTotals: true });
    expect(paramsOf(withTotals).get("includeMonthTotals")).toBe("true");
    const without = buildExpenseQuery({ page: 1, pageSize: 50, sortField: "date", sortDirection: "desc", filters: EMPTY_FILTERS });
    expect(paramsOf(without).has("includeMonthTotals")).toBe(false);
  });
  ```

- [ ] **Step 3: Run them to verify they fail.**
  Run: `npx vitest run src/lib/month-totals.test.ts src/lib/expense-month-groups.test.ts src/lib/expense-query.test.ts`
  Expected: FAIL — `month-totals` module not found; the 4th `groupExpensesByMonth` argument is ignored (subtotal 12.54); `includeMonthTotals` param missing.

- [ ] **Step 4: Implement the helpers.**
  Create `src/lib/month-totals.ts`:
  ```ts
  import { toCents } from "./currency";

  export interface MonthTotal {
    month: string;
    totalAmount: string;
  }

  export interface PayerMonthTotal {
    payerId: number;
    month: string;
    totalAmount: string;
  }

  /** "2026-06" for a stored expense date. Dates are written at local noon (T12:00:00), so the UTC
   *  calendar month equals the writer's local month for every offset from UTC−11 to UTC+11 — the
   *  same "YYYY-MM" key `groupExpensesByMonth` builds client-side. */
  export function utcMonthKey(date: Date): string {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  const centsToAmount = (cents: number) => (cents / 100).toFixed(2);

  /** Buckets per-(payer, date) Decimal sums into exact per-month and per-payer-month totals (B5).
   *  All arithmetic is integer cents; the output keeps the API's decimal-string money format. */
  export function bucketMonthTotals(
    rows: readonly { payerId: number; date: Date; amount: { toString(): string } | null }[]
  ): { monthTotals: MonthTotal[]; payerMonthTotals: PayerMonthTotal[] } {
    const byMonth = new Map<string, number>();
    const byPayerMonth = new Map<string, { payerId: number; month: string; cents: number }>();
    for (const row of rows) {
      const month = utcMonthKey(row.date);
      const cents = row.amount === null ? 0 : toCents(row.amount);
      byMonth.set(month, (byMonth.get(month) ?? 0) + cents);
      const key = `${row.payerId}|${month}`;
      const entry = byPayerMonth.get(key) ?? { payerId: row.payerId, month, cents: 0 };
      entry.cents += cents;
      byPayerMonth.set(key, entry);
    }
    return {
      monthTotals: [...byMonth].map(([month, cents]) => ({ month, totalAmount: centsToAmount(cents) })),
      payerMonthTotals: [...byPayerMonth.values()].map(({ payerId, month, cents }) => ({
        payerId,
        month,
        totalAmount: centsToAmount(cents),
      })),
    };
  }
  ```
  In `src/lib/expense-month-groups.ts` change the signature and the final `.map` of `groupExpensesByMonth`:
  ```ts
  /** Groups loaded expenses without disturbing their existing order inside each month. A month's
   *  subtotal is the server's full-month total when `monthTotals` has it (B5 — covers pages not yet
   *  loaded), else the exact sum of its loaded expenses. */
  export function groupExpensesByMonth<T extends MonthlyExpenseLike>(
    expenses: readonly T[],
    locale: string,
    monthDirection: "asc" | "desc" = "desc",
    monthTotals?: ReadonlyMap<string, number>
  ): ExpenseMonthGroup<T>[] {
  ```
  ```ts
    return Array.from(groups.values())
      .sort((a, b) => monthDirection === "asc" ? a.key.localeCompare(b.key) : b.key.localeCompare(a.key))
      .map(({ subtotalCents, ...group }) => ({
        ...group,
        subtotal: monthTotals?.get(group.key) ?? subtotalCents / 100,
      }));
  ```
  (Delete the old one-line doc comment above the function; the new one replaces it.)
  In `src/lib/expense-query.ts`: add `includeMonthTotals?: boolean;` to `BuildExpenseQueryParams`, destructure `includeMonthTotals = false` in `buildExpenseQuery`, and right after the `includePayerTotals` line add:
  ```ts
  if (includeMonthTotals) sp.set("includeMonthTotals", "true");
  ```

- [ ] **Step 5: Run them to verify they pass.**
  Run: `npx vitest run src/lib/month-totals.test.ts src/lib/expense-month-groups.test.ts src/lib/expense-query.test.ts`
  Expected: PASS.

- [ ] **Step 6: Write the failing integration test.**
  Append inside `describe("expense list filters + totalAmount aggregate (integration, real pglite DB)", …)` in `src/services/tenant-isolation.test.ts`:
  ```ts
  it("month totals cover every matching expense beyond the loaded page, respect filters and the house (B5)", async () => {
    const { ana, bob, house } = await seedHouseWithVariedExpenses();
    // Seed: Jan 30 (Ana) · Feb 70 (Bob) · Feb 40 (Ana). One more Feb cent-sized expense proves exactness.
    await expenseService.create(house.id, [ana.id, bob.id], {
      payerId: bob.id, description: "Gum", amount: 0.1, date: new Date("2026-02-25T12:00:00"), splitEqually: true,
    });
    // Another house's February expense must never leak into these totals.
    const carol = await prisma.user.create({ data: { publicId: randomUUID(), name: "Carol", username: "carol" } });
    const other = await prisma.group.create({ data: { publicId: randomUUID(), name: "Other" } });
    await prisma.groupMember.create({ data: { userId: carol.id, groupId: other.id, role: "ADMIN", colorIndex: 0 } });
    await expenseService.create(other.id, [carol.id], {
      payerId: carol.id, description: "Foreign", amount: 999, date: new Date("2026-02-15T12:00:00"), splitEqually: true,
    });

    const page1 = await expenseService.list(house.id, {
      page: 1, pageSize: 1, sortField: "date", sortDirection: "desc", includeMonthTotals: true,
    });
    expect(page1.expenses).toHaveLength(1);
    expect(page1.pagination.monthTotals).toHaveLength(2);
    expect(page1.pagination.monthTotals).toEqual(expect.arrayContaining([
      { month: "2026-02", totalAmount: "110.10" },
      { month: "2026-01", totalAmount: "30.00" },
    ]));
    expect(page1.pagination.payerMonthTotals).toHaveLength(3);
    expect(page1.pagination.payerMonthTotals).toEqual(expect.arrayContaining([
      { payerId: ana.id, month: "2026-02", totalAmount: "40.00" },
      { payerId: bob.id, month: "2026-02", totalAmount: "70.10" },
      { payerId: ana.id, month: "2026-01", totalAmount: "30.00" },
    ]));

    const anaOnly = await expenseService.list(house.id, {
      page: 1, pageSize: 1, sortField: "date", sortDirection: "desc", includeMonthTotals: true,
      filters: { payerIds: [ana.id] },
    });
    expect(anaOnly.pagination.monthTotals).toHaveLength(2);
    expect(anaOnly.pagination.monthTotals).toEqual(expect.arrayContaining([
      { month: "2026-02", totalAmount: "40.00" },
      { month: "2026-01", totalAmount: "30.00" },
    ]));

    const plain = await expenseService.list(house.id, listParams);
    expect(plain.pagination).not.toHaveProperty("monthTotals");
    expect(plain.pagination).not.toHaveProperty("payerMonthTotals");
  });
  ```

- [ ] **Step 7: Run it to verify it fails.**
  Run: `npx vitest run src/services/tenant-isolation.test.ts -t "month totals"`
  Expected: FAIL — `monthTotals` is `undefined` (and a TypeScript complaint about `includeMonthTotals` is fine at this point).

- [ ] **Step 8: Implement the service, route and type.**
  `src/services/expense.service.ts`: add `import { bucketMonthTotals } from '@/lib/month-totals'` to the imports; add `includeMonthTotals?: boolean` to `PaginationParams`; in `list` destructure `includeMonthTotals = false`; extend the `Promise.all`:
  ```ts
  const [expenses, total, totalSum, payerTotals, payerDayTotals] = await Promise.all([
    prisma.expense.findMany({
      where,
      omit: legacyOmit,
      include: expenseListInclude,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize
    }),
    prisma.expense.count({ where }),
    prisma.expense.aggregate({ where, _sum: { amount: true } }),
    includePayerTotals
      ? prisma.expense.groupBy({ by: ['payerId'], where, _sum: { amount: true } })
      : Promise.resolve([]),
    // B5: same `where` as the page, so the month totals honor every filter and the house scope.
    // Grouped by (payer, date) because Prisma can't group by a date expression; the rows are
    // bucketed into months in integer cents by bucketMonthTotals.
    includeMonthTotals
      ? prisma.expense.groupBy({ by: ['payerId', 'date'], where, _sum: { amount: true } })
      : Promise.resolve([])
  ])
  ```
  and inside `pagination`, after the `payerTotals` spread:
  ```ts
  ...(includeMonthTotals && bucketMonthTotals(
    payerDayTotals.map(row => ({ payerId: row.payerId, date: row.date, amount: row._sum.amount }))
  ))
  ```
  `src/app/api/expenses/route.ts` (`GET`): after the `includePayerTotals` line add `const includeMonthTotals = searchParams.get('includeMonthTotals') === 'true'` and pass `includeMonthTotals` in the `expenseService.list(...)` options object.
  `src/lib/types.ts` — inside `interface Pagination`, after `payerTotals?`:
  ```ts
  // Opt-in (includeMonthTotals=true, B5): exact per-month totals across the complete filtered
  // result, and the same split per payer for the by-person view.
  monthTotals?: { month: string; totalAmount: Money }[];
  payerMonthTotals?: { payerId: number; month: string; totalAmount: Money }[];
  ```

- [ ] **Step 9: Run it to verify it passes.**
  Run: `npx vitest run src/services/tenant-isolation.test.ts src/services/expense.service.test.ts`
  Expected: PASS (the mocked `expense.service.test.ts` keeps passing: without the flag the 5th entry is `Promise.resolve([])`).

- [ ] **Step 10: Wire the totals through the hook and the page.**
  `src/lib/use-infinite-expenses.ts`:
  ```ts
  type MonthTotals = NonNullable<ExpenseListResponse["pagination"]["monthTotals"]>;
  type PayerMonthTotals = NonNullable<ExpenseListResponse["pagination"]["payerMonthTotals"]>;
  ```
  (top level, after the imports); add `monthTotals: MonthTotals;` and `payerMonthTotals: PayerMonthTotals;` to `UseInfiniteExpensesResult`; add
  ```ts
  const [monthTotals, setMonthTotals] = useState<MonthTotals>([]);
  const [payerMonthTotals, setPayerMonthTotals] = useState<PayerMonthTotals>([]);
  ```
  next to the `payerTotals` state; in `fetchPage`'s success path, after `setPayerTotals(...)`:
  ```ts
  setMonthTotals(res.pagination.monthTotals ?? []);
  setPayerMonthTotals(res.pagination.payerMonthTotals ?? []);
  ```
  in the reset effect, after `setPayerTotals([]);`: `setMonthTotals([]); setPayerMonthTotals([]);`; and add `monthTotals, payerMonthTotals` to the returned object.
  `src/app/(app)/expenses/page.tsx`: add `includeMonthTotals: true` to the `buildExpenseQuery` call in `buildListUrl` and in `buildByPersonUrl` (deps unchanged). After the `payerTotalById` memo add:
  ```tsx
  // B5: month headers show the server's full-month totals (all pages), keyed "YYYY-MM".
  const listMonthTotals = useMemo(
    () => new Map(listState.monthTotals.map((row) => [row.month, money(row.totalAmount)])),
    [listState.monthTotals]
  );
  const payerMonthTotals = useMemo(() => {
    const byPayer = new Map<number, Map<string, number>>();
    for (const row of byPersonState.payerMonthTotals) {
      const months = byPayer.get(row.payerId) ?? new Map<string, number>();
      months.set(row.month, money(row.totalAmount));
      byPayer.set(row.payerId, months);
    }
    return byPayer;
  }, [byPersonState.payerMonthTotals]);
  ```
  In the `byPerson` memo call `groupExpensesByMonth(byPersonExpenses.filter((expense) => expense.payerId === m.id), locale, "desc", payerMonthTotals.get(m.id))` and add `payerMonthTotals` to its deps. In the `listMonths` memo pass `listMonthTotals` as the 4th argument and add it to the deps. The render code (`month.subtotal`, `mg.subtotal`) stays unchanged.

- [ ] **Step 11: Gates.**
  Run: `npx tsc --noEmit` → clean; `npm run test` → all green.

- [ ] **Step 12: Leave changes unstaged** (no commits — the owner commits later on a branch he picks).

---

### Task 2: B9 — an unchecked item with links keeps "Link expenses"

Decision: an item back in "To buy" that still has linked expenses keeps "Link expenses" in its ⋯ menu, so the "N expenses" chip is never a dead end. Today the menu depends only on `isPurchased`, and the service refuses any link change on an unpurchased item (`409 ITEM_NOT_PURCHASED`) — so the guard is relaxed for items that already have links (linking a never-purchased item stays refused).

**Files:**
- Modify: `docs/specs/005-shopping-item-expense-links/requirements.md` (criterion 3), `docs/specs/005-shopping-item-expense-links/tasks.md`
- Modify: `src/services/shopping-item.service.ts` (`replaceExpenseLinks`)
- Test: `src/services/tenant-isolation.test.ts` (describe `"shopping item expense links (integration, real pglite DB)"`)
- Modify: `src/app/(app)/shopping/page.tsx` (`ItemRow` menu)

**Interfaces:**
- Consumes: `shoppingItemService.togglePurchased(groupId, publicId)`, `shoppingItemService.replaceExpenseLinks(groupId, publicId, expensePublicIds)` (signatures unchanged).
- Produces: `replaceExpenseLinks` accepts an unpurchased item that already has ≥1 link; still throws `ApiError(409, 'ITEM_NOT_PURCHASED')` for an unpurchased item with no links.

- [ ] **Step 1: Update spec 005.** In `requirements.md` replace criterion 3 with:
  ```markdown
  3. WHEN an item already has links — purchased, or unchecked again after being linked — THE SYSTEM
     SHALL display their count and allow the member to edit or remove those links.
  ```
  In `tasks.md` append:
  ```markdown
  - [ ] 7. Keep links editable on an item unchecked after linking (B9) — `src/services/shopping-item.service.ts`,
        `src/services/tenant-isolation.test.ts`, `src/app/(app)/shopping/page.tsx` _Requirements: 3_
  ```

- [ ] **Step 2: Write the failing test** (append inside the `"shopping item expense links"` describe):
  ```ts
  it("keeps the links of an item unchecked again editable, so they can be removed (B9)", async () => {
    const { ana, houseA, expA } = await seedTwoHouses();
    const item = await shoppingItemService.create(houseA.id, "Bought then unchecked", ana.id);
    await shoppingItemService.togglePurchased(houseA.id, item.publicId);
    await shoppingItemService.replaceExpenseLinks(houseA.id, item.publicId, [expA.publicId]);
    await shoppingItemService.togglePurchased(houseA.id, item.publicId); // back to "to buy", link kept

    const unlinked = await shoppingItemService.replaceExpenseLinks(houseA.id, item.publicId, []);
    expect(unlinked.isPurchased).toBe(false);
    expect(unlinked.linkedExpenses).toEqual([]);
  });
  ```

- [ ] **Step 3: Run it to verify it fails.**
  Run: `npx vitest run src/services/tenant-isolation.test.ts -t "unchecked again"`
  Expected: FAIL — rejects with `ITEM_NOT_PURCHASED`.

- [ ] **Step 4: Implement.** In `replaceExpenseLinks` replace the item lookup and the purchased guard with:
  ```ts
  const item = await tx.shoppingItem.findFirst({
    where: { publicId, groupId },
    select: { id: true, isPurchased: true, _count: { select: { expenseLinks: true } } },
  })
  if (!item) throw new ApiError('Item not found', 404)
  // B9: an item unchecked after being linked keeps its links editable (view/remove) — otherwise
  // its "N expenses" chip points at links nobody can reach. Linking a never-purchased item stays refused.
  if (!item.isPurchased && item._count.expenseLinks === 0) {
    throw new ApiError('Only purchased items can be linked to expenses', 409, 'ITEM_NOT_PURCHASED')
  }
  ```

- [ ] **Step 5: Run the shopping tests to verify they pass.**
  Run: `npx vitest run src/services/tenant-isolation.test.ts -t "shopping item expense links"`
  Expected: PASS, including the existing `"requires a purchased item before linking"`.

- [ ] **Step 6: Menu.** In `ItemRow` (`src/app/(app)/shopping/page.tsx`), right before its `return (`:
  ```tsx
  // B9: an item unchecked after being linked still has links — keep "Link expenses" so the
  // "N expenses" chip never points at links nobody can see or remove.
  const canLink = item.isPurchased || item.linkedExpenses.length > 0;
  ```
  and replace the two `{item.isPurchased && …}` menu lines with:
  ```tsx
  {canLink && <MenuItem onSelect={onLink}>{t("linkExpensesAction")}</MenuItem>}
  {canLink && <MenuSeparator />}
  ```
  (The "To buy" list already passes `onLink={() => setLinking({ item, justPurchased: false })}`, so the modal opens with "Cancel".)

- [ ] **Step 7: Gates.** `npx tsc --noEmit` clean; `npm run test` green.

- [ ] **Step 8: Leave changes unstaged** (no commits — the owner commits later on a branch he picks).

---

### Task 3: B10 (backend) — promote a member to admin + "only admin" flag

Decision: admins get "Make admin" for non-admin members, backed by `PATCH /api/groups/active/members/[userId]` (only admins; tenant-isolated; audited); the leave-house and delete-account dialogs warn the only admin to promote someone first, using the existing `LAST_ADMIN` rule (`assertCanLeave`). Member changes are audited by the Prisma extension (GroupMember revisions in Activity › Detailed; leave/kick write no Summary entry), so promotion is audited the same way — no `recordActivity` call. Non-trivial feature → spec first.

**Files:**
- Create: `docs/specs/006-promote-admin/requirements.md`, `docs/specs/006-promote-admin/design.md`, `docs/specs/006-promote-admin/tasks.md`
- Modify: `docs/specs/README.md` (index)
- Modify: `src/services/group.service.ts` (new `promoteToAdmin`, `lastAdminGroupIds`)
- Test: `src/services/tenant-isolation.test.ts` (describe `"membership leave/kick (integration, real pglite DB)"`)
- Modify: `src/app/api/groups/active/members/[userId]/route.ts` (new `PATCH`)
- Create: `src/app/api/groups/active/members/[userId]/route.test.ts`
- Modify: `src/app/api/auth/me/route.ts` (`GET` adds `lastAdmin` per group)
- Modify: `src/lib/types.ts` (`MeGroup.lastAdmin`)
- Modify: `src/messages/{en,pt,es,fr}.json` (`ApiErrors.INVALID_ROLE`)

**Interfaces:**
- Produces: `groupService.promoteToAdmin(groupId: number, actorUserId: number, targetPublicId: string): Promise<void>` — throws `ApiError(403, 'NOT_ADMIN')` when the actor is not an active admin of `groupId`; `ApiError(404, 'MEMBER_NOT_FOUND')` when the target has no active membership in `groupId`; no-op when already admin.
- Produces: `groupService.lastAdminGroupIds(userId: number): Promise<number[]>` — houses where `userId` is the only active admin while other active members remain (exactly the `LAST_ADMIN` condition).
- Produces: `PATCH /api/groups/active/members/:publicId` body `{ role: "ADMIN" }` → `200 { ok: true }`; `400` invalid id; `400 INVALID_ROLE`; `403 NOT_ADMIN`; `404 MEMBER_NOT_FOUND`.
- Produces: `GET /api/auth/me` → every `user.groups[i]` gains `lastAdmin: boolean`; `MeGroup.lastAdmin: boolean` (Task 4 reads it).

- [ ] **Step 1: Write spec 006.** Create `docs/specs/006-promote-admin/requirements.md`:
  ```markdown
  # Promote admin — Requirements

  ## Problem

  A house can only gain admins at creation time. The only admin can't leave or delete their account
  while others remain (409 LAST_ADMIN, "promote someone else first"), but the app offers no way to
  promote anyone — a dead end found in round 1 of the UI loop (B10).

  ## User story

  As a house admin, I want to make another member an admin so that the house keeps an admin when I
  leave and admin chores can be shared.

  ## Acceptance criteria (EARS)

  1. WHEN an admin sends `PATCH /api/groups/active/members/{publicId}` with `{ "role": "ADMIN" }` for
     an active non-admin member of the active house, THE SYSTEM SHALL make that member an admin and
     respond 200 `{ "ok": true }`.
  2. WHEN a non-admin sends that request, THE SYSTEM SHALL respond 403 `NOT_ADMIN` and change no role.
  3. WHEN the target is not an active member of the caller's active house (another house's user, an
     ex-member or an unknown id), THE SYSTEM SHALL respond 404 `MEMBER_NOT_FOUND` and change no membership.
  4. WHEN the body's `role` is anything other than `"ADMIN"`, THE SYSTEM SHALL respond 400 `INVALID_ROLE`.
  5. WHEN a member is promoted, THE SYSTEM SHALL record a `GroupMember` UPDATE revision with the actor,
     the house and `after.role = "ADMIN"`.
  6. WHILE the viewer is an admin, THE SYSTEM SHALL offer "Make admin" (with a confirmation) in the ⋯
     menu of every active non-admin member on the House page.
  7. WHEN `GET /api/auth/me` responds, THE SYSTEM SHALL include `lastAdmin` per house, true exactly
     when the user is that house's only active admin and other active members remain.
  8. WHILE `lastAdmin` is true for the active house, THE SYSTEM SHALL show "make another member an
     admin first" in the leave-house dialog and disable Leave; WHILE it is true for any house, THE
     SYSTEM SHALL name those houses in the delete-account dialog and disable Delete.

  ## Out of scope

  - Demoting an admin or transferring ownership.
  - A Summary (AuditLog) entry for role changes — leave/kick have none either; the Detailed trail has it.
  ```
  Create `docs/specs/006-promote-admin/design.md`:
  ```markdown
  # Promote admin — Design

  ## Approach

  `groupService.promoteToAdmin(groupId, actorUserId, targetPublicId)` re-reads the actor's membership
  (must be an active ADMIN of `groupId`) and resolves the target by publicId AND an active membership
  in the same `groupId`, so another house's user is indistinguishable from an unknown id (404). The
  role write is a single `prisma.groupMember.update`, which the audit extension records as a
  `GroupMember` UPDATE revision (ADR 0005). `groupService.lastAdminGroupIds(userId)` reuses the
  private `assertCanLeave` per active ADMIN membership, so the warning and the server refusal can
  never disagree.

  ## Data model

  None (`GroupMember.role` already exists).

  ## API contract

  - `PATCH /api/groups/active/members/:publicId` body `{ "role": "ADMIN" }` → `200 { ok: true }`.
    Errors: `400` (invalid id), `400 INVALID_ROLE`, `403 NOT_ADMIN`, `404 MEMBER_NOT_FOUND`. The house
    is the active-house cookie validated by `requireActiveGroup`; nothing house-related is read from the body.
  - `GET /api/auth/me`: each `user.groups[i]` gains `lastAdmin: boolean`.

  ## UI

  House page: the admin's ⋯ menu on a non-admin member gets "Make admin" above "Remove", with a
  confirmation dialog (there is no demotion in the app). Leave-house dialog: warning + Leave disabled
  when `activeGroup.lastAdmin`. Account › Delete account dialog: warning naming every house with
  `lastAdmin` + Delete disabled. New keys in `Household`, `Account`, `ApiErrors` (4 locales).

  ## Error handling & edge cases

  - Promoting someone who is already an admin is a no-op 200 (idempotent double tap).
  - The ⋯ trigger label becomes "Actions for {name}" since the menu has two items.
  - After a promotion the client reloads the session and the members, so `lastAdmin` updates.

  ## Alternatives considered

  - Computing "only admin" on the client from the members list — rejected: delete-account spans
    every house and the server already owns the rule (`assertCanLeave`).
  - Generic role PATCH with demotion — rejected: not requested; demotion needs its own last-admin rules.
  ```
  Create `docs/specs/006-promote-admin/tasks.md`:
  ```markdown
  # Promote admin — Tasks

  - [ ] 1. Service: `promoteToAdmin` + `lastAdminGroupIds` with pglite tests (promote + revision,
        non-admin 403, other house 404, ex-member 404, last-admin flag) — `src/services/group.service.ts`,
        `src/services/tenant-isolation.test.ts` _Requirements: 1, 2, 3, 5, 7_
  - [ ] 2. Route `PATCH` + route tests — `src/app/api/groups/active/members/[userId]/route.ts`,
        `src/app/api/groups/active/members/[userId]/route.test.ts` _Requirements: 1, 2, 3, 4_
  - [ ] 3. `lastAdmin` on `/api/auth/me` — `src/app/api/auth/me/route.ts`, `src/lib/types.ts` _Requirements: 7_
  - [ ] 4. House menu + confirmation, leave and delete-account warnings, i18n (4 locales) —
        `src/app/(app)/house/page.tsx`, `src/app/(app)/account/page.tsx`, `src/messages/*.json` _Requirements: 6, 8_
  - [ ] 5. Verify: `npx tsc --noEmit` + `npm run test` green; criteria 6 and 8 checked in round 2 of
        the UI loop (journey J6).
  ```
  In `docs/specs/README.md` append to the Index: `- [006 — Promote admin](006-promote-admin/requirements.md)`.

- [ ] **Step 2: Write the failing service tests** (append inside the `"membership leave/kick"` describe; it already has `seedHouse`):
  ```ts
  it("promoteToAdmin: an admin promotes an active member, recorded as a GroupMember revision (spec 006)", async () => {
    const { users: [admin, member], house } = await seedHouse(["ADMIN", "MEMBER"]);
    await runWithAuditContext({ actorId: admin.id, groupId: house.id }, () =>
      groupService.promoteToAdmin(house.id, admin.id, member.publicId)
    );
    await flushAudit();
    const row = await prisma.groupMember.findUnique({ where: { userId_groupId: { userId: member.id, groupId: house.id } } });
    expect(row!.role).toBe("ADMIN");
    const rev = await prisma.entityRevision.findFirst({
      where: { entityType: "GroupMember", entityId: String(row!.id), action: "UPDATE" },
    });
    expect(rev).not.toBeNull();
    expect(rev!.groupId).toBe(house.id);
    expect(rev!.actorId).toBe(admin.id);
    expect((rev!.after as Record<string, unknown>).role).toBe("ADMIN");
  });

  it("promoteToAdmin: a non-admin is refused with 403 NOT_ADMIN and nothing changes", async () => {
    const { users: [, member, other], house } = await seedHouse(["ADMIN", "MEMBER", "MEMBER"]);
    await expect(groupService.promoteToAdmin(house.id, member.id, other.publicId))
      .rejects.toMatchObject({ status: 403, code: "NOT_ADMIN" });
    const row = await prisma.groupMember.findUnique({ where: { userId_groupId: { userId: other.id, groupId: house.id } } });
    expect(row!.role).toBe("MEMBER");
  });

  it("promoteToAdmin: a user of another house is 404 MEMBER_NOT_FOUND (tenant isolation)", async () => {
    const { users: [admin], house } = await seedHouse(["ADMIN", "MEMBER"]);
    const outsider = await prisma.user.create({ data: { publicId: randomUUID(), name: "Out", username: "out-mem" } });
    const otherHouse = await prisma.group.create({ data: { publicId: randomUUID(), name: "Other House" } });
    await prisma.groupMember.create({ data: { userId: outsider.id, groupId: otherHouse.id, role: "MEMBER", colorIndex: 0 } });
    await expect(groupService.promoteToAdmin(house.id, admin.id, outsider.publicId))
      .rejects.toMatchObject({ status: 404, code: "MEMBER_NOT_FOUND" });
    const row = await prisma.groupMember.findUnique({ where: { userId_groupId: { userId: outsider.id, groupId: otherHouse.id } } });
    expect(row!.role).toBe("MEMBER");
  });

  it("promoteToAdmin: an ex-member is 404 MEMBER_NOT_FOUND", async () => {
    const { users: [admin, member], house } = await seedHouse(["ADMIN", "MEMBER"]);
    await groupService.removeMember(house.id, member.id);
    await expect(groupService.promoteToAdmin(house.id, admin.id, member.publicId))
      .rejects.toMatchObject({ status: 404, code: "MEMBER_NOT_FOUND" });
  });

  it("lastAdminGroupIds: flags the only admin with other members, clears after a promotion, ignores a solo house", async () => {
    const { users: [admin, member], house } = await seedHouse(["ADMIN", "MEMBER"]);
    const solo = await prisma.group.create({ data: { publicId: randomUUID(), name: "Solo" } });
    await prisma.groupMember.create({ data: { userId: admin.id, groupId: solo.id, role: "ADMIN", colorIndex: 0 } });
    expect(await groupService.lastAdminGroupIds(admin.id)).toEqual([house.id]);
    await groupService.promoteToAdmin(house.id, admin.id, member.publicId);
    expect(await groupService.lastAdminGroupIds(admin.id)).toEqual([]);
  });
  ```

- [ ] **Step 3: Run them to verify they fail.**
  Run: `npx vitest run src/services/tenant-isolation.test.ts -t "promoteToAdmin|lastAdminGroupIds"`
  Expected: FAIL — `groupService.promoteToAdmin is not a function`.

- [ ] **Step 4: Implement the service.** In `src/services/group.service.ts`, inside `class GroupService` after `assertCanLeaveAllHouses`:
  ```ts
  /**
   * Admin makes another active member of the same house an admin (spec 006). The actor is
   * re-checked here (403 NOT_ADMIN) and the target is resolved by publicId AND an active membership
   * in `groupId`, so another house's user or an ex-member is a 404 — tenant isolation by
   * construction. Idempotent for someone who is already an admin. The audit extension records the
   * GroupMember UPDATE revision (ADR 0005).
   */
  async promoteToAdmin(groupId: number, actorUserId: number, targetPublicId: string): Promise<void> {
    const actor = await prisma.groupMember.findUnique({
      where: { userId_groupId: { userId: actorUserId, groupId } },
      select: { role: true, leftAt: true },
    })
    if (!actor || actor.leftAt !== null || actor.role !== 'ADMIN') {
      throw new ApiError('Only the house admin can change roles', 403, 'NOT_ADMIN')
    }
    const target = await prisma.groupMember.findFirst({
      where: { groupId, leftAt: null, user: { publicId: targetPublicId } },
      select: { id: true, role: true },
    })
    if (!target) {
      throw new ApiError('This person is no longer a member of this house', 404, 'MEMBER_NOT_FOUND')
    }
    if (target.role === 'ADMIN') return
    await prisma.groupMember.update({ where: { id: target.id }, data: { role: 'ADMIN' } })
  }

  /** Houses where `userId` is the only active admin while other active members remain — exactly
   *  what assertCanLeave refuses with LAST_ADMIN. Drives the "make another member an admin first"
   *  warning in the leave-house and delete-account dialogs (spec 006). */
  async lastAdminGroupIds(userId: number): Promise<number[]> {
    const memberships = await prisma.groupMember.findMany({
      where: { userId, leftAt: null, role: 'ADMIN' },
      select: { groupId: true },
    })
    const blocked: number[] = []
    for (const m of memberships) {
      try {
        await this.assertCanLeave(m.groupId, userId)
      } catch (e) {
        if (e instanceof ApiError && e.code === 'LAST_ADMIN') blocked.push(m.groupId)
        else throw e
      }
    }
    return blocked
  }
  ```

- [ ] **Step 5: Run them to verify they pass.**
  Run: `npx vitest run src/services/tenant-isolation.test.ts -t "membership leave/kick"`
  Expected: PASS (new and existing membership tests).

- [ ] **Step 6: Write the failing route test.** Create `src/app/api/groups/active/members/[userId]/route.test.ts`:
  ```ts
  import { describe, it, expect, vi, beforeEach } from "vitest";
  import { randomUUID } from "node:crypto";
  import { NextResponse } from "next/server";
  import { ApiError } from "@/lib/errors";

  const { mockRequireActiveGroup, mockPromoteToAdmin } = vi.hoisted(() => ({
    mockRequireActiveGroup: vi.fn(),
    mockPromoteToAdmin: vi.fn(),
  }));
  vi.mock("@/lib/api-helpers", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/api-helpers")>();
    return { ...actual, requireActiveGroup: mockRequireActiveGroup };
  });
  vi.mock("@/services/group.service", () => ({ groupService: { promoteToAdmin: mockPromoteToAdmin } }));

  import { PATCH } from "./route";

  const session = { userId: 1, publicId: "actor", name: "Ana", sessionVersion: 1, iat: 0 };
  const call = (id: string, body: unknown) =>
    PATCH(
      new Request(`http://localhost/api/groups/active/members/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
      { params: Promise.resolve({ userId: id }) }
    );

  beforeEach(() => {
    vi.resetAllMocks();
    mockRequireActiveGroup.mockResolvedValue({ ok: true, session, groupId: 7, role: "ADMIN" });
  });

  describe("PATCH /api/groups/active/members/[userId] — make admin (spec 006)", () => {
    it("promotes through the service, scoped to the active house and the caller", async () => {
      const target = randomUUID();
      const res = await call(target, { role: "ADMIN" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(mockPromoteToAdmin).toHaveBeenCalledWith(7, 1, target);
    });

    it("returns the session/house failure untouched", async () => {
      mockRequireActiveGroup.mockResolvedValue({
        ok: false,
        response: NextResponse.json({ code: "NOT_AUTHENTICATED" }, { status: 401 }),
      });
      const res = await call(randomUUID(), { role: "ADMIN" });
      expect(res.status).toBe(401);
      expect(mockPromoteToAdmin).not.toHaveBeenCalled();
    });

    it("rejects a malformed member id with 400", async () => {
      const res = await call("not-a-uuid", { role: "ADMIN" });
      expect(res.status).toBe(400);
      expect(mockPromoteToAdmin).not.toHaveBeenCalled();
    });

    it("rejects any role other than ADMIN with 400 INVALID_ROLE", async () => {
      const res = await call(randomUUID(), { role: "MEMBER" });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("INVALID_ROLE");
      expect(mockPromoteToAdmin).not.toHaveBeenCalled();
    });

    it("maps the service's NOT_ADMIN refusal to 403", async () => {
      mockPromoteToAdmin.mockRejectedValue(new ApiError("Only the house admin can change roles", 403, "NOT_ADMIN"));
      const res = await call(randomUUID(), { role: "ADMIN" });
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("NOT_ADMIN");
    });

    it("maps the service's cross-house MEMBER_NOT_FOUND to 404", async () => {
      mockPromoteToAdmin.mockRejectedValue(new ApiError("This person is no longer a member of this house", 404, "MEMBER_NOT_FOUND"));
      const res = await call(randomUUID(), { role: "ADMIN" });
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe("MEMBER_NOT_FOUND");
    });
  });
  ```

- [ ] **Step 7: Run it to verify it fails.**
  Run: `npx vitest run src/app/api/groups/active/members`
  Expected: FAIL — `PATCH` is not exported.

- [ ] **Step 8: Implement the route.** In `src/app/api/groups/active/members/[userId]/route.ts` add after `DELETE`:
  ```ts
  /**
   * Admin makes another active member of the active house an admin (spec 006 — "Make admin").
   * Only `{ role: "ADMIN" }` is accepted (no demotion). The service re-checks that the caller is an
   * admin and resolves the target inside the active house only (404 otherwise); the role change is
   * audited by the Prisma extension. `userId` is the target's publicId (UUID).
   */
  export async function PATCH(request: Request, { params }: RouteParams) {
    try {
      const check = await requireActiveGroup()
      if (!check.ok) return check.response

      const { userId: targetPublicId } = await params
      if (!isValidUUID(targetPublicId)) {
        return NextResponse.json({ error: 'Invalid ID' }, { status: 400 })
      }
      const body = await request.json().catch(() => null)
      if (!body || body.role !== 'ADMIN') {
        return NextResponse.json({ error: 'Only promotion to ADMIN is supported', code: 'INVALID_ROLE' }, { status: 400 })
      }

      await groupService.promoteToAdmin(check.groupId, check.session.userId, targetPublicId)
      return NextResponse.json({ ok: true })
    } catch (error) {
      return handleApiError(error, 'Failed to change member role')
    }
  }
  ```

- [ ] **Step 9: Run it to verify it passes.**
  Run: `npx vitest run src/app/api/groups/active/members`
  Expected: PASS (6 tests).

- [ ] **Step 10: `lastAdmin` on `/api/auth/me`.** In `src/app/api/auth/me/route.ts` add `import { groupService } from '@/services/group.service'` and replace the body of `GET` after the `if (!user)` block with:
  ```ts
  // spec 006: flag the houses this user can't leave yet (only admin with other members), so the
  // leave-house and delete-account dialogs can warn before the server refuses with LAST_ADMIN.
  const lastAdminIds = new Set(await groupService.lastAdminGroupIds(user.id))
  const groups = user.groups.map(g => ({ ...g, lastAdmin: lastAdminIds.has(g.id) }))

  const cookieStore = await cookies()
  const preferredGroupId = Number(cookieStore.get(GROUP_COOKIE)?.value) || null
  const activeGroup =
    groups.find(g => g.id === preferredGroupId) ?? groups[0] ?? null

  return NextResponse.json({ user: { ...user, groups }, activeGroupId: activeGroup?.id ?? null })
  ```
  In `src/lib/types.ts` add to `interface MeGroup`:
  ```ts
  // spec 006: the user is this house's only active admin while others remain — leaving (or
  // deleting the account) is refused with LAST_ADMIN until someone else is made admin.
  lastAdmin: boolean;
  ```

- [ ] **Step 11: Messages.** Inside `"ApiErrors"` add `INVALID_ROLE`:
  - en: `"INVALID_ROLE": "This role change isn't supported"`
  - pt: `"INVALID_ROLE": "Essa mudança de papel não é permitida"`
  - es: `"INVALID_ROLE": "Ese cambio de rol no está permitido"`
  - fr: `"INVALID_ROLE": "Ce changement de rôle n'est pas pris en charge"`

- [ ] **Step 12: Gates.** `npx tsc --noEmit` clean; `npm run test` green; i18n parity check prints `i18n parity OK`.

- [ ] **Step 13: Leave changes unstaged** (no commits — the owner commits later on a branch he picks).

---

### Task 4: B10 (UI) — "Make admin", leave and delete-account warnings

**Files:**
- Modify: `src/app/(app)/house/page.tsx` (state, `onPromote`, members ⋯ menu, new confirm modal, leave modal)
- Modify: `src/app/(app)/account/page.tsx` (`AccountPage`, `DeleteAccountSection`)
- Modify: `src/messages/{en,pt,es,fr}.json` (`Household`, `Account`)

**Interfaces:**
- Consumes: `PATCH /api/groups/active/members/:publicId` `{ role: "ADMIN" }` (Task 3); `MeGroup.lastAdmin: boolean` (Task 3); `useSession()` → `refresh`, `refreshMembers`, `activeGroup`, `me`.
- Produces: `DeleteAccountSection({ hasPassword, lastAdminHouses }: { hasPassword: boolean; lastAdminHouses: string[] })`.

- [ ] **Step 1: Messages.** Inside `"Household"` add:
  - en:
    ```json
    "makeAdmin": "Make admin",
    "makeAdminConfirmTitle": "Make {name} an admin?",
    "makeAdminConfirmPrompt": "Admins can remove members, change the currency and regenerate the house code. This can't be undone in the app.",
    "makeAdminSuccess": "{name} is now an admin",
    "makeAdminError": "Couldn't make this member an admin",
    "memberActions": "Actions for {name}",
    "lastAdminWarning": "You're this house's only admin — make another member an admin first"
    ```
  - pt:
    ```json
    "makeAdmin": "Tornar admin",
    "makeAdminConfirmTitle": "Tornar {name} admin?",
    "makeAdminConfirmPrompt": "Admins podem remover membros, mudar a moeda e gerar um novo código da casa. Isso não pode ser desfeito no app.",
    "makeAdminSuccess": "{name} agora é admin",
    "makeAdminError": "Não foi possível tornar este membro admin",
    "memberActions": "Ações para {name}",
    "lastAdminWarning": "Você é o único admin desta casa — torne outro membro admin antes"
    ```
  - es:
    ```json
    "makeAdmin": "Hacer admin",
    "makeAdminConfirmTitle": "¿Hacer admin a {name}?",
    "makeAdminConfirmPrompt": "Los admins pueden quitar miembros, cambiar la moneda y generar un nuevo código de la casa. Esto no se puede deshacer en la app.",
    "makeAdminSuccess": "{name} ahora es admin",
    "makeAdminError": "No se pudo hacer admin a este miembro",
    "memberActions": "Acciones para {name}",
    "lastAdminWarning": "Eres el único admin de esta casa — haz admin a otro miembro antes"
    ```
  - fr:
    ```json
    "makeAdmin": "Nommer admin",
    "makeAdminConfirmTitle": "Nommer {name} admin ?",
    "makeAdminConfirmPrompt": "Les admins peuvent retirer des membres, changer la devise et régénérer le code de la maison. Cette action est irréversible dans l'app.",
    "makeAdminSuccess": "{name} est maintenant admin",
    "makeAdminError": "Impossible de nommer ce membre admin",
    "memberActions": "Actions pour {name}",
    "lastAdminWarning": "Vous êtes le seul admin de cette maison — nommez d'abord un autre membre admin"
    ```
  Inside `"Account"` add `deleteAccountLastAdmin`:
  - en: `"You're the only admin of {houses} — make another member an admin there first"`
  - pt: `"Você é o único admin de {houses} — torne outro membro admin lá antes"`
  - es: `"Eres el único admin de {houses} — haz admin a otro miembro allí antes"`
  - fr: `"Vous êtes le seul admin de {houses} — nommez d'abord un autre membre admin"`

- [ ] **Step 2: House — state and handler.** In `src/app/(app)/house/page.tsx` import `MenuSeparator` (`import { Menu, MenuItem, MenuSeparator } from "@/components/ui/Menu";`). After the `removing` state add:
  ```tsx
  // Make admin (spec 006) — confirmation first: the app has no way to undo a promotion.
  const [promoteTarget, setPromoteTarget] = useState<Member | null>(null);
  const [promoting, setPromoting] = useState(false);
  ```
  After `onRemove` add:
  ```tsx
  async function onPromote() {
    if (!promoteTarget) return;
    setPromoting(true);
    try {
      await api.patch(`/api/groups/active/members/${promoteTarget.publicId}`, { role: "ADMIN" });
      toast(t("makeAdminSuccess", { name: promoteTarget.name }), "success");
      setPromoteTarget(null);
      await Promise.all([refresh(), refreshMembers()]);
    } catch (err) {
      toast(apiErr(err, t("makeAdminError")), "error");
    } finally {
      setPromoting(false);
    }
  }
  ```

- [ ] **Step 3: House — member menu.** In the `isAdmin ?` branch of the active-members list change the trigger `aria-label` to `t("memberActions", { name: m.name })` and the menu children to:
  ```tsx
  {m.role !== "ADMIN" && (
    <>
      <MenuItem onSelect={() => setPromoteTarget(m)}>{t("makeAdmin")}</MenuItem>
      <MenuSeparator />
    </>
  )}
  <MenuItem danger onSelect={() => setRemoveTarget(m)}>
    {t("remove")}
  </MenuItem>
  ```

- [ ] **Step 4: House — confirm modal and leave warning.** After the "Remove member confirm" `<Modal>` add:
  ```tsx
  {/* Make admin confirm (spec 006) */}
  <Modal
    open={promoteTarget !== null}
    onOpenChange={(o) => !o && !promoting && setPromoteTarget(null)}
    title={promoteTarget ? t("makeAdminConfirmTitle", { name: promoteTarget.name }) : ""}
    footer={
      <>
        <Button variant="ghost" onClick={() => setPromoteTarget(null)} disabled={promoting}>
          {tc("cancel")}
        </Button>
        <Button loading={promoting} onClick={onPromote}>
          {t("makeAdmin")}
        </Button>
      </>
    }
  >
    <p className="text-sm text-ink">{t("makeAdminConfirmPrompt")}</p>
  </Modal>
  ```
  In the "Leave house confirm" modal: add `disabled={activeGroup.lastAdmin}` to the danger `Leave` button and replace its body `<p className="text-sm text-ink">{t("leaveConfirmPrompt")}</p>` with:
  ```tsx
  <div className="flex flex-col gap-3">
    {/* spec 006: the server would refuse with LAST_ADMIN — say why up front (U18 warning style). */}
    {activeGroup.lastAdmin && (
      <p className="rounded-md bg-stamp-soft px-3 py-2 text-sm text-ink">{t("lastAdminWarning")}</p>
    )}
    <p className="text-sm text-ink">{t("leaveConfirmPrompt")}</p>
  </div>
  ```

- [ ] **Step 5: Account — delete-account warning.** In `AccountPage` replace `<DeleteAccountSection hasPassword={me.user.hasPassword} />` with:
  ```tsx
  <DeleteAccountSection
    hasPassword={me.user.hasPassword}
    lastAdminHouses={me.user.groups.filter((g) => g.lastAdmin).map((g) => g.name)}
  />
  ```
  Change the signature to `function DeleteAccountSection({ hasPassword, lastAdminHouses }: { hasPassword: boolean; lastAdminHouses: string[] })`, add `const blockedByLastAdmin = lastAdminHouses.length > 0;` after the state hooks, change the confirm button's `disabled` to `disabled={blockedByLastAdmin || (hasPassword && !currentPassword)}`, and insert as the first child of the modal body `<div className="flex flex-col gap-3">`:
  ```tsx
  {blockedByLastAdmin && (
    <p className="rounded-md bg-stamp-soft px-3 py-2 text-sm text-ink">
      {t("deleteAccountLastAdmin", { houses: lastAdminHouses.join(", ") })}
    </p>
  )}
  ```

- [ ] **Step 6: Gates.** `npx tsc --noEmit` clean; `npx eslint src` no new errors; `npm run test` green; i18n parity OK.

- [ ] **Step 7: Loop checks for Task 12 (J6):** admin ⋯ on a member shows "Make admin" → confirm → tag becomes ADMIN; the only admin's leave dialog shows the warning with Leave disabled; Account › Delete account names the house.

- [ ] **Step 8: Leave changes unstaged** (no commits — the owner commits later on a branch he picks).

---

### Task 5: Deferred 1 — purchase toggles appear in Activity › Detailed

`togglePurchased` flips the flag with an atomic `$executeRaw` that bypasses the audit extension (`$allOperations` wraps model operations only), so no revision is written. Keep the atomic statement, return the post-row with `RETURNING *`, and write the revision explicitly — with `before`, so Detailed can show "purchased: No → Yes".

**Files:**
- Modify: `src/lib/prisma-audit.ts` (export `sanitize`)
- Modify: `src/services/shopping-item.service.ts` (`togglePurchased`)
- Modify: `src/app/api/shopping-items/[itemId]/toggle/route.ts`
- Modify: `src/app/(app)/activity/page.tsx` (`DetailedFeed` value cell)
- Test: `src/services/tenant-isolation.test.ts` (describe `"shopping item expense links (integration, real pglite DB)"`)

**Interfaces:**
- Produces: `export function sanitize(value: unknown): unknown` from `src/lib/prisma-audit.ts` (unchanged body).
- Produces: `shoppingItemService.togglePurchased(groupId: number, publicId: string, actorId: number | null = null)` — same return value as before; writes one `EntityRevision` (`entityType: "ShoppingItem"`, `action: "UPDATE"`, `before` and `after` snapshots).
- Produces: `import { revisionService } from "@/services/revision.service";` added to `tenant-isolation.test.ts` (Task 6 reuses it).

- [ ] **Step 1: Write the failing test.** Add `import { revisionService } from "@/services/revision.service";` to the imports of `src/services/tenant-isolation.test.ts`, then append inside the `"shopping item expense links"` describe:
  ```ts
  it("togglePurchased writes an UPDATE revision with before/after despite the atomic raw update (Deferred 1)", async () => {
    const { ana, houseA } = await seedTwoHouses();
    const item = await shoppingItemService.create(houseA.id, "Milk", ana.id);
    await shoppingItemService.togglePurchased(houseA.id, item.publicId, ana.id);
    await flushAudit();

    const revs = await prisma.entityRevision.findMany({
      where: { entityType: "ShoppingItem", entityId: String(item.id), action: "UPDATE" },
    });
    expect(revs).toHaveLength(1);
    expect(revs[0].groupId).toBe(houseA.id);
    expect(revs[0].actorId).toBe(ana.id);
    expect((revs[0].before as Record<string, unknown>).isPurchased).toBe(false);
    expect((revs[0].after as Record<string, unknown>).isPurchased).toBe(true);

    const feed = await revisionService.listForGroup(houseA.id, { entityType: "ShoppingItem" });
    expect(feed.some((r) => r.action === "UPDATE" && r.after?.isPurchased === true)).toBe(true);
  });
  ```

- [ ] **Step 2: Run it to verify it fails.**
  Run: `npx vitest run src/services/tenant-isolation.test.ts -t "togglePurchased writes"`
  Expected: FAIL — 0 UPDATE revisions.

- [ ] **Step 3: Implement.** In `src/lib/prisma-audit.ts` change `function sanitize(` to `export function sanitize(` and prepend to its doc comment: `Exported for the few writes the extension cannot see (raw SQL), which record their revision explicitly.`
  In `src/services/shopping-item.service.ts` add `import { sanitize } from '@/lib/prisma-audit'`, add below `type ItemWithLinks`:
  ```ts
  // Row shape returned by the raw toggle's RETURNING * (ShoppingItem's own columns).
  type ShoppingItemRow = {
    id: number
    publicId: string
    groupId: number
    name: string
    isPurchased: boolean
    createdAt: Date
    addedById: number | null
  }
  ```
  and replace `togglePurchased` with:
  ```ts
  async togglePurchased(groupId: number, publicId: string, actorId: number | null = null) {
    const item = await this.findOwned(groupId, publicId)

    // Flip in the DB (SET comprado = NOT comprado) rather than reading the value into JS and
    // writing back its negation — the read-modify-write version loses updates when two people
    // tap the same checkbox at once (found in QA). The NOT is evaluated atomically under the
    // row lock, so N concurrent toggles land on the correct final state.
    const [row] = await prisma.$queryRaw<ShoppingItemRow[]>`UPDATE "ShoppingItem" SET "isPurchased" = NOT "isPurchased" WHERE id = ${item.id} RETURNING *`

    // Raw SQL bypasses the audit extension ($allOperations wraps model operations only, ADR 0005),
    // so the revision Activity › Detailed reads is written here. `before` is exact: the statement
    // changed nothing but isPurchased.
    await prisma.entityRevision.create({
      data: {
        entityType: 'ShoppingItem',
        entityId: String(row.id),
        groupId: row.groupId,
        action: 'UPDATE',
        actorId,
        before: sanitize({ ...row, isPurchased: !row.isPurchased }) as Prisma.InputJsonValue,
        after: sanitize(row) as Prisma.InputJsonValue,
      },
    })

    const updated = await prisma.shoppingItem.findFirstOrThrow({
      where: { id: item.id },
      include: itemInclude,
    })
    return serializeItem(updated)
  }
  ```
  In `src/app/api/shopping-items/[itemId]/toggle/route.ts` change the call to `shoppingItemService.togglePurchased(check.groupId, itemId, check.session.userId)`.

- [ ] **Step 4: Run it to verify it passes.**
  Run: `npx vitest run src/services/tenant-isolation.test.ts`
  Expected: PASS (all describes; the other `togglePurchased` callers omit `actorId`).

- [ ] **Step 5: Detailed shows old → new when a revision carries `before`.** In `DetailedFeed` (`src/app/(app)/activity/page.tsx`), inside `revisions.map((r, i) => {`, after `const fields = snapshotFields(r);` add:
  ```tsx
  // An UPDATE written with an explicit `before` (the purchase toggle) shows "old → new"; the
  // extension's UPDATEs carry no `before` and keep showing the snapshot value.
  const prev = r.action === "UPDATE" && r.before ? (r.before as Record<string, unknown>) : null;
  ```
  and replace the `<dd …>{renderValue(f, snap[f])}</dd>` content with:
  ```tsx
  <dd className="min-w-0 break-words text-xs text-ink-soft">
    {prev && JSON.stringify(prev[f]) !== JSON.stringify(snap[f]) ? (
      <>
        <span className="line-through">{renderValue(f, prev[f])}</span>
        {" → "}
        {renderValue(f, snap[f])}
      </>
    ) : (
      renderValue(f, snap[f])
    )}
  </dd>
  ```

- [ ] **Step 6: Gates.** `npx tsc --noEmit` clean; `npx eslint src` no new errors; `npm run test` green.

- [ ] **Step 7: Loop check for Task 12 (J7):** after checking an item, Activity › Detailed › Shopping item lists "updated a shopping item" with "purchased: ~~No~~ → Yes".

- [ ] **Step 8: Leave changes unstaged** (no commits — the owner commits later on a branch he picks).

---

### Task 6: Deferred 2 — "House" filter in Activity › Detailed

Findings while planning (verified on the QA DB): `Group` revisions are stored with `groupId = NULL` (the Group row has no `groupId` column and the ALS context does not reach the extension), so house-level changes (currency, code) never appear in the Detailed feed; and `GET /api/revisions` has its own allow-list that lacks `GroupMember`, so the existing "Membership" chip is silently ignored (returns every entity). Fix: scope Group revisions by the row's own id, never store the join code in a snapshot (non-admins can read the feed), share one entity-type list between route and page, and add the "House" chip.

**Files:**
- Modify: `src/lib/constants.ts` (new `REVISION_ENTITY_TYPES`)
- Modify: `src/app/api/revisions/route.ts` (`FILTERABLE`)
- Modify: `src/lib/prisma-audit.ts` (`pickGroupId`, `SENSITIVE_FIELDS`)
- Modify: `src/app/(app)/activity/page.tsx` (`ENTITY_TYPES`, `SNAPSHOT_FIELDS`)
- Modify: `src/messages/{en,pt,es,fr}.json` (`Activity.entity.Group`, `Activity.entityArticle.Group`)
- Test: `src/services/tenant-isolation.test.ts` (describe `"audit trail / EntityRevision (integration, real pglite DB)"`)

**Interfaces:**
- Consumes: `revisionService` import in the test file (Task 5).
- Produces: `export const REVISION_ENTITY_TYPES = ["Expense", "Settlement", "ShoppingItem", "Category", "Platform", "PaymentMethod", "GroupMember", "Group"] as const` in `src/lib/constants.ts`; `GET /api/revisions?entityType=Group|GroupMember` now filters.

- [ ] **Step 1: Write the failing test** (append inside the `"audit trail / EntityRevision"` describe):
  ```ts
  it("a Group revision is scoped to the house itself and never stores the join code (Deferred 2)", async () => {
    const g = await prisma.group.create({ data: { publicId: randomUUID(), name: "Scoped", joinCode: "ABC123" } });
    await prisma.group.update({ where: { id: g.id }, data: { currency: "USD" } }); // no audit context
    await flushAudit();

    const revs = await prisma.entityRevision.findMany({ where: { entityType: "Group", entityId: String(g.id) } });
    expect(revs.map((r) => r.action).sort()).toEqual(["CREATE", "UPDATE"]);
    for (const r of revs) {
      expect(r.groupId).toBe(g.id);
      expect((r.after as Record<string, unknown>).joinCode).toBeUndefined();
    }
    const feed = await revisionService.listForGroup(g.id, { entityType: "Group" });
    expect(feed.map((r) => r.action).sort()).toEqual(["CREATE", "UPDATE"]);
  });
  ```

- [ ] **Step 2: Run it to verify it fails.**
  Run: `npx vitest run src/services/tenant-isolation.test.ts -t "Group revision"`
  Expected: FAIL — `groupId` is `null` and `joinCode` is `"ABC123"`.

- [ ] **Step 3: Implement the audit fix.** In `src/lib/prisma-audit.ts`:
  ```ts
  // joinCode grants entry to a house — never copy it into a snapshot (the Detailed feed is readable
  // by every member, while the code itself is admin-only).
  const SENSITIVE_FIELDS = new Set(["password", "joinCode"]);
  ```
  ```ts
  function pickGroupId(model: string, ...rows: Array<{ id?: unknown; groupId?: unknown } | null | undefined>): number | null {
    for (const r of rows) {
      if (!r) continue;
      // A Group row has no groupId column — it IS the tenant, so its own id scopes the revision.
      if (model === "Group" && typeof r.id === "number") return r.id;
      if (typeof r.groupId === "number") return r.groupId;
    }
    return null;
  }
  ```
  and pass `model` as the first argument at all 5 call sites (`pickGroupId(model, row, ctx)`, `pickGroupId(model, data[0], ctx)`, `pickGroupId(model, ctx)`).

- [ ] **Step 4: Run it to verify it passes.**
  Run: `npx vitest run src/services/tenant-isolation.test.ts`
  Expected: PASS (incl. the existing audit-trail tests).

- [ ] **Step 5: One entity-type list for route and chips.** In `src/lib/constants.ts` append:
  ```ts
  // Entity types the Activity "Detailed" feed can filter by (Prisma model names, as stored in
  // EntityRevision.entityType). Shared by GET /api/revisions (allow-list) and the filter chips so the
  // two can't drift — the route's own list once lacked GroupMember and ignored that chip.
  export const REVISION_ENTITY_TYPES = [
    "Expense", "Settlement", "ShoppingItem", "Category", "Platform", "PaymentMethod", "GroupMember", "Group",
  ] as const
  ```
  `src/app/api/revisions/route.ts`: import `REVISION_ENTITY_TYPES` from `@/lib/constants` and replace the `FILTERABLE` line (and its comment) with:
  ```ts
  // Entity types the detailed feed can filter by — same list as the page's chips.
  const FILTERABLE = new Set<string>(REVISION_ENTITY_TYPES)
  ```
  `src/app/(app)/activity/page.tsx`: add `REVISION_ENTITY_TYPES` to the existing `@/lib/constants` import, replace the `ENTITY_TYPES` line with `const ENTITY_TYPES = REVISION_ENTITY_TYPES;`, and add `Group: ["name", "currency"],` to `SNAPSHOT_FIELDS`.

- [ ] **Step 6: Messages.** Inside `"Activity"` → `"entity"` add `"Group"`, and inside `"entityArticle"` add `"Group"`:
  - en: `"Group": "House"` / `"Group": "the house"`
  - pt: `"Group": "Casa"` / `"Group": "a casa"`
  - es: `"Group": "Casa"` / `"Group": "la casa"`
  - fr: `"Group": "Maison"` / `"Group": "la maison"`

- [ ] **Step 7: Gates.** `npx tsc --noEmit` clean; `npm run test` green; i18n parity OK.

- [ ] **Step 8: Loop check for Task 12 (J7):** Detailed shows a "House" chip; after a currency change it lists "updated the house" with Currency; the "Membership" chip lists only membership revisions.

- [ ] **Step 9: Leave changes unstaged** (no commits — the owner commits later on a branch he picks).

---

### Task 7: I7 + I11 — Spanish thousands and one date-time format

Decisions: **I7** money always groups thousands (es `1.234,56`, `useGrouping: "always"`; the amount input mask follows so the field matches the list). **I11** the expense history (detail modal) and Activity show `dd/mm/yyyy HH:mm` (24h) in every locale, from one helper next to `formatDateLocale` in `src/lib/money.ts`.

**Files:**
- Modify: `src/lib/money.ts` (`currencyFormatter`, new `formatDateTimeLocale`) · Test: `src/lib/money.test.ts`
- Modify: `src/lib/format.ts` (`maskAmountInput`)
- Modify: `src/components/expenses/ExpenseDetailModal.tsx` (`ExpenseHistory`)
- Modify: `src/app/(app)/activity/page.tsx` (`SummaryFeed`, `DetailedFeed`, delete `formatWhen`)

**Interfaces:**
- Produces: `export function formatDateTimeLocale(iso: string): string` → `"dd/mm/yyyy HH:mm"` in the viewer's local time; `"—"` for an invalid date.

- [ ] **Step 1: Write the failing tests.** In `src/lib/money.test.ts` add `formatDateTimeLocale` to the `@/lib/money` import, then append:
  ```ts
  describe('formatMoney — thousands always grouped (I7)', () => {
    it('groups a 4-digit amount in es', () => {
      expect(norm(formatMoney(1234.56, 'BRL', 'es'))).toBe('1.234,56 R$')
      expect(norm(formatMoney(1234.56, 'EUR', 'es'))).toBe('1.234,56 €')
    })
    it('the es amount mask groups too, and still round-trips', () => {
      expect(maskAmountInput('123456', 'es')).toBe('1.234,56')
      expect(parseAmountInput('1.234,56', 'es')).toBe(1234.56)
    })
  })

  describe('formatDateTimeLocale — dd/mm/yyyy HH:mm, 24h, any UI language (I11)', () => {
    it('formats an afternoon time on the 24h clock', () =>
      expect(formatDateTimeLocale('2026-07-08T14:05:00')).toBe('08/07/2026 14:05'))
    it('pads midnight', () => expect(formatDateTimeLocale('2026-01-02T00:07:00')).toBe('02/01/2026 00:07'))
    it('returns an em dash for an unparseable date', () => expect(formatDateTimeLocale('nope')).toBe('—'))
  })
  ```
  (The ISO strings have no `Z` on purpose: they parse as local time, so the expected clock is timezone-independent.)

- [ ] **Step 2: Run them to verify they fail.**
  Run: `npx vitest run src/lib/money.test.ts`
  Expected: FAIL — es shows `1234,56 R$`; the mask gives `1234,56`; `formatDateTimeLocale` is not exported.

- [ ] **Step 3: Implement.** In `currencyFormatter` (`src/lib/money.ts`) add `useGrouping: "always"` to BOTH `Intl.NumberFormat` option objects:
  ```ts
  // useGrouping "always" (I7): es/pt CLDR data skips the separator for 4-digit numbers (es
  // "1234,56"); money always shows it ("1.234,56") so amounts line up and read the same everywhere.
  fmt = new Intl.NumberFormat(locale, { style: "currency", currency, useGrouping: "always" });
  ```
  ```ts
  fmt = new Intl.NumberFormat(locale, { style: "currency", currency, currencyDisplay: "narrowSymbol", useGrouping: "always" });
  ```
  After `formatDateLocale` add:
  ```ts
  /** "dd/mm/yyyy HH:mm" on the 24h clock in every UI language (I11) — expense history and Activity.
   *  Same fixed day-month order as formatDateLocale; the clock is the viewer's local time. */
  export function formatDateTimeLocale(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${dateFormatter().format(d)} ${hh}:${mm}`;
  }
  ```
  In `maskAmountInput` (`src/lib/format.ts`) add `useGrouping: "always",` to the `toLocaleString` options (comment: `// I7: same grouping as the displayed money`).

- [ ] **Step 4: Run them to verify they pass.**
  Run: `npx vitest run src/lib/money.test.ts`
  Expected: PASS (incl. the existing pt/en/fr/narrowSymbol cases and the mask round-trip for all 4 locales).

- [ ] **Step 5: Use the helper.** `ExpenseDetailModal.tsx`: add `formatDateTimeLocale` to the `@/lib/money` import; in `ExpenseHistory` delete the `when` function and `const locale = useLocale();`, replace `{when(e.createdAt)}` with `{formatDateTimeLocale(e.createdAt)}`, and drop `useLocale` from the `next-intl` import (it has no other use in the file). `activity/page.tsx`: add `formatDateTimeLocale` to the `@/lib/money` import; in both `SummaryFeed` and `DetailedFeed` replace `const when = (iso: string) => formatWhen(iso, locale);` with `const when = formatDateTimeLocale;`; delete the `formatWhen` function at the end of the file; in `DetailedFeed` delete `const locale = useLocale();` (its only use was `when`; `SummaryFeed` keeps `locale` for money).

- [ ] **Step 6: Gates.** `npx tsc --noEmit` clean; `npx eslint src` no new errors; `npm run test` green.

- [ ] **Step 7: Loop checks for Task 12 (J8 es, J2, J7):** es amounts ≥ 1000 show the "." separator in the list, balances and the amount field; history and Activity timestamps read `dd/mm/yyyy HH:mm` in EN too (no AM/PM).

- [ ] **Step 8: Leave changes unstaged** (no commits — the owner commits later on a branch he picks).

---

### Task 8: U21 — type the percentage next to each slider

Decision: each member's percentage in the custom "%" split gets a keyboard-editable numeric field (0–100) that stays in sync with its slider; the existing sum/validation rules (total must be 100) are unchanged.

**Files:**
- Modify: `src/lib/split.ts` (new `clampPercentInput`) · Test: `src/lib/split.test.ts`
- Modify: `src/components/expenses/ExpenseFormModal.tsx` (percent rows)
- Modify: `src/messages/{en,pt,es,fr}.json` (`Expenses.percentSliderOf`)

**Interfaces:**
- Produces: `export function clampPercentInput(raw: string): number` — integer 0–100; leading digits are parsed (`"07"` → 7, `"3.5"` → 3), anything unparsable → 0.
- Consumes: `setPercentValue(memberId: number, value: number)` (existing, in `ExpenseFormModal`).

- [ ] **Step 1: Write the failing test.** Add `clampPercentInput` to the `@/lib/split` import in `src/lib/split.test.ts` and append:
  ```ts
  describe("clampPercentInput (U21)", () => {
    it("parses typed integers", () => {
      expect(clampPercentInput("42")).toBe(42);
      expect(clampPercentInput("07")).toBe(7);
      expect(clampPercentInput("3.5")).toBe(3);
    });
    it("clamps to 0–100", () => {
      expect(clampPercentInput("150")).toBe(100);
      expect(clampPercentInput("-5")).toBe(0);
    });
    it("treats empty or non-numeric input as 0", () => {
      expect(clampPercentInput("")).toBe(0);
      expect(clampPercentInput("abc")).toBe(0);
    });
  });
  ```

- [ ] **Step 2: Run it to verify it fails.**
  Run: `npx vitest run src/lib/split.test.ts`
  Expected: FAIL — `clampPercentInput` is not exported.

- [ ] **Step 3: Implement** (append to `src/lib/split.ts`):
  ```ts
  /** A typed percentage (U21) as an integer 0–100 — the same domain as the slider next to it. */
  export function clampPercentInput(raw: string): number {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
  }
  ```

- [ ] **Step 4: Run it to verify it passes.**
  Run: `npx vitest run src/lib/split.test.ts`
  Expected: PASS.

- [ ] **Step 5: Messages.** Inside `"Expenses"` add `percentSliderOf` (the number field takes the existing `percentOf` label):
  - en: `"percentSliderOf": "Percentage slider for {name}"`
  - pt: `"percentSliderOf": "Controle deslizante de porcentagem de {name}"`
  - es: `"percentSliderOf": "Control deslizante de porcentaje de {name}"`
  - fr: `"percentSliderOf": "Curseur de pourcentage de {name}"`

- [ ] **Step 6: Form.** In `ExpenseFormModal.tsx` add `clampPercentInput` to the `@/lib/split` import. In the percent rows replace
  ```tsx
  <span className="tnum tabular-nums w-10 text-right text-ink-soft">
    {percent[m.id] ?? 0}%
  </span>
  ```
  with
  ```tsx
  <span className="flex items-center gap-1">
    {/* U21: type the percentage; the slider below stays in sync (same state). text-base below sm
        avoids the iOS zoom-on-focus; min-h-11 is the mobile touch floor. */}
    <input
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      maxLength={3}
      value={String(percent[m.id] ?? 0)}
      onChange={(e) => setPercentValue(m.id, clampPercentInput(e.target.value))}
      onFocus={(e) => e.currentTarget.select()}
      aria-label={t("percentOf", { name: m.name })}
      className="min-h-11 w-12 rounded-md border border-rule bg-card px-1.5 text-right text-base text-ink tnum tabular-nums outline-none focus:border-ink focus:ring-1 focus:ring-ink sm:text-sm md:min-h-0 md:py-1"
    />
    <span className="text-ink-soft" aria-hidden>%</span>
  </span>
  ```
  and change the range input's `aria-label` to `t("percentSliderOf", { name: m.name })`.

- [ ] **Step 7: Gates.** `npx tsc --noEmit` clean; `npx eslint src` no new errors; `npm run test` green; i18n parity OK.

- [ ] **Step 8: Loop check for Task 12 (J2):** in "%" mode, typing 70 in the first field moves its slider to 70 and the total shows 70% + the other share; no `alvoMenor44` for the fields on phones.

- [ ] **Step 9: Leave changes unstaged** (no commits — the owner commits later on a branch he picks).

---

### Task 9: D3 — one page-header pattern

Decision: every page under `src/app/(app)/` has the same header: title (h1) with a subtitle below it, sentence case, no final period on the subtitle.

Inventory (current → change):

| Page | Today | Change |
|---|---|---|
| `account/page.tsx` | uppercase `label-mono` subtitle ABOVE the h1; "Your access details." | `PageHeader`; subtitle below, no period |
| `activity/page.tsx` | same as Account; "Recent changes in this house." | `PageHeader`; no period |
| `balances/page.tsx` | h1 inside the hero card, `label-mono` "House statement" above it, "ACCOUNT" stamp | `PageHeader` above the card (subtitle = `Balances.statement`, stamp in `actions`), also in the loading/unavailable states; hero card keeps only the total row |
| `catalogs/page.tsx` | h1 + `-mt-3` subtitle | `PageHeader`; no period |
| `expenses/page.tsx` | small uppercase toolbar h1 with count + dashed rule; no subtitle | `PageHeader` (title + count, new `Expenses.subtitle`, actions = New expense + ⋮) |
| `house/page.tsx` | h1, no subtitle | `PageHeader` + new `Household.subtitle` |
| `shopping/page.tsx` | h1 + subtitle (already the pattern) | `PageHeader`; no period |

**Files:**
- Create: `src/components/ui/PageHeader.tsx`
- Modify: the 7 pages above
- Modify: `src/messages/{en,pt,es,fr}.json` (values of `Account.subtitle`, `Activity.subtitle`, `Catalogs.subtitle`, `Shopping.subtitle`; new `Expenses.subtitle`, `Household.subtitle`)

**Interfaces:**
- Produces: `export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle: ReactNode; actions?: ReactNode })`.

- [ ] **Step 1: Component.** Create `src/components/ui/PageHeader.tsx`:
  ```tsx
  import type { ReactNode } from "react";

  /** The one header every (app) page uses (D3): h1 title, subtitle below it (sentence case, no final
   *  period), optional actions on the right that wrap below the title when they don't fit. */
  export function PageHeader({
    title,
    subtitle,
    actions,
  }: {
    title: ReactNode;
    subtitle: ReactNode;
    actions?: ReactNode;
  }) {
    return (
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-2xl font-bold tracking-tight text-ink">{title}</h1>
          <p className="mt-1 text-sm text-faint">{subtitle}</p>
        </div>
        {actions}
      </header>
    );
  }
  ```

- [ ] **Step 2: Messages.** Change values (keys unchanged):
  - `Account.subtitle` — en `"Your access details"`, pt `"Seus dados de acesso"`, es `"Tus datos de acceso"`, fr `"Vos informations de connexion"`
  - `Activity.subtitle` — en `"Recent changes in this house"`, pt `"Mudanças recentes nesta casa"`, es `"Cambios recientes en esta casa"`, fr `"Changements récents dans cette maison"`
  - `Catalogs.subtitle` — en `"This house's categories, platforms and payment methods"`, pt `"Categorias, plataformas e formas de pagamento da casa"`, es `"Categorías, plataformas y formas de pago de la casa"`, fr `"Catégories, plateformes et moyens de paiement de la maison"`
  - `Shopping.subtitle` — en `"The house shopping list"`, pt `"Lista de compras da casa"`, es `"Lista de compras de la casa"`, fr `"La liste de courses de la maison"`

  Add new keys:
  - `Expenses.subtitle` — en `"What the house spent, month by month"`, pt `"O que a casa gastou, mês a mês"`, es `"Lo que gastó la casa, mes a mes"`, fr `"Ce que la maison a dépensé, mois par mois"`
  - `Household.subtitle` — en `"Members, house code and currency"`, pt `"Membros, código da casa e moeda"`, es `"Miembros, código de la casa y moneda"`, fr `"Membres, code de la maison et devise"`

- [ ] **Step 3: Simple pages.** Add `import { PageHeader } from "@/components/ui/PageHeader";` to each page and replace:
  - Account — the `<div>` holding the `label-mono` subtitle and the h1 → `<PageHeader title={t("title")} subtitle={t("subtitle")} />`
  - Activity — same replacement in `ActivityPage` → `<PageHeader title={t("title")} subtitle={t("subtitle")} />`
  - Catalogs — the h1 and the `-mt-3` paragraph (and the comment above them) → `<PageHeader title={t("title")} subtitle={t("subtitle")} />`
  - Shopping — the whole `<header className="flex flex-col gap-1">…</header>` → `<PageHeader title={t("title")} subtitle={t("subtitle")} />`
  - House — the h1 (and its comment) inside the first `<section>` → `<PageHeader title={t("title")} subtitle={t("subtitle")} />`

- [ ] **Step 4: Balances.** Import `PageHeader`. Immediately above `if (loading) {` define:
  ```tsx
  // D3: the shared page header, rendered in the loading and unavailable states too.
  const header = (
    <PageHeader
      title={t("title")}
      subtitle={t("statement")}
      actions={
        // cursor-default: purely decorative label, not a control (U5/BL-33).
        <Stamp tone="ink" className="mt-1 shrink-0 cursor-default">
          {t("account")}
        </Stamp>
      }
    />
  );
  ```
  Render `{header}` as the first child of the loading state's `<div className="flex flex-col gap-6">`; replace the unavailable state's return with:
  ```tsx
  return (
    <div className="flex flex-col gap-6">
      {header}
      <Card>
        <EmptyState title={t("unavailableTitle")} hint={t("unavailableHint")} />
      </Card>
    </div>
  );
  ```
  In the main return render `{header}` first and delete, inside the hero card, the first row (`<div className="flex items-start justify-between gap-4 px-5 pt-5 pb-4">…</div>` with the `label-mono` statement, the h1 and the stamp, and its comments) plus the `<ReceiptDivider />` right after it — the card keeps only the total row. `ReceiptDivider` stays imported (used further down).

- [ ] **Step 5: Expenses.** Import `PageHeader`. Replace the opening of the header block:
  ```tsx
        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <div className="flex min-w-0 items-center gap-3 md:flex-1">
            <h1 className="whitespace-nowrap font-display text-sm font-bold uppercase tracking-wider text-ink">
              {t("title")}{" "}
              {!listState.initialLoading && (
                <span className="font-normal text-faint">({total})</span>
              )}
            </h1>
            <span className="flex-1 border-t border-dashed border-rule" aria-hidden />
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_2.75rem] items-stretch gap-2 md:flex md:items-center">
  ```
  with
  ```tsx
        <PageHeader
          title={
            <>
              {t("title")}
              {!listState.initialLoading && (
                <span className="font-normal text-faint"> ({total})</span>
              )}
            </>
          }
          subtitle={t("subtitle")}
          actions={
          <div className="grid w-full grid-cols-[minmax(0,1fr)_2.75rem] items-stretch gap-2 md:flex md:w-auto md:items-center">
  ```
  and its closing (right before `{/* View toggle */}`):
  ```tsx
              </Menu>
            </div>
          </div>
        </div>
  ```
  with
  ```tsx
              </Menu>
            </div>
          </div>
          }
        />
  ```
  (The `<Button … onClick={openCreate}>` and the ⋮ `<Menu>` inside stay unchanged.)

- [ ] **Step 6: Gates.** `npx tsc --noEmit` clean; `npx eslint src` no new errors (no unused imports left); `npm run test` green; i18n parity OK; `grep -rn "<h1" "src/app/(app)"` returns no match (all titles come from `PageHeader`).

- [ ] **Step 7: Loop checks for Task 12 (all journeys, 4 viewports):** each page's h1 has a sibling subtitle `p` below it (y greater), subtitle text does not end with "."; Expenses actions sit on their own row below 768px and on the right from 768px; Balances header visible while loading.

- [ ] **Step 8: Leave changes unstaged** (no commits — the owner commits later on a branch he picks).

---

### Task 10: D4 + D5 + D6 — selector arrow, dialog footers, shopping empty states

Decisions: **D4** one glyph for every selector: the small `▾` of the custom menus replaces the big `▼` of native selects. **D5** every dialog footer uses the default button size and "Cancel" as a ghost (text) button. **D6** shopping empty states use a monochrome glyph, no emoji.

D5 footer inventory (`grep -rn "footer=" src`):

| Dialog | Today | Change |
|---|---|---|
| Shopping › Rename item (`shopping/page.tsx`) | Cancel `secondary sm`, Save `sm` | Cancel `ghost`, both default size |
| Shopping › Delete item | Cancel `secondary sm`, Delete `danger sm` | Cancel `ghost`, default size |
| Shopping › Clear purchased | Cancel `secondary sm`, Clear `danger sm` | Cancel `ghost`, default size |
| Link expenses (`ExpenseLinkModal.tsx`) | Skip/Cancel `secondary sm`, Save `sm` | Skip/Cancel `ghost`, default size |
| House › New house (`house/page.tsx`) | Cancel `ghost sm`, Create `sm` | default size |
| Expense form › error row "Load latest" (`ExpenseFormModal.tsx`) | `secondary sm` | default size (stays secondary — it is a recovery action, not Cancel) |
| Account delete, Balances delete payment, Expenses delete one/bulk, House regenerate/leave/remove (+ Task 4 make admin), TagManager create/delete, Record payment, Filters, Expense form actions, Discard changes | ghost Cancel, default size | already conform — no change |
| Expense detail (Delete + Edit, no Cancel); CSV import (Close/Import swap from phase-1 B2, no Cancel) | — | no Cancel button — no change |

**Files:**
- Modify: `src/components/ui/Field.tsx` (`Select` arrow)
- Modify: `src/app/(app)/shopping/page.tsx` (3 modal footers, empty-state icon)
- Modify: `src/components/shopping/ExpenseLinkModal.tsx` (footer)
- Modify: `src/app/(app)/house/page.tsx` (New house footer)
- Modify: `src/components/expenses/ExpenseFormModal.tsx` ("Load latest" button)
- Modify: `src/messages/{en,pt,es,fr}.json` (`Shopping.allBought` value)

**Interfaces:** none (presentation only).

- [ ] **Step 1 (D4):** In `Select` (`src/components/ui/Field.tsx`) replace the arrow span with:
  ```tsx
  {/* D4: the same small ▾ as the custom menus (MultiSelect, header switchers). */}
  <span
    aria-hidden
    className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-faint"
  >
    ▾
  </span>
  ```

- [ ] **Step 2 (D5, shopping):** In the three `<Modal>` footers of `src/app/(app)/shopping/page.tsx`: the Cancel buttons become `<Button variant="ghost" onClick={…}>` (remove `variant="secondary"` and `size="sm"`), and remove `size="sm"` from the Save / Delete / Clear purchased buttons (keep their `variant`, `loading`, `disabled`, `onClick`).

- [ ] **Step 3 (D5, other dialogs):** `ExpenseLinkModal.tsx` footer → `<Button variant="ghost" onClick={onClose}>` and `<Button loading={saving} onClick={() => void save()}>` (no `size`). House "Create house modal" → remove `size="sm"` from both buttons. `ExpenseFormModal.tsx` → remove `size="sm"` from the `id="exp-load-latest"` button.

- [ ] **Step 4 (D6):** Shopping empty state → `<EmptyState title={t("emptyTitle")} hint={t("emptyHint")} icon="[ ]" />` (the list's own checkbox glyph, rendered by EmptyState in the mono `text-rule` style like `¤`, `≡`, `⌕`). `Shopping.allBought` values: en `"All bought."`, pt `"Tudo comprado."`, es `"Todo comprado."`, fr `"Tout est acheté."` (emoji removed).

- [ ] **Step 5: Gates.** `npx tsc --noEmit` clean; `npx eslint src` no new errors; `npm run test` green; i18n parity OK; `grep -rn "▼" src/components/ui` and `grep -rn "🛒\|🎉" src` return no match; `grep -rn 'size="sm"' src/app/\(app\)/shopping/page.tsx src/components/shopping/ExpenseLinkModal.tsx` matches only the "Clear purchased" section button (not a dialog).

- [ ] **Step 6: Loop checks for Task 12 (J4, J6, J2):** dialog footers show Cancel as text with the same button height as the primary action (44px on phones); select arrows are the small ▾; shopping empty/all-bought states have no emoji.

- [ ] **Step 7: Leave changes unstaged** (no commits — the owner commits later on a branch he picks).

---

### Task 11: T8 — "HOMESHARE" brand and one language switcher on auth pages

Decision: the logo reads "HOMESHARE" on every screen. Current state (checked after phase 1): `src/app/auth/layout.tsx` still renders `HOME SHARE` and the native `AuthLanguageSelector` (`<select>` showing "ENGLISH"), while the app header, onboarding and 404 render `HOME<span className="text-stamp">SHARE</span>` and the menu-based `LanguageSelector` ("EN" button). Phase 1 already moved the selector into the flow (top row, right-aligned) — keep that wrapper.

**Files:**
- Modify: `src/app/auth/layout.tsx`
- Delete: `src/components/auth/AuthLanguageSelector.tsx` (its only importer is the auth layout)

**Interfaces:**
- Consumes: `LanguageSelector` from `src/components/app/LanguageSelector.tsx` (client component, no props).

- [ ] **Step 1:** In `src/app/auth/layout.tsx` replace `import { AuthLanguageSelector } from "@/components/auth/AuthLanguageSelector";` with `import { LanguageSelector } from "@/components/app/LanguageSelector";`, replace `<AuthLanguageSelector />` with `<LanguageSelector />` (inside the existing `mb-4 flex justify-end` row), and replace the h1 text `HOME SHARE` with:
  ```tsx
  HOME<span className="text-stamp">SHARE</span>
  ```

- [ ] **Step 2:** Delete `src/components/auth/AuthLanguageSelector.tsx`; then `grep -rn "AuthLanguageSelector" src` returns no match.

- [ ] **Step 3: Gates.** `npx tsc --noEmit` clean; `npx eslint src` no new errors; `npm run test` green.

- [ ] **Step 4: Loop checks for Task 12 (J0, J1):** login/register show "HOMESHARE" with the accent on SHARE and the "EN" globe button; the D18 check (selector above the brand, not overlapping it) still passes with the new selector.

- [ ] **Step 5: Leave changes unstaged** (no commits — the owner commits later on a branch he picks).

---

### Task 12: Round 2 of the loop (verification)

> **Prerequisite (owner):** reconnect the browser runner first — the `pw-edge` Playwright MCP in Edge extension mode. Implementers never start dev servers or browsers; the controller drives the QA server on 127.0.0.1:3100 (DB `homeshare-qa-pg`, 127.0.0.1:55432).

- [ ] **Step 1:** `npm run test`, `npx tsc --noEmit`, `npx eslint src` (no new errors; only the pre-existing one in `src/app/auth/login/page.tsx`).
- [ ] **Step 2:** Update journeys in `screenshots/loop-2026-09-27/modelo/` for the new UI, including phase 2:
  - T8 (required — the auth selector is no longer a `<select>`): in `ajudantes.js`, `medirSeletorDeIdioma` measures `document.querySelector('main button[aria-haspopup="menu"]')` instead of `main select`; in `j1-autenticacao.js` the public-page language loop opens that button and clicks `p.getByRole('menuitem', { name: rotulo })` (and the same for the final `'English'`) instead of `selectOption`; add a check that the auth h1 text is `HOMESHARE`.
  - B5 (J2): with more than 50 expenses in a month, the month header subtotal equals the filtered total of that month (filter the month with the date filter and compare with the summary total), in List and By person.
  - B9 (J4): link an expense, uncheck the item → its ⋯ menu still offers "Link expenses" and the link can be removed.
  - B10 (J6): the only admin's leave dialog shows the warning with Leave disabled; ⋯ → "Make admin" → confirm → the member's tag reads ADMIN and Leave is enabled; Account › Delete account warns while the user is the only admin of a house. (The member ⋯ trigger's accessible name is now "Actions for {name}".)
  - D3 (every journey): each page's h1 has its subtitle below it, sentence case, no final period.
  - D4/D5/D6 (J2, J3, J4, J6): no `▼` in selects; dialog Cancel buttons are ghost and as tall as the primary; no emoji in shopping states.
  - I7 (J8 es): amounts ≥ 1000 show the thousands separator. I11 (J2 history, J7): timestamps `dd/mm/yyyy HH:mm`.
  - U21 (J2): typing a percentage moves its slider.
  - Deferred 1/2 (J7): Detailed shows "purchased ~~No~~ → Yes" after a toggle; the "House" chip lists the currency change; the "Membership" chip lists only membership revisions.

  Then run `cd screenshots/loop-2026-09-27 && bash reset-qa.sh && python gerar-roteiros.py 2` and run every roteiro in `rodada-2/roteiros/` via `pw-edge`.
- [ ] **Step 3:** Review the round-2 prints (parallel reviewers, same instructions as round 1; batches from `python montar-lotes-revisao.py 2`) focusing on the fixed findings (phase 1 and phase 2) and on regressions; update `achados.json` states — "corrigido e conferido" / "não confirmado" for the fixes, I12 → "decidido: sem mudança (input de data nativo)" — and regenerate the report (`python gerar-relatorio.py`, before/after prints).
