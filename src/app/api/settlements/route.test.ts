import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as ApiHelpers from "@/lib/api-helpers";
import type * as NextServer from "next/server";

// The real route, validation and notifySafely run; the session gate, the activity log, the membership check,
// the settlement service and the notice producer are faked (no pglite socket). Next's after() needs a real request
// scope: it is faked to keep the callbacks, which a test runs once the response is in hand.
const {
  mockRequireActiveGroup,
  mockRecordActivity,
  mockAllGroupMembers,
  mockSettlementCreate,
  mockSettlementCreated,
  mockLogError,
  mockAfter,
  afterCallbacks,
} = vi.hoisted(() => ({
  mockRequireActiveGroup: vi.fn(),
  mockRecordActivity: vi.fn(),
  mockAllGroupMembers: vi.fn(),
  mockSettlementCreate: vi.fn(),
  mockSettlementCreated: vi.fn(),
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
    allGroupMembers: mockAllGroupMembers,
  };
});
vi.mock("@/services/settlement.service", () => ({ settlementService: { create: mockSettlementCreate } }));
vi.mock("@/services/notification.service", () => ({ notificationService: { settlementCreated: mockSettlementCreated } }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: mockLogError } }));

import { POST } from "./route";

// Dan (the session user) records that Bob paid Ana: any member may record a payment between two others.
const session = { userId: 4, publicId: "dan", name: "Dan", sessionVersion: 1, iat: 0 };
const SETTLEMENT = {
  id: 30,
  publicId: "0192f0c4-0000-7000-8000-000000000030",
  groupId: 7,
  fromUserId: 2,
  toUserId: 1,
  amount: "20.5",
  note: null,
  date: "2026-10-04T12:00:00.000Z",
  createdById: 4,
  fromUser: { id: 2, name: "Bob" },
  toUser: { id: 1, name: "Ana" },
};
const body = { fromUserId: 2, toUserId: 1, amount: 20.5 };

const post = (payload: Record<string, unknown>) =>
  POST(new Request("http://localhost/api/settlements", { method: "POST", body: JSON.stringify(payload) }));

/** What Next runs once the response is sent. */
const runAfter = async () => {
  for (const callback of afterCallbacks.splice(0)) await callback();
};

beforeEach(() => {
  vi.resetAllMocks();
  mockRequireActiveGroup.mockResolvedValue({ ok: true, session, groupId: 7, role: "MEMBER" });
  mockAllGroupMembers.mockResolvedValue(true);
  mockSettlementCreate.mockResolvedValue(SETTLEMENT);
  mockSettlementCreated.mockResolvedValue([]);
  afterCallbacks.length = 0;
  mockAfter.mockImplementation((callback: () => unknown) => void afterCallbacks.push(callback));
});

describe("POST /api/settlements — PAYMENT_RECEIVED notice (spec 009, criteria 6 and 10)", () => {
  it("records the payment in the active house, then notifies with the settlement and the recorder as actor", async () => {
    const res = await post(body);
    await runAfter();

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ settlement: SETTLEMENT });
    expect(mockSettlementCreate).toHaveBeenCalledWith(7, expect.objectContaining({ ...body, createdById: 4 }));
    expect(mockSettlementCreated).toHaveBeenCalledTimes(1);
    expect(mockSettlementCreated).toHaveBeenCalledWith(SETTLEMENT, 4);
    expect(mockRecordActivity.mock.invocationCallOrder[0]).toBeLessThan(mockSettlementCreated.mock.invocationCallOrder[0]);
  });

  // Criterion 10 "never slow down": the producer runs through after(), once the response is out.
  it("answers before the producer runs: the notice is handed to after() and produced only then", async () => {
    const res = await post(body);

    expect(res.status).toBe(201);
    expect(mockAfter).toHaveBeenCalledTimes(1);
    expect(mockSettlementCreated).not.toHaveBeenCalled();

    await runAfter();
    expect(mockSettlementCreated).toHaveBeenCalledWith(SETTLEMENT, 4);
  });

  it("a producer that never settles does not hold the response", async () => {
    mockSettlementCreated.mockReturnValue(new Promise(() => {}));
    // Next starts the callback without the request waiting on it.
    mockAfter.mockImplementation((callback: () => unknown) => void callback());

    const res = await post(body);

    expect(res.status).toBe(201);
    expect(mockSettlementCreated).toHaveBeenCalledTimes(1);
  });

  it("a throwing notification service still answers 201 with the same settlement, and the failure is logged", async () => {
    mockSettlementCreated.mockRejectedValue(new Error("connection reset"));

    const res = await post(body);
    await runAfter();

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ settlement: SETTLEMENT });
    expect(mockLogError).toHaveBeenCalledWith("notification failed", { type: "PAYMENT_RECEIVED" }, expect.any(Error));
  });

  it("a rejected payment notifies nobody", async () => {
    const invalid = await post({ ...body, toUserId: 2 });
    expect(invalid.status).toBe(400);

    mockAllGroupMembers.mockResolvedValue(false);
    const outsider = await post(body);
    expect(outsider.status).toBe(400);
    await runAfter();

    expect(mockAfter).not.toHaveBeenCalled();

    expect(mockSettlementCreate).not.toHaveBeenCalled();
    expect(mockSettlementCreated).not.toHaveBeenCalled();
  });
});
