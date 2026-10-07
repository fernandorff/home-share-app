import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// No database here (Prisma mocked): query shapes, validation, the pure date rules with a fixed `now`, and
// the scheduled producers' per-unit isolation. Behaviour against a real DB — dedupe, scoping, the active and
// preference filters, real balances and rules, prune, account deletion — lives in tenant-isolation.test.ts
// (describe "notification center (spec 009 …)"), the only file allowed on the shared pglite DB.
const { mockPrisma, mockBalance, mockSettlements, mockLogger, mockSchedulePush } = vi.hoisted(() => ({
  mockSchedulePush: vi.fn(),
  mockBalance: { aggregate: vi.fn() },
  mockSettlements: { list: vi.fn() },
  mockLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  mockPrisma: {
    $transaction: vi.fn(),
    user: { findUnique: vi.fn() },
    group: { findMany: vi.fn() },
    groupMember: { findMany: vi.fn() },
    notification: {
      createManyAndReturn: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    notificationPreference: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
    recurringExpense: { findMany: vi.fn() },
    recurringExpenseOccurrence: { groupBy: vi.fn() },
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/services/balance.service", () => ({ balanceService: mockBalance }));
vi.mock("@/services/settlement.service", () => ({ settlementService: mockSettlements }));
vi.mock("@/lib/logger", () => ({ logger: mockLogger }));
vi.mock("@/services/group.service", () => ({ groupService: { assertCanLeaveAllHouses: vi.fn() } }));
// Spec 010: the push after an insert is scheduled through schedulePush (its own unit test covers after()). web-push is
// mocked because authService → pushService imports it: no test may reach the network.
vi.mock("@/lib/push/schedule", () => ({ schedulePush: mockSchedulePush }));
vi.mock("web-push", () => ({ default: { sendNotification: vi.fn() } }));

import { notificationService, reminderPeriod } from "@/services/notification.service";
import { authService } from "@/services/auth.service";
import { NOTIFICATION_TYPES } from "@/lib/notifications";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A scheduled producer's result: notices inserted, units that threw, units the deadline left for later. */
const run = (created: number, failed = 0, remaining = 0) => ({ created, failed, remaining });

/** What createManyAndReturn was asked to insert (the data rows of its only call). */
function inserted(): Array<Record<string, unknown>> {
  expect(mockPrisma.notification.createManyAndReturn).toHaveBeenCalledTimes(1);
  return mockPrisma.notification.createManyAndReturn.mock.calls[0][0].data;
}

/** Every requested member is an active recipient; the insert echoes its rows back. */
function allActive() {
  mockPrisma.groupMember.findMany.mockImplementation(async (args: { where: { userId: { in: number[] } } }) =>
    args.where.userId.in.map((userId) => ({ userId }))
  );
  mockPrisma.notification.createManyAndReturn.mockImplementation(async (args: { data: unknown[] }) => args.data);
}

beforeEach(() => {
  vi.resetAllMocks();
});

// ── Task 4: create ───────────────────────────────────────────────────────────────────────────────────

describe("notificationService.create — the common filter (criteria 4–9)", () => {
  const params = { description: "Groceries", amount: "50.00" };

  it("never notifies the actor: an actor-only list queries and inserts nothing", async () => {
    const created = await notificationService.create({
      groupId: 1,
      type: "EXPENSE_NEW",
      actorId: 7,
      notices: [{ userId: 7, params }],
    });
    expect(created).toEqual([]);
    expect(mockPrisma.groupMember.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.notification.createManyAndReturn).not.toHaveBeenCalled();
  });

  it("keeps only active members of the event's house with an account and the type not turned off — one query", async () => {
    allActive();
    await notificationService.create({
      groupId: 1,
      type: "PAYMENT_RECEIVED",
      actorId: 7,
      notices: [{ userId: 2, params }, { userId: 7, params }, { userId: 3, params }],
    });
    expect(mockPrisma.groupMember.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.groupMember.findMany).toHaveBeenCalledWith({
      where: {
        groupId: 1,
        leftAt: null,
        userId: { in: [2, 3] },
        user: { deletedAt: null, notificationPreferences: { none: { type: "PAYMENT_RECEIVED", enabled: false } } },
      },
      select: { userId: true },
    });
  });

  it("inserts one row per recipient with createManyAndReturn + skipDuplicates and returns the inserted rows", async () => {
    mockPrisma.groupMember.findMany.mockResolvedValue([{ userId: 3 }]);
    const rows = [{ id: 1, userId: 3 }];
    mockPrisma.notification.createManyAndReturn.mockResolvedValue(rows);

    const created = await notificationService.create({
      groupId: 1,
      type: "EXPENSE_NEW",
      actorId: 7,
      notices: [{ userId: 2, params }, { userId: 3, params }],
    });

    expect(created).toBe(rows);
    expect(mockPrisma.notification.createManyAndReturn.mock.calls[0][0].skipDuplicates).toBe(true);
    const [row] = inserted();
    expect(row).toEqual({
      publicId: expect.stringMatching(UUID),
      userId: 3,
      groupId: 1,
      type: "EXPENSE_NEW",
      actorId: 7,
      params,
      dedupeKey: null,
    });
  });

  it("one notice per recipient per call (the first draft wins), in the drafts' order; scheduled keys are kept", async () => {
    allActive();
    await notificationService.create({
      groupId: 4,
      type: "DEBT_REMINDER",
      actorId: null,
      notices: [
        { userId: 5, params: { amount: "1.00" }, dedupeKey: "DEBT_REMINDER:4:2026-W41" },
        { userId: 2, params: { amount: "2.00" }, dedupeKey: "DEBT_REMINDER:4:2026-W41" },
        { userId: 5, params: { amount: "9.00" }, dedupeKey: "DEBT_REMINDER:4:2026-W41" },
      ],
    });
    const rows = inserted();
    expect(rows.map((r) => [r.userId, r.params, r.dedupeKey, r.actorId])).toEqual([
      [5, { amount: "1.00" }, "DEBT_REMINDER:4:2026-W41", null],
      [2, { amount: "2.00" }, "DEBT_REMINDER:4:2026-W41", null],
    ]);
    // No DB default: every row carries its own app-generated publicId.
    expect(new Set(rows.map((r) => r.publicId)).size).toBe(2);
  });

  it("an empty dedupeKey is stored as NULL (an empty string would collide for every event notice of a recipient)", async () => {
    allActive();
    await notificationService.create({ groupId: 1, type: "EXPENSE_NEW", actorId: null, notices: [{ userId: 2, params, dedupeKey: "" }] });
    expect(inserted()[0].dedupeKey).toBeNull();
  });

  it("inserts nothing when no recipient survives the filter", async () => {
    mockPrisma.groupMember.findMany.mockResolvedValue([]);
    const created = await notificationService.create({ groupId: 1, type: "EXPENSE_NEW", actorId: 7, notices: [{ userId: 2, params }] });
    expect(created).toEqual([]);
    expect(mockPrisma.notification.createManyAndReturn).not.toHaveBeenCalled();
  });
});

// ── Spec 010, task 8: the push copy of each inserted notice ─────────────────────────────────────────

describe("notificationService.create → push (spec 010, criterion 6)", () => {
  const params = { description: "Groceries", amount: "50.00" };

  it("schedules exactly the rows the insert returned: a duplicate the insert skipped is never pushed", async () => {
    mockPrisma.groupMember.findMany.mockResolvedValue([{ userId: 2 }, { userId: 3 }]);
    const inserted = [{ id: 9, userId: 3 }]; // userId 2's row was a duplicate (skipDuplicates)
    mockPrisma.notification.createManyAndReturn.mockResolvedValue(inserted);

    const created = await notificationService.create({
      groupId: 1,
      type: "DEBT_REMINDER",
      actorId: null,
      notices: [2, 3].map((userId) => ({ userId, params, dedupeKey: "DEBT_REMINDER:1:2026-W41" })),
    });

    expect(created).toBe(inserted);
    expect(mockSchedulePush).toHaveBeenCalledTimes(1);
    expect(mockSchedulePush.mock.calls[0][0]).toBe(inserted);
  });

  it("schedules only after the insert resolved, with the rows it resolved to", async () => {
    allActive();
    let resolveInsert!: (rows: unknown[]) => void;
    mockPrisma.notification.createManyAndReturn.mockReturnValue(new Promise((resolve) => (resolveInsert = resolve)));

    const created = notificationService.create({ groupId: 1, type: "EXPENSE_NEW", actorId: 7, notices: [{ userId: 3, params }] });
    await vi.waitFor(() => expect(mockPrisma.notification.createManyAndReturn).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0)); // let every pending continuation run: the insert is still open
    expect(mockSchedulePush).not.toHaveBeenCalled();

    const rows = [{ id: 9, userId: 3 }];
    resolveInsert(rows);
    expect(await created).toBe(rows);
    expect(mockSchedulePush).toHaveBeenCalledTimes(1);
    expect(mockSchedulePush.mock.calls[0][0]).toBe(rows);
  });

  it.each([
    ["only the actor", [7], []],
    ["no active recipient", [2], []],
  ])("nothing inserted (%s) → nothing scheduled", async (_label, userIds, members) => {
    mockPrisma.groupMember.findMany.mockResolvedValue(members);
    const created = await notificationService.create({
      groupId: 1,
      type: "EXPENSE_NEW",
      actorId: 7,
      notices: userIds.map((userId) => ({ userId, params })),
    });
    expect(created).toEqual([]);
    expect(mockSchedulePush).not.toHaveBeenCalled();
  });

  it("a failing insert schedules nothing and fails like before", async () => {
    mockPrisma.groupMember.findMany.mockResolvedValue([{ userId: 3 }]);
    mockPrisma.notification.createManyAndReturn.mockRejectedValue(new Error("db down"));
    await expect(
      notificationService.create({ groupId: 1, type: "EXPENSE_NEW", actorId: 7, notices: [{ userId: 3, params }] })
    ).rejects.toThrow("db down");
    expect(mockSchedulePush).not.toHaveBeenCalled();
  });
});

// ── Task 4: preferences ──────────────────────────────────────────────────────────────────────────────

describe("notificationService preferences (criteria 9, 13)", () => {
  const allOn = { EXPENSE_NEW: true, PAYMENT_RECEIVED: true, DEBT_REMINDER: true, RECURRING_DUE: true };

  it("getPreferences: every type defaults to on; stored overrides win", async () => {
    mockPrisma.notificationPreference.findMany.mockResolvedValueOnce([]);
    const defaults = await notificationService.getPreferences(3);
    expect(defaults).toEqual(allOn);
    expect(Object.keys(defaults)).toEqual([...NOTIFICATION_TYPES]); // enum order

    mockPrisma.notificationPreference.findMany.mockResolvedValueOnce([{ type: "DEBT_REMINDER", enabled: false }]);
    expect(await notificationService.getPreferences(3)).toEqual({ ...allOn, DEBT_REMINDER: false });
    expect(mockPrisma.notificationPreference.findMany).toHaveBeenLastCalledWith({
      where: { userId: 3 },
      select: { type: true, enabled: true },
    });
  });

  it("setPreference upserts the (user, type) override and returns the updated map", async () => {
    mockPrisma.notificationPreference.findMany.mockResolvedValue([{ type: "EXPENSE_NEW", enabled: false }]);
    const preferences = await notificationService.setPreference(3, { type: "EXPENSE_NEW", enabled: false });
    expect(mockPrisma.notificationPreference.upsert).toHaveBeenCalledWith({
      where: { userId_type: { userId: 3, type: "EXPENSE_NEW" } },
      create: { userId: 3, type: "EXPENSE_NEW", enabled: false },
      update: { enabled: false },
    });
    expect(preferences).toEqual({ ...allOn, EXPENSE_NEW: false });
  });

  it.each([
    ["an unknown type", { type: "SHOPPING_NEW", enabled: true }],
    ["a prototype key as type", { type: "toString", enabled: true }],
    ["a missing type", { enabled: true }],
    ["a non-boolean enabled", { type: "EXPENSE_NEW", enabled: "false" }],
    ["a missing enabled", { type: "EXPENSE_NEW" }],
    ["a non-object body", "EXPENSE_NEW"],
    ["a null body", null],
    ["an array body", [{ type: "EXPENSE_NEW", enabled: true }]],
  ])("setPreference rejects %s with 400 NOTIFICATION_PREF_INVALID and writes nothing", async (_label, body) => {
    await expect(notificationService.setPreference(3, body)).rejects.toMatchObject({
      status: 400,
      code: "NOTIFICATION_PREF_INVALID",
    });
    expect(mockPrisma.notificationPreference.upsert).not.toHaveBeenCalled();
  });
});

// ── Task 5: event producers ──────────────────────────────────────────────────────────────────────────

describe("notificationService.expenseCreated (criteria 4, 5)", () => {
  /** Prisma hands Decimal columns back as objects; toString is all the producer may rely on. */
  const decimal = (value: string) => ({ toString: () => value });
  const expense = {
    groupId: 1,
    publicId: "0192f0c4-0000-7000-8000-000000000001",
    description: "Dinner",
    amount: decimal("100.01"),
    payerId: 2,
    participants: [
      { userId: 7, amount: decimal("33.34") }, // the actor
      { userId: 3, amount: decimal("33.34") },
      { userId: 4, amount: decimal("0.00") }, // zero share
      { userId: 2, amount: decimal("33.33") }, // the payer also takes part
    ],
  };

  it("a member's expense: payer ∪ participants with a share > 0, minus the actor — one notice each, not recurring", async () => {
    allActive();
    await notificationService.expenseCreated(expense, 7);
    expect(mockPrisma.groupMember.findMany.mock.calls[0][0].where.userId).toEqual({ in: [2, 3] });
    expect(inserted().map((r) => [r.userId, r.type, r.actorId, r.groupId])).toEqual([
      [2, "EXPENSE_NEW", 7, 1],
      [3, "EXPENSE_NEW", 7, 1],
    ]);
    expect(inserted()[0].params).toEqual({
      expensePublicId: expense.publicId,
      description: "Dinner",
      amount: "100.01",
      recurring: false,
    });
  });

  it("a recurring posting (no actor): the payer is notified too and the notice is marked recurring", async () => {
    allActive();
    await notificationService.expenseCreated(expense, null);
    const rows = inserted();
    expect(rows.map((r) => [r.userId, r.actorId])).toEqual([
      [2, null],
      [7, null],
      [3, null],
    ]);
    expect(rows.every((r) => (r.params as { recurring: boolean }).recurring === true)).toBe(true);
  });

  it("amounts are 2-decimal strings computed in integer cents", async () => {
    allActive();
    await notificationService.expenseCreated({ ...expense, amount: 12.5, participants: [{ userId: 3, amount: "12.5" }] }, 7);
    expect(inserted().map((r) => (r.params as { amount: string }).amount)).toEqual(["12.50", "12.50"]);
  });
});

describe("notificationService.settlementCreated (criterion 6)", () => {
  // User 4 paid user 3; user 2 recorded it — any member may record a payment between two others.
  const settlement = { groupId: 1, publicId: "0192f0c4-0000-7000-8000-000000000002", fromUserId: 4, toUserId: 3, amount: "20" };

  it("notifies the recipient with the payment's id, payer and amount; the recorder is the actor", async () => {
    allActive();
    await notificationService.settlementCreated(settlement, 2);
    expect(inserted()).toEqual([
      expect.objectContaining({
        userId: 3,
        groupId: 1,
        type: "PAYMENT_RECEIVED",
        actorId: 2,
        params: { settlementPublicId: settlement.publicId, fromUserId: 4, amount: "20.00" },
        dedupeKey: null,
      }),
    ]);
  });

  it("a payment the recipient recorded themselves notifies nobody (no query)", async () => {
    expect(await notificationService.settlementCreated(settlement, 3)).toEqual([]);
    expect(mockPrisma.groupMember.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.notification.createManyAndReturn).not.toHaveBeenCalled();
  });
});

// ── Task 6: read side ────────────────────────────────────────────────────────────────────────────────

describe("notificationService read side — scoped by user + house (criteria 11, 12)", () => {
  const ID = "0192f0c4-0000-7000-8000-0000000000aa";
  const scope = { publicId: ID, userId: 3, groupId: 1 };
  const notFound = { status: 404, code: "NOTIFICATION_NOT_FOUND" };

  it("list: at most 50 of the member's notices in the house, newest first, as DTOs, plus the unread count", async () => {
    const createdAt = new Date("2026-10-04T12:00:00.000Z");
    mockPrisma.notification.findMany.mockResolvedValue([
      { publicId: ID, type: "EXPENSE_NEW", actorId: 2, params: { amount: "5.00" }, readAt: null, createdAt },
      { publicId: "b", type: "DEBT_REMINDER", actorId: null, params: { amount: "1.00" }, readAt: createdAt, createdAt },
    ]);
    mockPrisma.notification.count.mockResolvedValue(7);

    expect(await notificationService.list(3, 1)).toEqual({
      notifications: [
        { publicId: ID, type: "EXPENSE_NEW", actorId: 2, params: { amount: "5.00" }, read: false, createdAt: "2026-10-04T12:00:00.000Z" },
        { publicId: "b", type: "DEBT_REMINDER", actorId: null, params: { amount: "1.00" }, read: true, createdAt: "2026-10-04T12:00:00.000Z" },
      ],
      unreadCount: 7,
    });
    expect(mockPrisma.notification.findMany).toHaveBeenCalledWith({
      where: { userId: 3, groupId: 1 },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 50,
      select: { publicId: true, type: true, actorId: true, params: true, readAt: true, createdAt: true },
    });
    expect(mockPrisma.notification.count).toHaveBeenCalledWith({ where: { userId: 3, groupId: 1, readAt: null } });
  });

  it("list({ unreadOnly: true }) filters to unread notices", async () => {
    mockPrisma.notification.findMany.mockResolvedValue([]);
    mockPrisma.notification.count.mockResolvedValue(0);
    await notificationService.list(3, 1, { unreadOnly: true });
    expect(mockPrisma.notification.findMany.mock.calls[0][0].where).toEqual({ userId: 3, groupId: 1, readAt: null });
  });

  it("unreadCount counts the member's unread notices in the house", async () => {
    mockPrisma.notification.count.mockResolvedValue(4);
    expect(await notificationService.unreadCount(3, 1)).toBe(4);
    expect(mockPrisma.notification.count).toHaveBeenCalledWith({ where: { userId: 3, groupId: 1, readAt: null } });
  });

  it("markRead stamps an unread notice through the compound scope and returns the new unread count", async () => {
    mockPrisma.notification.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.notification.count.mockResolvedValue(2);
    expect(await notificationService.markRead(3, 1, ID)).toBe(2);
    expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith({
      where: { ...scope, readAt: null },
      data: { readAt: expect.any(Date) },
    });
    expect(mockPrisma.notification.findFirst).not.toHaveBeenCalled();
  });

  it("markRead is idempotent: an already-read notice keeps its first readAt and is not an error", async () => {
    mockPrisma.notification.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.notification.findFirst.mockResolvedValue({ id: 9 });
    mockPrisma.notification.count.mockResolvedValue(0);
    expect(await notificationService.markRead(3, 1, ID)).toBe(0);
    expect(mockPrisma.notification.findFirst).toHaveBeenCalledWith({ where: scope, select: { id: true } });
  });

  it("markRead: another member's or house's notice (not in the scope) is 404 NOTIFICATION_NOT_FOUND", async () => {
    mockPrisma.notification.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.notification.findFirst.mockResolvedValue(null);
    await expect(notificationService.markRead(3, 1, ID)).rejects.toMatchObject(notFound);
  });

  it.each([["markRead"], ["delete"]] as const)("%s: a malformed id is a 404 without touching the uuid column", async (method) => {
    await expect(notificationService[method](3, 1, "not-a-uuid")).rejects.toMatchObject(notFound);
    expect(mockPrisma.notification.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.notification.deleteMany).not.toHaveBeenCalled();
  });

  it("delete removes the notice through the compound scope and returns the new unread count", async () => {
    mockPrisma.notification.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.notification.count.mockResolvedValue(1);
    expect(await notificationService.delete(3, 1, ID)).toBe(1);
    expect(mockPrisma.notification.deleteMany).toHaveBeenCalledWith({ where: scope });
  });

  it("delete: nothing in the scope is 404 NOTIFICATION_NOT_FOUND", async () => {
    mockPrisma.notification.deleteMany.mockResolvedValue({ count: 0 });
    await expect(notificationService.delete(3, 1, ID)).rejects.toMatchObject(notFound);
  });

  it("markAllRead stamps only the member's unread notices in the house", async () => {
    mockPrisma.notification.updateMany.mockResolvedValue({ count: 3 });
    await notificationService.markAllRead(3, 1);
    expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith({
      where: { userId: 3, groupId: 1, readAt: null },
      data: { readAt: expect.any(Date) },
    });
  });
});

// ── Task 7: scheduled producers ──────────────────────────────────────────────────────────────────────

describe("reminderPeriod — due tomorrow in the rule's timezone (criterion 7, pure)", () => {
  const SP = "America/Sao_Paulo";
  const rule = (extra: Partial<{ dayOfMonth: number; timezone: string; skippedPeriods: string[] }> = {}) => ({
    dayOfMonth: 5,
    timezone: SP,
    skippedPeriods: [],
    ...extra,
  });
  const at = (iso: string) => new Date(iso);

  it("the day before the due date (09:00 in São Paulo = the job's 12:00 UTC) → that period", () => {
    expect(reminderPeriod(rule(), null, at("2026-10-04T12:00:00Z"))).toEqual({ period: "2026-10", dueOn: "2026-10-05", skipped: false });
  });

  it("not two days before, not on the due day", () => {
    expect(reminderPeriod(rule(), null, at("2026-10-03T12:00:00Z"))).toBeNull();
    expect(reminderPeriod(rule(), null, at("2026-10-05T12:00:00Z"))).toBeNull();
  });

  it("'tomorrow' is the rule's calendar date, never the server's (UTC) one", () => {
    // 02:30 UTC on the 5th is still the 4th (23:30) in São Paulo, already the due day in UTC.
    const lateEvening = at("2026-10-05T02:30:00Z");
    expect(reminderPeriod(rule(), null, lateEvening)?.dueOn).toBe("2026-10-05");
    expect(reminderPeriod(rule({ timezone: "UTC" }), null, lateEvening)).toBeNull();
    // 16:00 UTC on the 3rd is already the 4th (01:00) in Tokyo.
    expect(reminderPeriod(rule({ timezone: "Asia/Tokyo" }), null, at("2026-10-03T16:00:00Z"))?.dueOn).toBe("2026-10-05");
    expect(reminderPeriod(rule(), null, at("2026-10-03T16:00:00Z"))).toBeNull();
  });

  it("a skipped period gets no reminder; neither does a period already closed (posted early or skipped)", () => {
    const now = at("2026-10-04T12:00:00Z");
    expect(reminderPeriod(rule({ skippedPeriods: ["2026-10"] }), null, now)).toBeNull();
    expect(reminderPeriod(rule(), "2026-10", now)).toBeNull();
    expect(reminderPeriod(rule({ skippedPeriods: ["2026-11"] }), "2026-09", now)?.period).toBe("2026-10");
  });

  it("follows the clamped due date (31 → 30 Nov, 30 → 28 Feb) and crosses the year", () => {
    expect(reminderPeriod(rule({ dayOfMonth: 31 }), null, at("2026-11-29T12:00:00Z"))).toEqual({ period: "2026-11", dueOn: "2026-11-30", skipped: false });
    expect(reminderPeriod(rule({ dayOfMonth: 30 }), null, at("2027-02-27T12:00:00Z"))?.dueOn).toBe("2027-02-28");
    expect(reminderPeriod(rule({ dayOfMonth: 1 }), null, at("2026-12-31T12:00:00Z"))).toEqual({ period: "2027-01", dueOn: "2027-01-01", skipped: false });
  });

  it("follows the zone's DST switch (New York springs forward on 2026-03-08)", () => {
    const newYork = (dayOfMonth: number) => rule({ timezone: "America/New_York", dayOfMonth });
    // 04:30 UTC on the 9th is 00:30 EDT on the 9th: already the due day, no reminder.
    expect(reminderPeriod(newYork(9), null, at("2026-03-09T04:30:00Z"))).toBeNull();
    expect(reminderPeriod(newYork(9), null, at("2026-03-08T12:00:00Z"))).toEqual({ period: "2026-03", dueOn: "2026-03-09", skipped: false });
    // The same 04:30 UTC a week earlier is 23:30 EST the evening before: the offset really changed in between.
    expect(reminderPeriod(newYork(2), null, at("2026-03-02T04:30:00Z"))?.dueOn).toBe("2026-03-02");
  });
});

describe("notificationService.sendRecurringDueReminders (criteria 7, 17)", () => {
  const ruleRow = (id: number, extra: Record<string, unknown> = {}) => ({
    id,
    publicId: `rule-${id}`,
    groupId: 10,
    payerId: 2,
    description: "Rent",
    amount: { toString: () => "1800" },
    dayOfMonth: 5,
    timezone: "America/Sao_Paulo",
    skippedPeriods: [],
    ...extra,
  });
  const dayBefore = new Date("2026-10-04T12:00:00Z");

  it("reads unpaused rules and their last closed periods, reminds the payer once per (rule, period), returns the count", async () => {
    allActive();
    mockPrisma.recurringExpense.findMany.mockResolvedValue([ruleRow(1), ruleRow(2, { dayOfMonth: 20 })]);
    mockPrisma.recurringExpenseOccurrence.groupBy.mockResolvedValue([{ recurringExpenseId: 1, _max: { period: "2026-09" } }]);

    expect(await notificationService.sendRecurringDueReminders(dayBefore)).toEqual(run(1));

    expect(mockPrisma.recurringExpense.findMany.mock.calls[0][0].where).toEqual({ pausedAt: null });
    expect(mockPrisma.recurringExpenseOccurrence.groupBy).toHaveBeenCalledWith({
      by: ["recurringExpenseId"],
      where: { recurringExpenseId: { in: [1, 2] } },
      _max: { period: true },
    });
    expect(inserted()).toEqual([
      expect.objectContaining({
        userId: 2,
        groupId: 10,
        type: "RECURRING_DUE",
        actorId: null,
        params: { recurringExpensePublicId: "rule-1", description: "Rent", amount: "1800.00", dueOn: "2026-10-05" },
        dedupeKey: "RECURRING_DUE:1:2026-10",
      }),
    ]);
  });

  it("no unpaused rule: no further query", async () => {
    mockPrisma.recurringExpense.findMany.mockResolvedValue([]);
    expect(await notificationService.sendRecurringDueReminders(dayBefore)).toEqual(run(0));
    expect(mockPrisma.recurringExpenseOccurrence.groupBy).not.toHaveBeenCalled();
  });

  it("one broken rule is logged (ids only), counts as failed and does not cost the other rules their reminder", async () => {
    allActive();
    mockPrisma.recurringExpense.findMany.mockResolvedValue([ruleRow(1, { timezone: "Not/AZone" }), ruleRow(2), ruleRow(3)]);
    mockPrisma.recurringExpenseOccurrence.groupBy.mockResolvedValue([]);
    mockPrisma.notification.createManyAndReturn
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockImplementation(async (args: { data: unknown[] }) => args.data);

    expect(await notificationService.sendRecurringDueReminders(dayBefore)).toEqual(run(1, 2));
    expect(mockLogger.error).toHaveBeenCalledTimes(2);
    expect(mockLogger.error.mock.calls.map((c) => c[1])).toEqual([{ recurringExpenseId: 1 }, { recurringExpenseId: 2 }]);
  });

  describe("deadline (the cron route's budget, like postDue)", () => {
    afterEach(() => vi.useRealTimers());

    it("no reminder starts once the deadline passed: the due rules left over count in remaining, rules not due never do", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
      const deadline = new Date(Date.now() + 30_000);
      allActive();
      // Each insert takes 35 s on a slow database: the first one spends the whole budget.
      mockPrisma.notification.createManyAndReturn.mockImplementation(async (args: { data: unknown[] }) => {
        vi.setSystemTime(Date.now() + 35_000);
        return args.data;
      });
      mockPrisma.recurringExpense.findMany.mockResolvedValue([ruleRow(1), ruleRow(2, { dayOfMonth: 20 }), ruleRow(3), ruleRow(4)]);
      mockPrisma.recurringExpenseOccurrence.groupBy.mockResolvedValue([]);

      expect(await notificationService.sendRecurringDueReminders(dayBefore, { deadline })).toEqual(run(1, 0, 2));
      expect(inserted().map((r) => r.dedupeKey)).toEqual(["RECURRING_DUE:1:2026-10"]);
    });

    it("a deadline already passed sends nothing: every due rule is remaining", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
      allActive();
      mockPrisma.recurringExpense.findMany.mockResolvedValue([ruleRow(1), ruleRow(2)]);
      mockPrisma.recurringExpenseOccurrence.groupBy.mockResolvedValue([]);

      const deadline = new Date(Date.now() - 1);
      expect(await notificationService.sendRecurringDueReminders(dayBefore, { deadline })).toEqual(run(0, 0, 2));
      expect(mockPrisma.notification.createManyAndReturn).not.toHaveBeenCalled();
    });
  });
});

describe("notificationService.sendDebtReminders (criteria 8, 17)", () => {
  const monday = new Date("2026-10-05T12:00:00Z"); // ISO week 2026-W41
  const user = (id: number) => ({ id, name: `U${id}` });

  it.each([
    ["Sunday", "2026-10-04T12:00:00Z"],
    ["Tuesday", "2026-10-06T12:00:00Z"],
    ["Sunday 23:59 UTC (already Monday east of UTC)", "2026-10-04T23:59:00Z"],
  ])("does nothing on %s — no query at all", async (_label, iso) => {
    expect(await notificationService.sendDebtReminders(new Date(iso))).toEqual(run(0));
    expect(mockPrisma.group.findMany).not.toHaveBeenCalled();
    expect(mockBalance.aggregate).not.toHaveBeenCalled();
  });

  it("on a Monday (UTC): each member below zero after payments gets the absolute amount, keyed per house + ISO week", async () => {
    allActive();
    mockPrisma.group.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    mockBalance.aggregate.mockImplementation(async (groupId: number) =>
      groupId === 1
        ? [
            { userId: 1, userName: "U1", balance: 83.33 },
            { userId: 2, userName: "U2", balance: -50 },
            { userId: 3, userName: "U3", balance: -33.33 },
          ]
        : [{ userId: 4, userName: "U4", balance: 0 }]
    );
    // U2 paid U1 20 of their 50.
    mockSettlements.list.mockImplementation(async (groupId: number) =>
      groupId === 1 ? [{ fromUserId: 2, toUserId: 1, fromUser: user(2), toUser: user(1), amount: "20" }] : []
    );

    expect(await notificationService.sendDebtReminders(new Date("2026-10-05T00:00:00Z"))).toEqual(run(2));

    expect(mockPrisma.group.findMany).toHaveBeenCalledWith({
      where: { members: { some: { leftAt: null } } },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    expect(inserted().map((r) => [r.groupId, r.userId, r.type, r.actorId, r.params, r.dedupeKey])).toEqual([
      [1, 2, "DEBT_REMINDER", null, { amount: "30.00" }, "DEBT_REMINDER:1:2026-W41"],
      [1, 3, "DEBT_REMINDER", null, { amount: "33.33" }, "DEBT_REMINDER:1:2026-W41"],
    ]);
  });

  it("a house nobody owes in creates nothing; one failing house is logged, counts as failed and the next one still runs", async () => {
    allActive();
    mockPrisma.group.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]);
    mockBalance.aggregate.mockImplementation(async (groupId: number) => {
      if (groupId === 1) throw new Error("timeout");
      return groupId === 2
        ? [{ userId: 4, userName: "U4", balance: 10 }, { userId: 5, userName: "U5", balance: -10 }]
        : [{ userId: 6, userName: "U6", balance: 0 }];
    });
    // House 2's debt was paid in full; house 3 never had one.
    mockSettlements.list.mockImplementation(async (groupId: number) =>
      groupId === 2 ? [{ fromUserId: 5, toUserId: 4, fromUser: user(5), toUser: user(4), amount: "10" }] : []
    );

    expect(await notificationService.sendDebtReminders(monday)).toEqual(run(0, 1));
    expect(mockBalance.aggregate).toHaveBeenCalledTimes(3);
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    expect(mockLogger.error.mock.calls[0][1]).toEqual({ groupId: 1 });
    expect(mockPrisma.groupMember.findMany).not.toHaveBeenCalled();
  });

  it("deadline: no house starts once it passed; the houses left over count in remaining", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(monday);
      const deadline = new Date(Date.now() + 30_000);
      allActive();
      mockPrisma.group.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]);
      // Each house's balances take 35 s on a slow database: the first house spends the whole budget.
      mockBalance.aggregate.mockImplementation(async (groupId: number) => {
        vi.setSystemTime(Date.now() + 35_000);
        return [{ userId: groupId * 10, userName: "U", balance: -5 }];
      });
      mockSettlements.list.mockResolvedValue([]);

      expect(await notificationService.sendDebtReminders(monday, { deadline })).toEqual(run(1, 0, 2));
      expect(mockBalance.aggregate).toHaveBeenCalledTimes(1);
      expect(inserted().map((r) => r.dedupeKey)).toEqual(["DEBT_REMINDER:1:2026-W41"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("notificationService.prune (criterion 18)", () => {
  it("deletes notices older than 90 days and returns how many", async () => {
    mockPrisma.notification.deleteMany.mockResolvedValue({ count: 4 });
    expect(await notificationService.prune(new Date("2026-10-04T12:00:00.000Z"))).toBe(4);
    expect(mockPrisma.notification.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: new Date("2026-07-06T12:00:00.000Z") } },
    });
  });
});

// ── Task 8: account deletion ─────────────────────────────────────────────────────────────────────────

describe("authService.deleteAccount removes the member's notices and preferences (criterion 19)", () => {
  it("deletes both inside the deletion transaction (through tx, never the global client)", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 7, password: null });
    const tx = {
      groupMember: { updateMany: vi.fn() },
      user: { update: vi.fn() },
      notification: { deleteMany: vi.fn() },
      notificationPreference: { deleteMany: vi.fn() },
      pushSubscription: { deleteMany: vi.fn() }, // spec 010 (its own case in auth.service.test.ts)
    };
    mockPrisma.$transaction.mockImplementation(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx));

    expect(await authService.deleteAccount(7, undefined)).toEqual({ ok: true });

    expect(tx.notification.deleteMany).toHaveBeenCalledWith({ where: { userId: 7 } });
    expect(tx.notificationPreference.deleteMany).toHaveBeenCalledWith({ where: { userId: 7 } });
    expect(tx.user.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.notification.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.notificationPreference.deleteMany).not.toHaveBeenCalled();
  });

  it("a refused deletion deletes nothing", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 7, password: "hash" });
    expect(await authService.deleteAccount(7, undefined)).toMatchObject({ code: "CURRENT_PASSWORD_REQUIRED" });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});
