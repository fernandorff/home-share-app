import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// No database here: pure validation, the poster's error mapping with a mocked $transaction, and the cron
// run's query plan and order (behavior against a real DB lives in tenant-isolation.test.ts — a failing
// statement inside a transaction would desync its shared pglite socket, so these error paths are covered here).
const { mockPrisma, mockExpenseCreated, mockAuditLog, mockLogError } = vi.hoisted(() => ({
  mockPrisma: {
    $transaction: vi.fn(),
    recurringExpense: { findMany: vi.fn(), update: vi.fn() },
    recurringExpenseOccurrence: { groupBy: vi.fn(), findFirst: vi.fn(), createMany: vi.fn() },
    groupMember: { findMany: vi.fn() },
  },
  mockExpenseCreated: vi.fn(),
  mockAuditLog: vi.fn(),
  mockLogError: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/services/notification.service", () => ({ notificationService: { expenseCreated: mockExpenseCreated } }));
vi.mock("@/services/audit.service", () => ({ auditService: { log: mockAuditLog } }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: mockLogError } }));

import {
  parseRecurringExpenseInput,
  parseRecurringExpensePatch,
  recurringExpenseService,
} from "@/services/recurring-expense.service";

const valid = {
  description: "Rent",
  amount: 1800,
  dayOfMonth: 5,
  payerId: 1,
  splitMode: "ALL",
  timezone: "America/Sao_Paulo",
};

/** The ApiError a parse throws, as { status, code } (fails the test when it does not throw). */
function failure(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    const err = e as { status?: number; code?: string };
    return { status: err.status, code: err.code };
  }
  throw new Error("expected the parse to throw");
}

describe("parseRecurringExpenseInput — criterion 1 (valid body)", () => {
  it("returns the normalized rule input: trimmed description, ALL clears participantIds", () => {
    expect(parseRecurringExpenseInput({ ...valid, description: "  Rent  ", participantIds: [9] })).toEqual({
      description: "Rent",
      amount: 1800,
      dayOfMonth: 5,
      payerId: 1,
      splitMode: "ALL",
      participantIds: [],
      timezone: "America/Sao_Paulo",
    });
  });

  it("keeps SELECTED participants in the order sent", () => {
    const input = parseRecurringExpenseInput({ ...valid, splitMode: "SELECTED", participantIds: [3, 1, 2] });
    expect(input.splitMode).toBe("SELECTED");
    expect(input.participantIds).toEqual([3, 1, 2]);
  });

  it("stores the timezone under the canonical name Intl resolves (case-insensitive input)", () => {
    expect(parseRecurringExpenseInput({ ...valid, timezone: "america/sao_paulo" }).timezone).toBe("America/Sao_Paulo");
    expect(parseRecurringExpenseInput({ ...valid, timezone: "utc" }).timezone).toBe("UTC");
  });

  it("accepts the bounds: 200 chars, 0.01, 99,999,999.99, days 1 and 31, 50 participants", () => {
    expect(() => parseRecurringExpenseInput({ ...valid, description: "x".repeat(200) })).not.toThrow();
    expect(() => parseRecurringExpenseInput({ ...valid, amount: 0.01 })).not.toThrow();
    expect(() => parseRecurringExpenseInput({ ...valid, amount: 99_999_999.99 })).not.toThrow();
    expect(() => parseRecurringExpenseInput({ ...valid, dayOfMonth: 1 })).not.toThrow();
    expect(() => parseRecurringExpenseInput({ ...valid, dayOfMonth: 31 })).not.toThrow();
    const fifty = Array.from({ length: 50 }, (_, i) => i + 1);
    expect(() => parseRecurringExpenseInput({ ...valid, splitMode: "SELECTED", participantIds: fifty })).not.toThrow();
  });
});

