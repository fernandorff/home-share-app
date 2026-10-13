import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextResponse } from "next/server";
import { ApiError } from "@/lib/errors";
import type * as ApiHelpers from "@/lib/api-helpers";

// Same setup as ../route.test.ts: session gate, activity log and service are faked (no pglite socket).
// The service's own rules — ownership, house scoping, the stale token, resume re-validating members — are
// asserted by recurring-expense.service.test.ts and tenant-isolation.test.ts; here only the route's contract:
// pause/resume vs field edit, what is recorded in the Summary feed and when the rule posts synchronously.
const { mockRequireActiveGroup, mockRecordActivity, mockUpdate, mockSetPaused, mockDelete, mockGet, mockPostDue, mockLogError } =
  vi.hoisted(() => ({
    mockRequireActiveGroup: vi.fn(),
    mockRecordActivity: vi.fn(),
    mockUpdate: vi.fn(),
    mockSetPaused: vi.fn(),
    mockDelete: vi.fn(),
    mockGet: vi.fn(),
    mockPostDue: vi.fn(),
    mockLogError: vi.fn(),
  }));
vi.mock("@/lib/api-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiHelpers>();
  return { ...actual, requireActiveGroup: mockRequireActiveGroup, recordActivity: mockRecordActivity };
});
vi.mock("@/services/recurring-expense.service", () => ({
  recurringExpenseService: {
    update: mockUpdate,
    setPaused: mockSetPaused,
    delete: mockDelete,
    get: mockGet,
    postDue: mockPostDue,
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: mockLogError } }));
// handleApiError reads the request headers and talks to Sentry: both are irrelevant to these contracts.
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
vi.mock("@sentry/nextjs", () => ({ getClient: () => undefined, flush: async () => true, addBreadcrumb: () => {} }));

import { PATCH, DELETE } from "./route";

const NOW = new Date("2026-10-05T11:30:00.000Z");
const session = { userId: 1, publicId: "actor", name: "Ana", sessionVersion: 1, iat: 0 };
const viewer = { userId: 1, role: "MEMBER" };
const PUBLIC_ID = "0198f6a0-0000-7000-8000-000000000001";
const TOKEN = "2026-10-01T10:00:00.000Z";
const NO_RUN = { posted: 0, skipped: 0, paused: 0, duplicates: 0, failed: 0, remaining: 0 };

const ruleDto = (overrides: Record<string, unknown> = {}) => ({
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
  skippedPeriods: [],
  lastClosedPeriod: null,
  upcoming: [{ period: "2026-10", dueOn: "2026-10-05", skipped: false }],
  canManage: true,
  updatedAt: TOKEN,
  ...overrides,
});

const context = { params: Promise.resolve({ recurringExpenseId: PUBLIC_ID }) };
const patch = (payload: unknown) =>
  PATCH(
    new Request(`http://localhost/api/recurring-expenses/${PUBLIC_ID}`, {
      method: "PATCH",
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    }),
    context
  );
const remove = () =>
  DELETE(new Request(`http://localhost/api/recurring-expenses/${PUBLIC_ID}`, { method: "DELETE" }), context);

