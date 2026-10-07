import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextResponse } from "next/server";
import { ApiError } from "@/lib/errors";
import type * as ApiHelpers from "@/lib/api-helpers";

// Same setup as groups/active/currency/route.test.ts: the session gate, the activity log and the service are
// faked, so nothing here touches the shared pglite socket. What the service does (validation codes, the 50-rule
// limit, the summary, the posting) is asserted by recurring-expense.service.test.ts and tenant-isolation.test.ts.
const { mockRequireActiveGroup, mockRecordActivity, mockList, mockCreate, mockGet, mockPostDue, mockLogError } = vi.hoisted(() => ({
  mockRequireActiveGroup: vi.fn(),
  mockRecordActivity: vi.fn(),
  mockList: vi.fn(),
  mockCreate: vi.fn(),
  mockGet: vi.fn(),
  mockPostDue: vi.fn(),
  mockLogError: vi.fn(),
}));
vi.mock("@/lib/api-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiHelpers>();
  return { ...actual, requireActiveGroup: mockRequireActiveGroup, recordActivity: mockRecordActivity };
});
vi.mock("@/services/recurring-expense.service", () => ({
  recurringExpenseService: { list: mockList, create: mockCreate, get: mockGet, postDue: mockPostDue },
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: mockLogError } }));
// handleApiError reads the request headers and talks to Sentry: both are irrelevant to these contracts.
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
vi.mock("@sentry/nextjs", () => ({ getClient: () => undefined, flush: async () => true, addBreadcrumb: () => {} }));

import { GET, POST } from "./route";

const NOW = new Date("2026-10-05T11:30:00.000Z");
const session = { userId: 1, publicId: "actor", name: "Ana", sessionVersion: 1, iat: 0 };
const viewer = { userId: 1, role: "MEMBER" };
const PUBLIC_ID = "0198f6a0-0000-7000-8000-000000000001";
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
  activeFrom: "2026-10-05",
  paused: false,
  pauseReason: null,
  skippedPeriods: [],
  lastClosedPeriod: null,
  upcoming: [{ period: "2026-10", dueOn: "2026-10-05", skipped: false }],
  canManage: true,
  updatedAt: "2026-10-05T11:30:00.000Z",
  ...overrides,
});

const body = {
  description: "Rent",
  amount: 1800,
  dayOfMonth: 5,
  payerId: 1,
  splitMode: "ALL",
  timezone: "America/Sao_Paulo",
};
const post = (payload: unknown) =>
  POST(
    new Request("http://localhost/api/recurring-expenses", {
      method: "POST",
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    })
  );

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  mockRequireActiveGroup.mockResolvedValue({ ok: true, session, groupId: 7, role: "MEMBER" });
  mockCreate.mockResolvedValue({ id: 42, rule: ruleDto() });
  mockPostDue.mockResolvedValue(NO_RUN);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/recurring-expenses (spec 008 — criterion 4)", () => {
  const listing = {
    rules: [ruleDto()],
    summary: { monthlyTotal: "1800.00", myMonthlyShare: "900.00", activeCount: 1, pausedCount: 0 },
    history: [],
  };

  it("answers 200 with the service's listing for the active house and the caller", async () => {
    mockList.mockResolvedValue(listing);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(listing);
    expect(mockList).toHaveBeenCalledWith(7, viewer, NOW);
  });

  it("hands the service the caller's role, so canManage reflects an admin", async () => {
    mockRequireActiveGroup.mockResolvedValue({ ok: true, session, groupId: 7, role: "ADMIN" });
    mockList.mockResolvedValue(listing);

    await GET();

    expect(mockList).toHaveBeenCalledWith(7, { userId: 1, role: "ADMIN" }, NOW);
  });

  it("returns the session/house failure untouched", async () => {
    mockRequireActiveGroup.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "NO_GROUP" }, { status: 403 }),
    });

    const res = await GET();

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("NO_GROUP");
    expect(mockList).not.toHaveBeenCalled();
  });

  it("maps an unexpected failure to a generic 500 without leaking its message", async () => {
    mockList.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432 user=postgres"));

    const res = await GET();

    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).toContain("Failed to list recurring expenses");
    expect(text).not.toContain("ECONNREFUSED");
  });
});