describe("parseRecurringExpenseInput — criterion 2 (stable 400 codes)", () => {
  it.each([
    ["missing description", { description: undefined }, "DESCRIPTION_REQUIRED"],
    ["blank description", { description: "   " }, "DESCRIPTION_REQUIRED"],
    ["non-string description", { description: 42 }, "DESCRIPTION_REQUIRED"],
    ["201-char description", { description: "x".repeat(201) }, "DESCRIPTION_TOO_LONG"],
    ["control character", { description: "Rent\u0000" }, "DESCRIPTION_INVALID"],
    ["zero amount", { amount: 0 }, "AMOUNT_INVALID"],
    ["negative amount", { amount: -5 }, "AMOUNT_INVALID"],
    ["string amount", { amount: "1800" }, "AMOUNT_INVALID"],
    ["NaN amount", { amount: Number.NaN }, "AMOUNT_INVALID"],
    ["sub-cent amount", { amount: 10.001 }, "AMOUNT_PRECISION"],
    ["amount over the column", { amount: 100_000_000 }, "AMOUNT_TOO_HIGH"],
    ["missing payer", { payerId: undefined }, "PAYER_REQUIRED"],
    ["non-integer payer", { payerId: "1" }, "PAYER_REQUIRED"],
    ["day 0", { dayOfMonth: 0 }, "RECURRING_DAY_INVALID"],
    ["day 32", { dayOfMonth: 32 }, "RECURRING_DAY_INVALID"],
    ["fractional day", { dayOfMonth: 5.5 }, "RECURRING_DAY_INVALID"],
    ["missing day", { dayOfMonth: undefined }, "RECURRING_DAY_INVALID"],
    ["unknown split mode", { splitMode: "CUSTOM" }, "RECURRING_SPLIT_INVALID"],
    ["missing split mode", { splitMode: undefined }, "RECURRING_SPLIT_INVALID"],
    ["SELECTED without participants", { splitMode: "SELECTED", participantIds: [] }, "RECURRING_SPLIT_INVALID"],
    ["SELECTED with a non-array", { splitMode: "SELECTED", participantIds: "1,2" }, "RECURRING_SPLIT_INVALID"],
    ["SELECTED with duplicates", { splitMode: "SELECTED", participantIds: [1, 1] }, "RECURRING_SPLIT_INVALID"],
    ["SELECTED with a non-integer id", { splitMode: "SELECTED", participantIds: [1, "2"] }, "RECURRING_SPLIT_INVALID"],
    ["SELECTED with 51 people", { splitMode: "SELECTED", participantIds: Array.from({ length: 51 }, (_, i) => i + 1) }, "RECURRING_SPLIT_INVALID"],
    ["unknown timezone", { timezone: "Mars/Olympus_Mons" }, "RECURRING_TIMEZONE_INVALID"],
    ["missing timezone", { timezone: undefined }, "RECURRING_TIMEZONE_INVALID"],
  ])("%s → 400 %s", (_label, override, code) => {
    expect(failure(() => parseRecurringExpenseInput({ ...valid, ...override }))).toEqual({ status: 400, code });
  });

  it("a non-object body is a 400, not a crash", () => {
    expect(failure(() => parseRecurringExpenseInput(null))).toEqual({ status: 400, code: "DESCRIPTION_REQUIRED" });
    expect(failure(() => parseRecurringExpenseInput("rent"))).toEqual({ status: 400, code: "DESCRIPTION_REQUIRED" });
  });
});

