import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextResponse } from "next/server";
import { ApiError } from "@/lib/errors";
import type * as ApiHelpers from "@/lib/api-helpers";

// Same setup as ../../route.test.ts: session gate, activity log and service are faked (no pglite socket).
// Which periods may be skipped (the next 3), the ledger conflict and ownership are the service's rules,
// asserted by recurring-expense.service.test.ts and tenant-isolation.test.ts; here only the route contract.
const { mockRequireActiveGroup, mockRecordActivity, mockSkip, mockUnskip, mockPostDue } = vi.hoisted(() => ({
  mockRequireActiveGroup: vi.fn(),
  mockRecordActivity: vi.fn(),
  mockSkip: vi.fn(),
  mockUnskip: vi.fn(),
  mockPostDue: vi.fn(),
}));
vi.mock("@/lib/api-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiHelpers>();
  return { ...actual, requireActiveGroup: mockRequireActiveGroup, recordActivity: mockRecordActivity };
});
vi.mock("@/services/recurring-expense.service", () => ({
  recurringExpenseService: { skip: mockSkip, unskip: mockUnskip, postDue: mockPostDue },
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
// handleApiError reads the request headers and talks to Sentry: both are irrelevant to these contracts.
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
vi.mock("@sentry/nextjs", () => ({ getClient: () => undefined, flush: async () => true, addBreadcrumb: () => {} }));

import { PUT, DELETE } from "./route";

const NOW = new Date("2026-10-05T11:30:00.000Z");
const session = { userId: 1, publicId: "actor", name: "Ana", sessionVersion: 1, iat: 0 };
const viewer = { userId: 1, role: "MEMBER" };
const PUBLIC_ID = "0198f6a0-0000-7000-8000-000000000001";

const ruleDto = (skippedPeriods: string[]) => ({
  publicId: PUBLIC_ID,
  description: "Rent",
  amount: "1800.00",
  dayOfMonth: 5,
  payerId: 1,
  splitMode: "ALL",
  participantIds: [],
  timezone: "America/Sao_Paulo",
  activeFrom: "2026-10-01",
  paused: false,
  pauseReason: null,
  skippedPeriods,
  lastClosedPeriod: null,
  upcoming: [{ period: "2026-11", dueOn: "2026-11-05", skipped: skippedPeriods.includes("2026-11") }],
  canManage: true,
  updatedAt: "2026-10-05T11:30:00.000Z",
});

const call = (handler: typeof PUT, method: string, period: string) =>
  handler(new Request(`http://localhost/api/recurring-expenses/${PUBLIC_ID}/skips/${period}`, { method }), {
    params: Promise.resolve({ recurringExpenseId: PUBLIC_ID, period }),
  });

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  mockRequireActiveGroup.mockResolvedValue({ ok: true, session, groupId: 7, role: "MEMBER" });
  mockSkip.mockResolvedValue({ id: 42, rule: ruleDto(["2026-11"]), changed: true });
  mockUnskip.mockResolvedValue({ id: 42, rule: ruleDto([]), changed: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe.each([
  { verb: "PUT", handler: PUT, service: () => mockSkip, other: () => mockUnskip, action: "SKIP", skipped: ["2026-11"] },
  { verb: "DELETE", handler: DELETE, service: () => mockUnskip, other: () => mockSkip, action: "UNSKIP", skipped: [] as string[] },
])("$verb /api/recurring-expenses/[id]/skips/[period] (spec 008 — criteria 15, 18, 24)", ({ verb, handler, service, other, action, skipped }) => {
  it(`calls ${action === "SKIP" ? "skip" : "unskip"} for the active house, the caller and the period, answering 200 { rule }`, async () => {
    const res = await call(handler, verb, "2026-11");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rule: ruleDto(skipped) });
    expect(service()).toHaveBeenCalledWith(7, viewer, PUBLIC_ID, "2026-11", NOW);
    expect(other()).not.toHaveBeenCalled();
  });

  it(`records one ${action} entry for the caller with the period, and never posts`, async () => {
    await call(handler, verb, "2026-11");

    expect(mockRecordActivity).toHaveBeenCalledTimes(1);
    expect(mockRecordActivity).toHaveBeenCalledWith({
      groupId: 7,
      actorId: 1,
      entityType: "RECURRING_EXPENSE",
      entityId: PUBLIC_ID,
      action,
      summary: "Rent",
      changes: { period: "2026-11" },
    });
    expect(mockPostDue).not.toHaveBeenCalled();
  });

  it("is idempotent: repeating it is a 200 with the rule and records nothing", async () => {
    service().mockResolvedValue({ id: 42, rule: ruleDto(skipped), changed: false });

    const res = await call(handler, verb, "2026-11");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rule: ruleDto(skipped) });
    expect(mockRecordActivity).not.toHaveBeenCalled();
  });

  it.each(["2026-13", "2026-00", "2026-1", "26-11", "2026-11-05", "november", "2026/11", "2026-11 ", ""])(
    "rejects the malformed period %j with 400 RECURRING_PERIOD_INVALID before touching the rule",
    async (period) => {
      const res = await call(handler, verb, period);

      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("RECURRING_PERIOD_INVALID");
      expect(service()).not.toHaveBeenCalled();
      expect(mockRecordActivity).not.toHaveBeenCalled();
    }
  );

  it("returns the service's 400 RECURRING_PERIOD_INVALID for a month beyond the next 3", async () => {
    service().mockRejectedValue(new ApiError("Only the next 3 months can be skipped", 400, "RECURRING_PERIOD_INVALID"));

    const res = await call(handler, verb, "2027-06");

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("RECURRING_PERIOD_INVALID");
    expect(mockRecordActivity).not.toHaveBeenCalled();
  });

  it("returns 409 RECURRING_PERIOD_CLOSED for a month already posted or skipped", async () => {
    service().mockRejectedValue(new ApiError("This month was already posted or skipped", 409, "RECURRING_PERIOD_CLOSED"));

    const res = await call(handler, verb, "2026-10");

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("RECURRING_PERIOD_CLOSED");
    expect(mockRecordActivity).not.toHaveBeenCalled();
  });

  it("returns 403 NOT_RECURRING_OWNER and records nothing", async () => {
    service().mockRejectedValue(new ApiError("Only the payer or a house admin can change this rule", 403, "NOT_RECURRING_OWNER"));

    const res = await call(handler, verb, "2026-11");

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("NOT_RECURRING_OWNER");
    expect(mockRecordActivity).not.toHaveBeenCalled();
  });

  it("returns 404 RECURRING_NOT_FOUND (a missing rule or another house's) and records nothing", async () => {
    service().mockRejectedValue(new ApiError("Recurring expense not found in this house", 404, "RECURRING_NOT_FOUND"));

    const res = await call(handler, verb, "2026-11");

    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("RECURRING_NOT_FOUND");
    expect(mockRecordActivity).not.toHaveBeenCalled();
  });

  it("returns the session/house failure untouched", async () => {
    mockRequireActiveGroup.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "NOT_AUTHENTICATED" }, { status: 401 }),
    });

    const res = await call(handler, verb, "2026-11");

    expect(res.status).toBe(401);
    expect(service()).not.toHaveBeenCalled();
  });

  it("maps an unexpected failure to a generic 500 without leaking its message", async () => {
    service().mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432 user=postgres"));

    const res = await call(handler, verb, "2026-11");

    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).toContain(action === "SKIP" ? "Failed to skip month" : "Failed to undo skip");
    expect(text).not.toContain("ECONNREFUSED");
    expect(mockRecordActivity).not.toHaveBeenCalled();
  });
});
