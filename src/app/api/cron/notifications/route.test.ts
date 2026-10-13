import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ApiError } from "@/lib/errors";

const { mockDueReminders, mockDebtReminders, mockPrune, mockInfo } = vi.hoisted(() => ({
  mockDueReminders: vi.fn(),
  mockDebtReminders: vi.fn(),
  mockPrune: vi.fn(),
  mockInfo: vi.fn(),
}));
vi.mock("@/services/notification.service", () => ({
  notificationService: {
    sendRecurringDueReminders: mockDueReminders,
    sendDebtReminders: mockDebtReminders,
    prune: mockPrune,
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { info: mockInfo, warn: vi.fn(), error: vi.fn() } }));
// handleApiError reads the request headers and talks to Sentry: both are irrelevant to this contract.
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined }),
}));
// No Sentry client (no DSN) → captureServerError is a no-op; breadcrumbs from the logger are dropped.
vi.mock("@sentry/nextjs", () => ({ getClient: () => undefined, flush: async () => true, addBreadcrumb: () => {} }));

import { GET, dynamic, maxDuration } from "./route";

const SECRET = "0123456789abcdef0123456789abcdef";
const NOW = new Date("2026-10-05T12:20:00.000Z"); // a Monday, inside the 12:00–12:59 UTC window
const DUE = { created: 3, failed: 1, remaining: 0 };
const DEBT = { created: 2, failed: 0, remaining: 4 };
const COUNTS = { dueReminders: 3, debtReminders: 2, pruned: 7, failed: 1, remaining: 4 };

const call = (authorization?: string) =>
  GET(
    new Request("http://localhost/api/cron/notifications", {
      headers: authorization === undefined ? {} : { authorization },
    })
  );

const nothingRan = () => {
  expect(mockDueReminders).not.toHaveBeenCalled();
  expect(mockDebtReminders).not.toHaveBeenCalled();
  expect(mockPrune).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("CRON_SECRET", SECRET);
  mockDueReminders.mockResolvedValue(DUE);
  mockDebtReminders.mockResolvedValue(DEBT);
  mockPrune.mockResolvedValue(7);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("GET /api/cron/notifications (spec 009 — criteria 7, 8, 17, 18)", () => {
  it("is never cached and may run for a minute", () => {
    expect(dynamic).toBe("force-dynamic");
    expect(maxDuration).toBe(60);
  });

  it("answers 401 CRON_UNAUTHORIZED and creates nothing without the Authorization header", async () => {
    const res = await call();
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("CRON_UNAUTHORIZED");
    nothingRan();
  });

  it("answers 401 and creates nothing with a wrong secret", async () => {
    const res = await call("Bearer not-the-secret");
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("CRON_UNAUTHORIZED");
    nothingRan();
  });

  it("answers 401 and creates nothing when CRON_SECRET is unset, even for 'Bearer undefined'", async () => {
    vi.stubEnv("CRON_SECRET", undefined);
    const res = await call("Bearer undefined");
    expect(res.status).toBe(401);
    nothingRan();
  });

  it("runs due reminders, then debt reminders, then prune — with the server clock and one shared 30 s deadline", async () => {
    await call(`Bearer ${SECRET}`);

    const deadline = new Date(NOW.getTime() + 30_000);
    expect(mockDueReminders).toHaveBeenCalledTimes(1);
    expect(mockDueReminders).toHaveBeenCalledWith(NOW, { deadline });
    expect(mockDebtReminders).toHaveBeenCalledTimes(1);
    expect(mockDebtReminders).toHaveBeenCalledWith(NOW, { deadline });
    expect(mockPrune).toHaveBeenCalledTimes(1);
    expect(mockPrune).toHaveBeenCalledWith(NOW);
    const order = [mockDueReminders, mockDebtReminders, mockPrune].map((m) => m.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("responds 200 with the counts only: inserted per job, pruned, and the failed and remaining units of both producers", async () => {
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ...COUNTS });
  });

  it("never echoes anything but the counts, even if the service results grow extra fields", async () => {
    mockDueReminders.mockResolvedValue({ ...DUE, ruleIds: [1, 2], descriptions: ["Rent"] });
    mockDebtReminders.mockResolvedValue({ ...DEBT, userIds: [5] });
    const body = await (await call(`Bearer ${SECRET}`)).json();
    expect(Object.keys(body).sort()).toEqual(["debtReminders", "dueReminders", "failed", "ok", "pruned", "remaining"]);
  });

  it("logs one info line carrying the counts and no names, ids, amounts or the secret", async () => {
    await call(`Bearer ${SECRET}`);
    expect(mockInfo).toHaveBeenCalledTimes(1);
    const [message, fields] = mockInfo.mock.calls[0];
    expect(message).toBe("notifications cron finished");
    expect(fields).toMatchObject({ route: "/api/cron/notifications", ...COUNTS });
    expect(Object.keys(fields).sort()).toEqual(["debtReminders", "dueReminders", "durationMs", "failed", "pruned", "remaining", "route"]);
    expect(JSON.stringify(mockInfo.mock.calls)).not.toContain(SECRET);
  });

  it("maps an unexpected failure to a generic 500 without leaking its message", async () => {
    mockDueReminders.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432 user=postgres"));
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).toContain("Failed to run the notices job");
    expect(text).not.toContain("ECONNREFUSED");
  });

  it("keeps a typed service failure's status and code", async () => {
    mockPrune.mockRejectedValue(new ApiError("Nope", 409, "SOME_CODE"));
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("SOME_CODE");
  });
});

describe("vercel.json cron schedule for notices (Hobby plan: once a day)", () => {
  const config = JSON.parse(readFileSync(path.join(process.cwd(), "vercel.json"), "utf8"));
  const crons = config.crons as { path: string; schedule: string }[];

  it("registers this route exactly once", () => {
    expect(crons.filter((c) => c.path === "/api/cron/notifications")).toHaveLength(1);
  });

  it("fires daily at 12:00 UTC (09:00 in Brasília), after the 11:00 posting run", () => {
    expect(crons.find((c) => c.path === "/api/cron/notifications")?.schedule).toBe("0 12 * * *");
    expect(crons.find((c) => c.path === "/api/cron/recurring-expenses")?.schedule).toBe("0 11 * * *");
  });
});