describe("parseRecurringExpensePatch — editable fields only (criterion 16)", () => {
  it("returns only the fields present; timezone is not editable and is ignored", () => {
    expect(parseRecurringExpensePatch({ amount: 1900, timezone: "Asia/Tokyo", expectedUpdatedAt: "x" })).toEqual({ amount: 1900 });
    expect(parseRecurringExpensePatch({ description: " Internet ", dayOfMonth: 31 })).toEqual({ description: "Internet", dayOfMonth: 31 });
  });

  it("validates each present field with the create codes", () => {
    expect(failure(() => parseRecurringExpensePatch({ amount: 0 }))).toEqual({ status: 400, code: "AMOUNT_INVALID" });
    expect(failure(() => parseRecurringExpensePatch({ dayOfMonth: 40 }))).toEqual({ status: 400, code: "RECURRING_DAY_INVALID" });
    expect(failure(() => parseRecurringExpensePatch({ description: "" }))).toEqual({ status: 400, code: "DESCRIPTION_REQUIRED" });
    expect(failure(() => parseRecurringExpensePatch({ payerId: 0 }))).toEqual({ status: 400, code: "PAYER_REQUIRED" });
    expect(failure(() => parseRecurringExpensePatch({ splitMode: "HALF" }))).toEqual({ status: 400, code: "RECURRING_SPLIT_INVALID" });
    expect(failure(() => parseRecurringExpensePatch({ participantIds: [2, 2] }))).toEqual({ status: 400, code: "RECURRING_SPLIT_INVALID" });
  });

  it("nothing editable to change → 400 RECURRING_PATCH_INVALID", () => {
    expect(failure(() => parseRecurringExpensePatch({}))).toEqual({ status: 400, code: "RECURRING_PATCH_INVALID" });
    expect(failure(() => parseRecurringExpensePatch({ timezone: "UTC" }))).toEqual({ status: 400, code: "RECURRING_PATCH_INVALID" });
    expect(failure(() => parseRecurringExpensePatch(null))).toEqual({ status: 400, code: "RECURRING_PATCH_INVALID" });
  });
});

describe("postPeriod — what a failed posting transaction means", () => {
  const rule = {
    id: 7, publicId: "0192b3c4-0000-7000-8000-000000000007", groupId: 1, createdById: 1, payerId: 1,
    description: "Rent", amount: "1800", dayOfMonth: 5, splitMode: "ALL", participantIds: [], timezone: "UTC",
    activeFrom: new Date("2026-10-01T00:00:00Z"), pausedAt: null, pauseReason: null, skippedPeriods: [],
    createdAt: new Date("2026-10-01T00:00:00Z"), updatedAt: new Date("2026-10-01T00:00:00Z"),
  };
  const poster = recurringExpenseService as unknown as {
    postPeriod: (row: typeof rule, period: string, due: string, memberIds: number[]) => Promise<string>;
  };
  const failWith = (error: unknown) => {
    mockPrisma.$transaction.mockRejectedValueOnce(error);
    return poster.postPeriod(rule, "2026-10", "2026-10-05", [1]);
  };
  const uniqueViolation = (meta: Record<string, unknown>) => Object.assign(new Error("Unique constraint failed"), { code: "P2002", meta });
  const adapterMeta = (constraint: Record<string, unknown>) => ({
    modelName: "RecurringExpenseOccurrence",
    driverAdapterError: { cause: { kind: "UniqueConstraintViolation", constraint } },
  });

  it("a unique violation on the ledger key (rule, period) is another run's claim → duplicate", async () => {
    expect(await failWith(uniqueViolation(adapterMeta({ fields: ['"recurringExpenseId"', "period"] })))).toBe("duplicate");
    expect(await failWith(uniqueViolation({ target: ["recurringExpenseId", "period"] }))).toBe("duplicate");
    expect(await failWith(uniqueViolation({ target: "RecurringExpenseOccurrence_recurringExpenseId_period_key" }))).toBe("duplicate");
  });

  it("any other unique violation stops the rule with the month still open → aborted (retried by the next run)", async () => {
    expect(await failWith(uniqueViolation(adapterMeta({ fields: ['"publicId"'] })))).toBe("aborted");
    expect(await failWith(uniqueViolation(adapterMeta({ fields: ['"expenseId"'] })))).toBe("aborted");
    expect(await failWith(uniqueViolation({}))).toBe("aborted");
  });

  it("a foreign-key violation on the claim (rule deleted mid-run) → aborted, not an error", async () => {
    expect(await failWith(Object.assign(new Error("Foreign key constraint violated"), { code: "P2003", meta: {} }))).toBe("aborted");
  });

  it("anything else propagates to postDue, which counts the rule as failed", async () => {
    await expect(failWith(Object.assign(new Error("boom"), { code: "P1017" }))).rejects.toThrow("boom");
  });

  // Prisma's defaults (maxWait 2 s, timeout 5 s) can roll a posting back on a cold Neon connection.
  it("runs in an interactive transaction with room for a cold connection (timeout 15 s, maxWait 10 s)", async () => {
    mockPrisma.$transaction.mockResolvedValueOnce(null);
    expect(await poster.postPeriod(rule, "2026-10", "2026-10-05", [1])).toBe("duplicate");
    expect(mockPrisma.$transaction).toHaveBeenLastCalledWith(expect.any(Function), { timeout: 15_000, maxWait: 10_000 });
  });
});

