import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as ApiHelpers from "@/lib/api-helpers";
import type * as NextServer from "next/server";

// The real route, validation, ExpenseService and notifySafely run; only the session gate, the activity log, the
// member lookups, the notice producer and the Prisma client are faked (no pglite socket: see
// groups/active/currency/route.test.ts). Next's after() needs a real request scope: it is faked to keep the
// callbacks, which a test runs once the response is in hand.
const {
  mockRequireActiveGroup,
  mockRecordActivity,
  mockAllActiveGroupMembers,
  mockListMembers,
  mockExpenseCreate,
  mockExpenseCreated,
  mockLogError,
  mockAfter,
  afterCallbacks,
} = vi.hoisted(() => ({
  mockRequireActiveGroup: vi.fn(),
  mockRecordActivity: vi.fn(),
  mockAllActiveGroupMembers: vi.fn(),
  mockListMembers: vi.fn(),
  mockExpenseCreate: vi.fn(),
  mockExpenseCreated: vi.fn(),
  mockLogError: vi.fn(),
  mockAfter: vi.fn(),
  afterCallbacks: [] as Array<() => unknown>,
}));
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof NextServer>();
  return { ...actual, after: mockAfter };
});
vi.mock("@/lib/api-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiHelpers>();
  return {
    ...actual,
    requireActiveGroup: mockRequireActiveGroup,
    recordActivity: mockRecordActivity,
    allActiveGroupMembers: mockAllActiveGroupMembers,
  };
});
vi.mock("@/services/group.service", () => ({ groupService: { listMembers: mockListMembers } }));
vi.mock("@/lib/prisma", () => ({ prisma: { expense: { create: mockExpenseCreate } } }));
vi.mock("@/services/notification.service", () => ({ notificationService: { expenseCreated: mockExpenseCreated } }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: mockLogError } }));

import { POST } from "./route";

const session = { userId: 1, publicId: "actor", name: "Ana", sessionVersion: 1, iat: 0 };

beforeEach(() => {
  vi.resetAllMocks();
  mockRequireActiveGroup.mockResolvedValue({ ok: true, session, groupId: 7, role: "MEMBER" });
  mockAllActiveGroupMembers.mockResolvedValue(true);
  mockListMembers.mockResolvedValue([
    { id: 1, active: true },
    { id: 2, active: true },
  ]);
  mockExpenseCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 10,
    ...data,
    amount: String(data.amount),
  }));
  mockExpenseCreated.mockResolvedValue([]);
  afterCallbacks.length = 0;
  mockAfter.mockImplementation((callback: () => unknown) => void afterCallbacks.push(callback));
});

const post = (payload: Record<string, unknown>) =>
  POST(new Request("http://localhost/api/expenses", { method: "POST", body: JSON.stringify(payload) }));

/** What Next runs once the response is sent. */
const runAfter = async () => {
  for (const callback of afterCallbacks.splice(0)) await callback();
};

describe("POST /api/expenses — a client cannot mark an expense as recurring (spec 008, criterion 20)", () => {
  it("ignores recurringExpenseId in the body: the expense is created with recurringExpenseId null", async () => {
    const res = await POST(
      new Request("http://localhost/api/expenses", {
        method: "POST",
        body: JSON.stringify({ description: "Rent", amount: 100, payerId: 1, splitEqually: true, recurringExpenseId: 99 }),
      })
    );

    expect(res.status).toBe(201);
    expect(mockExpenseCreate).toHaveBeenCalledTimes(1);
    const data = mockExpenseCreate.mock.calls[0][0].data;
    expect(data.groupId).toBe(7);
    expect(data.recurringExpenseId).toBeNull();
    expect((await res.json()).expense.recurringExpenseId).toBeNull();
  });
});

describe("POST /api/expenses — EXPENSE_NEW notices (spec 009, criteria 4 and 10)", () => {
  const body = { description: "Groceries", amount: 90, payerId: 1, splitEqually: true };

  it("notifies through the producer after the activity entry, with the created expense and the session user as actor", async () => {
    const res = await post(body);
    await runAfter();

    expect(res.status).toBe(201);
    const { expense } = await res.json();
    expect(mockExpenseCreated).toHaveBeenCalledTimes(1);
    const [notified, actorId] = mockExpenseCreated.mock.calls[0];
    expect(notified).toMatchObject({ groupId: 7, publicId: expense.publicId, description: "Groceries", payerId: 1 });
    expect(actorId).toBe(1);
    expect(mockRecordActivity.mock.invocationCallOrder[0]).toBeLessThan(mockExpenseCreated.mock.invocationCallOrder[0]);
  });

  // Criterion 10 "never slow down": the producer runs through after(), once the response is out.
  it("answers before the producer runs: the notice is handed to after() and produced only then", async () => {
    const res = await post(body);

    expect(res.status).toBe(201);
    expect(mockAfter).toHaveBeenCalledTimes(1);
    expect(mockExpenseCreated).not.toHaveBeenCalled();

    await runAfter();
    expect(mockExpenseCreated).toHaveBeenCalledTimes(1);
  });

  it("a producer that never settles does not hold the response", async () => {
    mockExpenseCreated.mockReturnValue(new Promise(() => {}));
    // Next starts the callback without the request waiting on it.
    mockAfter.mockImplementation((callback: () => unknown) => void callback());

    const res = await post(body);

    expect(res.status).toBe(201);
    expect(mockExpenseCreated).toHaveBeenCalledTimes(1);
  });

  it("a throwing notification service still answers 201 with the same expense, and the failure is logged", async () => {
    mockExpenseCreated.mockRejectedValue(new Error("connection reset"));

    const res = await post(body);
    await runAfter();

    expect(res.status).toBe(201);
    const { expense } = await res.json();
    expect(expense).toMatchObject({ groupId: 7, description: "Groceries", payerId: 1 });
    expect(mockExpenseCreate).toHaveBeenCalledTimes(1);
    expect(mockLogError).toHaveBeenCalledWith("notification failed", { type: "EXPENSE_NEW" }, expect.any(Error));
  });

  it("a rejected expense notifies nobody", async () => {
    const res = await post({ ...body, amount: 0 });
    await runAfter();

    expect(res.status).toBe(400);
    expect(mockAfter).not.toHaveBeenCalled();
    expect(mockExpenseCreated).not.toHaveBeenCalled();
  });
});