describe("POST /api/recurring-expenses (spec 008 — criteria 1–3, 6, 7, 24)", () => {
  it("creates the rule in the active house for the caller and answers 201 { rule, postedNow: 0 }", async () => {
    const res = await post(body);

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ rule: ruleDto(), postedNow: 0 });
    expect(mockCreate).toHaveBeenCalledWith(7, viewer, body, NOW);
  });

  it("never takes the house from the body: the active house is the only groupId the service sees", async () => {
    await post({ ...body, groupId: 99 });

    expect(mockCreate.mock.calls[0][0]).toBe(7);
  });

  it("posts the new rule synchronously, for that rule only, with the server clock", async () => {
    await post(body);

    expect(mockPostDue).toHaveBeenCalledTimes(1);
    expect(mockPostDue).toHaveBeenCalledWith(NOW, { recurringExpenseId: 42 });
  });

  it("answers with the rule as created when nothing posted: no second read", async () => {
    await post(body);

    expect(mockGet).not.toHaveBeenCalled();
  });

  it("re-reads the rule after a posting, so upcoming and lastClosedPeriod are not stale", async () => {
    const reloaded = ruleDto({
      lastClosedPeriod: "2026-10",
      upcoming: [{ period: "2026-11", dueOn: "2026-11-05", skipped: false }],
    });
    mockPostDue.mockResolvedValue({ ...NO_RUN, posted: 1 });
    mockGet.mockResolvedValue(reloaded);

    const res = await post(body);

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ rule: reloaded, postedNow: 1 });
    expect(mockGet).toHaveBeenCalledWith(7, viewer, PUBLIC_ID, NOW);
  });

  it("also re-reads when the run only wrote a skipped ledger row, paused the rule or lost the claim", async () => {
    mockGet.mockResolvedValue(ruleDto({ lastClosedPeriod: "2026-10" }));

    for (const counts of [{ skipped: 1 }, { paused: 1 }, { duplicates: 1 }]) {
      mockPostDue.mockResolvedValue({ ...NO_RUN, ...counts });
      expect((await (await post(body)).json()).postedNow).toBe(0);
    }

    expect(mockGet).toHaveBeenCalledTimes(3);
  });

  it("never turns a saved rule into a 500: if the synchronous posting throws, it answers 201 with the saved rule", async () => {
    mockPostDue.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432"));

    const res = await post(body);

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ rule: ruleDto(), postedNow: 0 });
    expect(mockLogError).toHaveBeenCalledTimes(1);
    expect(mockRecordActivity).toHaveBeenCalledTimes(1);
  });

  it("records the Summary CREATE entry for the caller, before the automatic posting it triggers", async () => {
    mockPostDue.mockResolvedValue({ ...NO_RUN, posted: 1 });
    mockGet.mockResolvedValue(ruleDto());

    await post(body);

    expect(mockRecordActivity).toHaveBeenCalledTimes(1);
    expect(mockRecordActivity).toHaveBeenCalledWith({
      groupId: 7,
      actorId: 1,
      entityType: "RECURRING_EXPENSE",
      entityId: PUBLIC_ID,
      action: "CREATE",
      summary: "Rent",
      changes: { amount: "1800.00" },
    });
    expect(mockRecordActivity.mock.invocationCallOrder[0]).toBeLessThan(mockPostDue.mock.invocationCallOrder[0]);
  });

  it("returns a service validation failure with its code and creates, posts and logs nothing", async () => {
    mockCreate.mockRejectedValue(new ApiError("Day of month must be a whole number from 1 to 31", 400, "RECURRING_DAY_INVALID"));

    const res = await post({ ...body, dayOfMonth: 32 });

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("RECURRING_DAY_INVALID");
    expect(mockPostDue).not.toHaveBeenCalled();
    expect(mockRecordActivity).not.toHaveBeenCalled();
  });

  it("returns 409 RECURRING_LIMIT_REACHED from the service", async () => {
    mockCreate.mockRejectedValue(new ApiError("This house already has 50 recurring expenses", 409, "RECURRING_LIMIT_REACHED"));

    const res = await post(body);

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("RECURRING_LIMIT_REACHED");
    expect(mockPostDue).not.toHaveBeenCalled();
  });

  it("answers 409 STALE_GROUP when the house changed since the form opened, before creating anything", async () => {
    const res = await post({ ...body, expectedGroupId: 8 });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("STALE_GROUP");
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockPostDue).not.toHaveBeenCalled();
  });

  it("goes ahead when expectedGroupId matches the active house", async () => {
    const res = await post({ ...body, expectedGroupId: 7 });

    expect(res.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("hands a body that is not JSON to the service as null, which answers 400 instead of a 500", async () => {
    mockCreate.mockImplementation(async (_groupId: number, _viewer: unknown, raw: unknown) => {
      if (raw === null) throw new ApiError("Description is required", 400, "DESCRIPTION_REQUIRED");
      return { id: 42, rule: ruleDto() };
    });

    const res = await post("{not json");

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("DESCRIPTION_REQUIRED");
    expect(mockPostDue).not.toHaveBeenCalled();
  });

  it("returns the session/house failure untouched", async () => {
    mockRequireActiveGroup.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "NOT_AUTHENTICATED" }, { status: 401 }),
    });

    const res = await post(body);

    expect(res.status).toBe(401);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("maps an unexpected failure to a generic 500 without leaking its message", async () => {
    mockCreate.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432 user=postgres"));

    const res = await post(body);

    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).toContain("Failed to create recurring expense");
    expect(text).not.toContain("ECONNREFUSED");
    expect(mockPostDue).not.toHaveBeenCalled();
  });
});