describe("postPeriod — EXPENSE_NEW notices once the posting committed (spec 009, criteria 5 and 10)", () => {
  const rule = {
    id: 7, publicId: "0192b3c4-0000-7000-8000-000000000007", groupId: 1, createdById: 1, payerId: 1,
    description: "Rent", amount: "1800", dayOfMonth: 5, splitMode: "ALL", participantIds: [], timezone: "UTC",
    activeFrom: new Date("2026-10-01T00:00:00Z"), pausedAt: null, pauseReason: null, skippedPeriods: [],
    createdAt: new Date("2026-10-01T00:00:00Z"), updatedAt: new Date("2026-10-01T00:00:00Z"),
  };
  const expense = {
    id: 99, publicId: "0192b3c4-0000-7000-8000-000000000099", groupId: 1, description: "Rent", amount: "1800", payerId: 1,
    participants: [{ userId: 1, amount: "900" }, { userId: 2, amount: "900" }],
  };
  const poster = recurringExpenseService as unknown as {
    postPeriod: (row: typeof rule, period: string, due: string, memberIds: number[]) => Promise<string>;
  };
  const post = () => poster.postPeriod(rule, "2026-10", "2026-10-05", [1, 2]);

  beforeEach(() => vi.resetAllMocks());

  it("a committed posting notifies through the producer with the posted expense and no actor, after the commit", async () => {
    // When the transaction settles nothing has been notified yet: the producer runs outside it.
    mockPrisma.$transaction.mockImplementationOnce(async () => {
      expect(mockExpenseCreated).not.toHaveBeenCalled();
      return expense;
    });
    mockExpenseCreated.mockResolvedValue([]);

    expect(await post()).toBe("posted");
    expect(mockExpenseCreated).toHaveBeenCalledTimes(1);
    expect(mockExpenseCreated).toHaveBeenCalledWith(expense, null);
    expect(mockPrisma.$transaction.mock.invocationCallOrder[0]).toBeLessThan(mockExpenseCreated.mock.invocationCallOrder[0]);
  });

  it("a throwing notification service never fails or undoes the posting: still posted, the failure logged with the type only", async () => {
    mockPrisma.$transaction.mockResolvedValueOnce(expense);
    const error = new Error("connection reset");
    mockExpenseCreated.mockRejectedValueOnce(error);

    expect(await post()).toBe("posted");
    expect(mockLogError).toHaveBeenCalledWith("notification failed", { type: "EXPENSE_NEW" }, error);
  });

  it("a duplicate or aborted posting notifies nobody", async () => {
    mockPrisma.$transaction.mockResolvedValueOnce(null);
    expect(await post()).toBe("duplicate");
    mockPrisma.$transaction.mockRejectedValueOnce(Object.assign(new Error("Foreign key constraint violated"), { code: "P2003", meta: {} }));
    expect(await post()).toBe("aborted");
    expect(mockExpenseCreated).not.toHaveBeenCalled();
  });
});