const activityCalls = () => mockRecordActivity.mock.calls.map(([entry]) => entry);

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  mockRequireActiveGroup.mockResolvedValue({ ok: true, session, groupId: 7, role: "MEMBER" });
  mockSetPaused.mockResolvedValue({ id: 42, rule: ruleDto({ paused: true }), changed: true });
  mockUpdate.mockResolvedValue({
    id: 42,
    rule: ruleDto({ description: "Rent (new)" }),
    changes: { description: { from: "Rent", to: "Rent (new)" } },
    changed: true,
  });
  mockPostDue.mockResolvedValue(NO_RUN);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PATCH /api/recurring-expenses/[id] — pause and resume (spec 008 — criterion 14)", () => {
  it("pauses through the service for the active house and the caller, answering 200 { rule, postedNow: 0 }", async () => {
    const res = await patch({ paused: true });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rule: ruleDto({ paused: true }), postedNow: 0 });
    expect(mockSetPaused).toHaveBeenCalledWith(7, viewer, PUBLIC_ID, true, NOW);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("records a PAUSE entry for the caller and posts nothing", async () => {
    await patch({ paused: true });

    expect(activityCalls()).toEqual([
      { groupId: 7, actorId: 1, entityType: "RECURRING_EXPENSE", entityId: PUBLIC_ID, action: "PAUSE", summary: "Rent" },
    ]);
    expect(mockPostDue).not.toHaveBeenCalled();
  });

  it("resumes, records a RESUME entry and posts that rule only, in case it is due today", async () => {
    mockSetPaused.mockResolvedValue({ id: 42, rule: ruleDto(), changed: true });

    const res = await patch({ paused: false });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rule: ruleDto(), postedNow: 0 });
    expect(mockSetPaused).toHaveBeenCalledWith(7, viewer, PUBLIC_ID, false, NOW);
    expect(activityCalls()).toEqual([
      { groupId: 7, actorId: 1, entityType: "RECURRING_EXPENSE", entityId: PUBLIC_ID, action: "RESUME", summary: "Rent" },
    ]);
    expect(mockPostDue).toHaveBeenCalledWith(NOW, { recurringExpenseId: 42 });
    expect(mockRecordActivity.mock.invocationCallOrder[0]).toBeLessThan(mockPostDue.mock.invocationCallOrder[0]);
  });

  it("re-reads the rule when the resume posted, so upcoming and lastClosedPeriod are not stale", async () => {
    const reloaded = ruleDto({ lastClosedPeriod: "2026-10" });
    mockSetPaused.mockResolvedValue({ id: 42, rule: ruleDto(), changed: true });
    mockPostDue.mockResolvedValue({ ...NO_RUN, posted: 1 });
    mockGet.mockResolvedValue(reloaded);

    const res = await patch({ paused: false });

    expect(await res.json()).toEqual({ rule: reloaded, postedNow: 1 });
    expect(mockGet).toHaveBeenCalledWith(7, viewer, PUBLIC_ID, NOW);
  });

  it("re-reads the rule when the resume only wrote a skipped ledger row, auto-paused it or lost the claim", async () => {
    const reloaded = ruleDto({ lastClosedPeriod: "2026-10" });
    mockSetPaused.mockResolvedValue({ id: 42, rule: ruleDto(), changed: true });
    mockGet.mockResolvedValue(reloaded);

    for (const counts of [{ skipped: 1 }, { paused: 1 }, { duplicates: 1 }]) {
      mockGet.mockClear();
      mockPostDue.mockResolvedValue({ ...NO_RUN, ...counts });

      const res = await patch({ paused: false });

      expect(await res.json()).toEqual({ rule: reloaded, postedNow: 0 });
      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(mockGet).toHaveBeenCalledWith(7, viewer, PUBLIC_ID, NOW);
    }
  });

  it("never turns a saved resume into a 500: if the synchronous posting throws, it answers 200 with the saved rule", async () => {
    mockSetPaused.mockResolvedValue({ id: 42, rule: ruleDto(), changed: true });
    mockPostDue.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432"));

    const res = await patch({ paused: false });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rule: ruleDto(), postedNow: 0 });
    expect(mockLogError).toHaveBeenCalledTimes(1);
  });

  it("sending the current pause state is a 200 no-op: no entry, no posting", async () => {
    mockSetPaused.mockResolvedValue({ id: 42, rule: ruleDto({ paused: true }), changed: false });
    expect((await patch({ paused: true })).status).toBe(200);

    mockSetPaused.mockResolvedValue({ id: 42, rule: ruleDto(), changed: false });
    const res = await patch({ paused: false });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rule: ruleDto(), postedNow: 0 });
    expect(mockRecordActivity).not.toHaveBeenCalled();
    expect(mockPostDue).not.toHaveBeenCalled();
  });

  it("refuses paused mixed with editable fields with 400 RECURRING_PATCH_INVALID", async () => {
    const res = await patch({ paused: true, description: "Rent (new)", expectedUpdatedAt: TOKEN });

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("RECURRING_PATCH_INVALID");
    expect(mockSetPaused).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockRecordActivity).not.toHaveBeenCalled();
  });

  it("refuses a paused that is not a boolean with 400 RECURRING_PATCH_INVALID", async () => {
    for (const paused of ["true", 1, null]) {
      const res = await patch({ paused });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("RECURRING_PATCH_INVALID");
    }
    expect(mockSetPaused).not.toHaveBeenCalled();
  });

  it("accepts expectedGroupId and expectedUpdatedAt next to paused: they are not fields", async () => {
    const res = await patch({ paused: true, expectedGroupId: 7, expectedUpdatedAt: TOKEN });

    expect(res.status).toBe(200);
    expect(mockSetPaused).toHaveBeenCalledTimes(1);
  });

  it("returns the service's 403 NOT_RECURRING_OWNER and records nothing", async () => {
    mockSetPaused.mockRejectedValue(new ApiError("Only the payer or a house admin can change this rule", 403, "NOT_RECURRING_OWNER"));

    const res = await patch({ paused: true });

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("NOT_RECURRING_OWNER");
    expect(mockRecordActivity).not.toHaveBeenCalled();
  });

  it("returns the service's 400 RECURRING_MEMBER_INACTIVE when resuming with a member who left", async () => {
    mockSetPaused.mockRejectedValue(new ApiError("The payer and every participant must be active members of this house", 400, "RECURRING_MEMBER_INACTIVE"));

    const res = await patch({ paused: false });

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("RECURRING_MEMBER_INACTIVE");
    expect(mockRecordActivity).not.toHaveBeenCalled();
    expect(mockPostDue).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/recurring-expenses/[id] — field edit (spec 008 — criterion 16)", () => {
  const edit = { description: "Rent (new)", amount: 1900, expectedUpdatedAt: TOKEN };

  it("edits through the service with the stale-token the form sent, answering 200 { rule, postedNow: 0 }", async () => {
    const res = await patch(edit);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rule: ruleDto({ description: "Rent (new)" }), postedNow: 0 });
    expect(mockUpdate).toHaveBeenCalledWith(7, viewer, PUBLIC_ID, edit, TOKEN, NOW);
    expect(mockSetPaused).not.toHaveBeenCalled();
  });

  it("records an UPDATE entry for the caller with the before/after of the changed fields", async () => {
    await patch(edit);

    expect(activityCalls()).toEqual([
      {
        groupId: 7,
        actorId: 1,
        entityType: "RECURRING_EXPENSE",
        entityId: PUBLIC_ID,
        action: "UPDATE",
        summary: "Rent (new)",
        changes: { description: { from: "Rent", to: "Rent (new)" } },
      },
    ]);
  });

  it("posts that rule synchronously after the edit, after the Summary entry (a day moved to today posts now)", async () => {
    await patch(edit);

    expect(mockPostDue).toHaveBeenCalledTimes(1);
    expect(mockPostDue).toHaveBeenCalledWith(NOW, { recurringExpenseId: 42 });
    expect(mockRecordActivity.mock.invocationCallOrder[0]).toBeLessThan(mockPostDue.mock.invocationCallOrder[0]);
  });

  it("re-reads the rule when the edit posted, so upcoming and lastClosedPeriod are not stale", async () => {
    const reloaded = ruleDto({ description: "Rent (new)", lastClosedPeriod: "2026-10" });
    mockPostDue.mockResolvedValue({ ...NO_RUN, posted: 1 });
    mockGet.mockResolvedValue(reloaded);

    const res = await patch(edit);

    expect(await res.json()).toEqual({ rule: reloaded, postedNow: 1 });
    expect(mockGet).toHaveBeenCalledWith(7, viewer, PUBLIC_ID, NOW);
  });

  it("re-reads the rule when the edit only wrote a skipped ledger row, auto-paused it or lost the claim", async () => {
    const reloaded = ruleDto({ description: "Rent (new)", lastClosedPeriod: "2026-10" });
    mockGet.mockResolvedValue(reloaded);

    for (const counts of [{ skipped: 1 }, { paused: 1 }, { duplicates: 1 }]) {
      mockGet.mockClear();
      mockPostDue.mockResolvedValue({ ...NO_RUN, ...counts });

      const res = await patch(edit);

      expect(await res.json()).toEqual({ rule: reloaded, postedNow: 0 });
      expect(mockGet).toHaveBeenCalledTimes(1);
    }
  });

  it("never turns a saved edit into a 500: if the posting or the re-read throws, it answers 200 with the saved rule", async () => {
    mockPostDue.mockRejectedValueOnce(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    const afterPostFailure = await patch(edit);
    expect(afterPostFailure.status).toBe(200);
    expect(await afterPostFailure.json()).toEqual({ rule: ruleDto({ description: "Rent (new)" }), postedNow: 0 });

    mockPostDue.mockResolvedValueOnce({ ...NO_RUN, posted: 1 });
    mockGet.mockRejectedValueOnce(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    const afterReadFailure = await patch(edit);
    expect(afterReadFailure.status).toBe(200);
    expect(await afterReadFailure.json()).toEqual({ rule: ruleDto({ description: "Rent (new)" }), postedNow: 1 });

    expect(mockLogError).toHaveBeenCalledTimes(2);
  });

  it("answers the rule as saved when nothing posted: no second read", async () => {
    await patch(edit);

    expect(mockGet).not.toHaveBeenCalled();
  });

  it("an edit that changes nothing is a 200 no-op: no entry, no posting", async () => {
    mockUpdate.mockResolvedValue({ id: 42, rule: ruleDto(), changes: {}, changed: false });

    const res = await patch({ description: "Rent", expectedUpdatedAt: TOKEN });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rule: ruleDto(), postedNow: 0 });
    expect(mockRecordActivity).not.toHaveBeenCalled();
    expect(mockPostDue).not.toHaveBeenCalled();
  });

  it("passes no token when expectedUpdatedAt is missing or not a string, and relays the service's 400", async () => {
    mockUpdate.mockRejectedValue(new ApiError("expectedUpdatedAt is required to edit a rule", 400, "RECURRING_PATCH_INVALID"));

    for (const expectedUpdatedAt of [undefined, 123]) {
      const res = await patch({ description: "Rent (new)", expectedUpdatedAt });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("RECURRING_PATCH_INVALID");
    }

    for (const call of mockUpdate.mock.calls) expect(call[4]).toBeUndefined();
    expect(mockRecordActivity).not.toHaveBeenCalled();
  });

  it("relays 400 RECURRING_PATCH_INVALID for an empty body and for one that is not JSON", async () => {
    mockUpdate.mockRejectedValue(new ApiError("Nothing to change", 400, "RECURRING_PATCH_INVALID"));

    for (const payload of [{}, "{not json"]) {
      const res = await patch(payload);
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("RECURRING_PATCH_INVALID");
    }
    expect(mockUpdate.mock.calls[1][3]).toBeNull();
    expect(mockSetPaused).not.toHaveBeenCalled();
  });

  it("relays a field validation code and records nothing", async () => {
    mockUpdate.mockRejectedValue(new ApiError("Day of month must be a whole number from 1 to 31", 400, "RECURRING_DAY_INVALID"));

    const res = await patch({ dayOfMonth: 40, expectedUpdatedAt: TOKEN });

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("RECURRING_DAY_INVALID");
    expect(mockRecordActivity).not.toHaveBeenCalled();
    expect(mockPostDue).not.toHaveBeenCalled();
  });

  it("relays 409 STALE_RECURRING_EXPENSE for an out-of-date token and records nothing", async () => {
    mockUpdate.mockRejectedValue(new ApiError("This rule was changed by someone else", 409, "STALE_RECURRING_EXPENSE"));

    const res = await patch(edit);

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("STALE_RECURRING_EXPENSE");
    expect(mockRecordActivity).not.toHaveBeenCalled();
    expect(mockPostDue).not.toHaveBeenCalled();
  });

  it("relays 404 RECURRING_NOT_FOUND (a missing rule or another house's)", async () => {
    mockUpdate.mockRejectedValue(new ApiError("Recurring expense not found in this house", 404, "RECURRING_NOT_FOUND"));

    const res = await patch(edit);

    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("RECURRING_NOT_FOUND");
  });

  it("answers 409 STALE_GROUP when the house changed since the form opened, before touching the rule", async () => {
    const res = await patch({ ...edit, expectedGroupId: 8 });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("STALE_GROUP");
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockSetPaused).not.toHaveBeenCalled();
  });

  it("never takes the house from the body: the active house is the only groupId the service sees", async () => {
    await patch({ ...edit, groupId: 99 });

    expect(mockUpdate.mock.calls[0][0]).toBe(7);
  });

  it("returns the session/house failure untouched", async () => {
    mockRequireActiveGroup.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "NOT_AUTHENTICATED" }, { status: 401 }),
    });

    const res = await patch(edit);

    expect(res.status).toBe(401);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("maps an unexpected failure to a generic 500 without leaking its message", async () => {
    mockUpdate.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432 user=postgres"));

    const res = await patch(edit);

    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).toContain("Failed to update recurring expense");
    expect(text).not.toContain("ECONNREFUSED");
    expect(mockRecordActivity).not.toHaveBeenCalled();
    expect(mockPostDue).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/recurring-expenses/[id] (spec 008 — criterion 17)", () => {
  beforeEach(() => {
    mockDelete.mockResolvedValue({ publicId: PUBLIC_ID, description: "Rent", amount: "1800.00" });
  });

  it("deletes through the service for the active house and the caller, answering 200 { ok: true }", async () => {
    const res = await remove();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockDelete).toHaveBeenCalledWith(7, viewer, PUBLIC_ID);
  });

  it("records a DELETE entry for the caller, naming the rule and its amount", async () => {
    await remove();

    expect(activityCalls()).toEqual([
      {
        groupId: 7,
        actorId: 1,
        entityType: "RECURRING_EXPENSE",
        entityId: PUBLIC_ID,
        action: "DELETE",
        summary: "Rent",
        changes: { amount: "1800.00" },
      },
    ]);
    expect(mockPostDue).not.toHaveBeenCalled();
  });

  it("returns 403 NOT_RECURRING_OWNER and records nothing", async () => {
    mockDelete.mockRejectedValue(new ApiError("Only the payer or a house admin can change this rule", 403, "NOT_RECURRING_OWNER"));

    const res = await remove();

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("NOT_RECURRING_OWNER");
    expect(mockRecordActivity).not.toHaveBeenCalled();
  });

  it("returns 404 RECURRING_NOT_FOUND and records nothing", async () => {
    mockDelete.mockRejectedValue(new ApiError("Recurring expense not found in this house", 404, "RECURRING_NOT_FOUND"));

    const res = await remove();

    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("RECURRING_NOT_FOUND");
    expect(mockRecordActivity).not.toHaveBeenCalled();
  });

  it("returns the session/house failure untouched", async () => {
    mockRequireActiveGroup.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "NO_GROUP" }, { status: 403 }),
    });

    const res = await remove();

    expect(res.status).toBe(403);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("maps an unexpected failure to a generic 500 without leaking its message", async () => {
    mockDelete.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432 user=postgres"));

    const res = await remove();

    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).toContain("Failed to delete recurring expense");
    expect(text).not.toContain("ECONNREFUSED");
    expect(mockRecordActivity).not.toHaveBeenCalled();
  });
});