describe("skipPeriod — the SKIPPED write is a transaction like a posting", () => {
  const rule = {
    id: 7, publicId: "0192b3c4-0000-7000-8000-000000000007", groupId: 1, createdById: 1, payerId: 1,
    description: "Rent", amount: "1800", dayOfMonth: 5, splitMode: "ALL", participantIds: [], timezone: "UTC",
    activeFrom: new Date("2026-10-01T00:00:00Z"), pausedAt: null, pauseReason: null, skippedPeriods: ["2026-10"],
    createdAt: new Date("2026-10-01T00:00:00Z"), updatedAt: new Date("2026-10-01T00:00:00Z"),
  };
  const poster = recurringExpenseService as unknown as {
    skipPeriod: (row: typeof rule, period: string, due: string) => Promise<string>;
  };

  it("same transaction bounds as a posting; another run's claim is a duplicate", async () => {
    mockPrisma.$transaction.mockResolvedValueOnce(null);
    expect(await poster.skipPeriod(rule, "2026-10", "2026-10-05")).toBe("duplicate");
    expect(mockPrisma.$transaction).toHaveBeenLastCalledWith(expect.any(Function), { timeout: 15_000, maxWait: 10_000 });
  });

  it("a deleted rule (FK violation on the claim) is aborted; anything else propagates", async () => {
    mockPrisma.$transaction.mockRejectedValueOnce(Object.assign(new Error("Foreign key constraint violated"), { code: "P2003", meta: {} }));
    expect(await poster.skipPeriod(rule, "2026-10", "2026-10-05")).toBe("aborted");
    mockPrisma.$transaction.mockRejectedValueOnce(Object.assign(new Error("boom"), { code: "P1017" }));
    await expect(poster.skipPeriod(rule, "2026-10", "2026-10-05")).rejects.toThrow("boom");
  });
});

describe("postDue — the cron run's query plan and order", () => {
  const NOW = new Date("2026-10-10T15:00:00Z");
  const row = (id: number, dayOfMonth: number, activeFrom: string) => ({
    id, publicId: `0192b3c4-0000-7000-8000-00000000000${id}`, groupId: 1, createdById: 1, payerId: 1,
    description: `Rule ${id}`, amount: "100", dayOfMonth, splitMode: "ALL", participantIds: [], timezone: "UTC",
    activeFrom: new Date(`${activeFrom}T00:00:00Z`), pausedAt: null, pauseReason: null, skippedPeriods: [],
    createdAt: new Date(`${activeFrom}T00:00:00Z`), updatedAt: new Date(`${activeFrom}T00:00:00Z`),
  });
  const closed = (entries: [number, string][]) =>
    entries.map(([recurringExpenseId, period]) => ({ recurringExpenseId, _max: { period } }));
  const internals = recurringExpenseService as unknown as { postRule: (...args: unknown[]) => Promise<void> };

  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("nothing due: one batched ledger query for every rule, no per-rule query, nothing posted", async () => {
    mockPrisma.recurringExpense.findMany.mockResolvedValueOnce([
      row(1, 20, "2026-10-01"), // due on the 20th: not yet
      row(2, 5, "2026-09-01"), // October already closed
      row(3, 5, "2026-10-10"), // created after this month's due day: starts in November
    ]);
    mockPrisma.recurringExpenseOccurrence.groupBy.mockResolvedValueOnce(closed([[2, "2026-10"]]));

    expect(await recurringExpenseService.postDue(NOW)).toEqual({ posted: 0, skipped: 0, paused: 0, duplicates: 0, failed: 0, remaining: 0 });
    expect(mockPrisma.recurringExpenseOccurrence.groupBy).toHaveBeenCalledTimes(1);
    expect(mockPrisma.recurringExpenseOccurrence.groupBy.mock.calls[0][0]).toMatchObject({
      where: { recurringExpenseId: { in: [1, 2, 3] } },
    });
    expect(mockPrisma.recurringExpenseOccurrence.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.recurringExpenseOccurrence.createMany).not.toHaveBeenCalled();
    expect(mockPrisma.groupMember.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  // Rule 1 is due Oct 5, rule 2 has been due since Sep 20, rule 3 since Oct 1; rule 4 is not due.
  const dueRules = () => [row(1, 5, "2026-10-01"), row(2, 20, "2026-09-01"), row(3, 1, "2026-10-01"), row(4, 25, "2026-10-01")];

  it("due rules go oldest due date first (not by id), each with its precomputed periods", async () => {
    mockPrisma.recurringExpense.findMany.mockResolvedValueOnce(dueRules());
    mockPrisma.recurringExpenseOccurrence.groupBy.mockResolvedValueOnce([]);
    const calls: [number, unknown][] = [];
    vi.spyOn(internals, "postRule").mockImplementation(async (rule, periods) => {
      calls.push([(rule as { id: number }).id, periods]);
    });

    await recurringExpenseService.postDue(NOW);
    expect(calls).toEqual([[2, ["2026-09"]], [3, ["2026-10"]], [1, ["2026-10"]]]);
  });

  it("a rule whose dates cannot be computed (unknown timezone) counts as failed and does not block the others", async () => {
    mockPrisma.recurringExpense.findMany.mockResolvedValueOnce([{ ...row(1, 5, "2026-10-01"), timezone: "Mars/Olympus" }, row(2, 5, "2026-10-01")]);
    mockPrisma.recurringExpenseOccurrence.groupBy.mockResolvedValueOnce([]);
    const posted: number[] = [];
    vi.spyOn(internals, "postRule").mockImplementation(async (rule) => {
      posted.push((rule as { id: number }).id);
    });

    expect(await recurringExpenseService.postDue(NOW)).toMatchObject({ failed: 1 });
    expect(posted).toEqual([2]);
  });

  it("deadline: the rules left over are the newest due, so the next run starts with them — the same rules never starve", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-10T11:00:00Z"));
    const deadline = () => new Date(Date.now() + 30_000);
    const order: number[] = [];
    // Each rule takes longer than the whole budget: one rule per run.
    vi.spyOn(internals, "postRule").mockImplementation(async (rule) => {
      order.push((rule as { id: number }).id);
      vi.setSystemTime(Date.now() + 35_000);
    });

    mockPrisma.recurringExpense.findMany.mockResolvedValueOnce(dueRules());
    mockPrisma.recurringExpenseOccurrence.groupBy.mockResolvedValueOnce([]);
    expect(await recurringExpenseService.postDue(NOW, { deadline: deadline() })).toMatchObject({ remaining: 2 });
    expect(order).toEqual([2]);

    // Next run: rule 2's September is closed, so the leftovers come first, oldest due first.
    mockPrisma.recurringExpense.findMany.mockResolvedValueOnce(dueRules());
    mockPrisma.recurringExpenseOccurrence.groupBy.mockResolvedValueOnce(closed([[2, "2026-09"]]));
    expect(await recurringExpenseService.postDue(NOW, { deadline: deadline() })).toMatchObject({ remaining: 1 });
    expect(order).toEqual([2, 3]);
  });
});

describe("postRule — the deadline is also checked between a rule's months", () => {
  const rule = {
    id: 7, publicId: "0192b3c4-0000-7000-8000-000000000007", groupId: 1, createdById: 1, payerId: 1,
    description: "Rent", amount: "1800", dayOfMonth: 5, splitMode: "ALL", participantIds: [], timezone: "UTC",
    activeFrom: new Date("2026-01-01T00:00:00Z"), pausedAt: null, pauseReason: null, skippedPeriods: [],
    createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
  const internals = recurringExpenseService as unknown as {
    postRule: (...args: unknown[]) => Promise<void>;
    postPeriod: (...args: unknown[]) => Promise<string>;
    activeMemberIds: (...args: unknown[]) => Promise<number[]>;
  };
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("a long catch-up stops after the month in flight once the deadline passes; the rest waits (remaining)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-10T11:00:00Z"));
    const deadline = new Date(Date.now() + 30_000);
    vi.spyOn(internals, "activeMemberIds").mockResolvedValue([1]);
    const posted: unknown[] = [];
    vi.spyOn(internals, "postPeriod").mockImplementation(async (_rule, period) => {
      posted.push(period);
      vi.setSystemTime(Date.now() + 20_000); // each month takes 20 s on a slow database
      return "posted";
    });
    const result = { posted: 0, skipped: 0, paused: 0, duplicates: 0, failed: 0, remaining: 0 };

    await internals.postRule(rule, ["2026-07", "2026-08", "2026-09", "2026-10"], new Date(), result, deadline);
    expect(posted).toEqual(["2026-07", "2026-08"]);
    expect(result).toMatchObject({ posted: 2, remaining: 1 });
  });
});

describe("setPaused — a resume that prunes old skips is guarded like a skip", () => {
  const rule = {
    id: 7, publicId: "0192b3c4-0000-7000-8000-000000000007", groupId: 1, createdById: 1, payerId: 1,
    description: "Rent", amount: "1800", dayOfMonth: 5, splitMode: "ALL", participantIds: [], timezone: "UTC",
    activeFrom: new Date("2026-08-01T00:00:00Z"), pausedAt: new Date("2026-08-20T00:00:00Z"), pauseReason: "MANUAL",
    skippedPeriods: ["2026-09", "2026-11"], createdAt: new Date("2026-08-01T00:00:00Z"),
    updatedAt: new Date("2026-08-20T00:00:00Z"),
  };
  const viewer = { userId: 1, role: "MEMBER" as const };
  const internals = recurringExpenseService as unknown as {
    findManageable: (...args: unknown[]) => Promise<typeof rule>;
    assertActiveMembers: (...args: unknown[]) => Promise<void>;
  };
  const NOW = new Date("2026-10-10T15:00:00Z");
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(internals, "findManageable").mockResolvedValue(rule);
    // The rule's last closed period (recurring-ledger's query): August.
    mockPrisma.recurringExpenseOccurrence.findFirst.mockResolvedValue({ period: "2026-08" });
    vi.spyOn(internals, "assertActiveMembers").mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    mockPrisma.recurringExpenseOccurrence.findFirst.mockReset();
  });

  it("drops the passed skip with an updatedAt-guarded write", async () => {
    mockPrisma.recurringExpense.update.mockResolvedValueOnce({ ...rule, pausedAt: null, pauseReason: null, skippedPeriods: ["2026-11"] });
    await recurringExpenseService.setPaused(1, viewer, rule.publicId, false, NOW);
    expect(mockPrisma.recurringExpense.update.mock.calls[0][0]).toMatchObject({
      where: { id: 7, updatedAt: rule.updatedAt },
      data: { pausedAt: null, skippedPeriods: ["2026-11"] },
    });
  });

  it("a skip that landed between the read and the write (P2025) is a 409 STALE, not a lost update", async () => {
    mockPrisma.recurringExpense.update.mockRejectedValueOnce(Object.assign(new Error("Record not found"), { code: "P2025" }));
    await expect(recurringExpenseService.setPaused(1, viewer, rule.publicId, false, NOW)).rejects.toMatchObject({
      status: 409,
      code: "STALE_RECURRING_EXPENSE",
    });
  });

  it("nothing to prune: the plain write (no guard), as before", async () => {
    vi.spyOn(internals, "findManageable").mockResolvedValue({ ...rule, skippedPeriods: ["2026-11"] });
    mockPrisma.recurringExpense.update.mockResolvedValueOnce({ ...rule, pausedAt: null, pauseReason: null, skippedPeriods: ["2026-11"] });
    await recurringExpenseService.setPaused(1, viewer, rule.publicId, false, NOW);
    expect(mockPrisma.recurringExpense.update.mock.calls[0][0].where).toEqual({ id: 7 });
  });
});
