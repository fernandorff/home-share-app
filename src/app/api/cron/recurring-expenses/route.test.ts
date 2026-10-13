import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ApiError } from "@/lib/errors";

const { mockPostDue, mockInfo } = vi.hoisted(() => ({ mockPostDue: vi.fn(), mockInfo: vi.fn() }));
vi.mock("@/services/recurring-expense.service", () => ({ recurringExpenseService: { postDue: mockPostDue } }));
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
const NOW = new Date("2026-10-05T11:30:00.000Z");
const COUNTS = { posted: 3, skipped: 1, paused: 0, duplicates: 2, failed: 0, remaining: 0 };

const call = (authorization?: string) =>
  GET(
    new Request("http://localhost/api/cron/recurring-expenses", {
      headers: authorization === undefined ? {} : { authorization },
    })
  );

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("CRON_SECRET", SECRET);
  mockPostDue.mockResolvedValue(COUNTS);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("GET /api/cron/recurring-expenses (spec 008 — criterion 19)", () => {
  it("is never cached and may run for a minute", () => {
    expect(dynamic).toBe("force-dynamic");
    expect(maxDuration).toBe(60);
  });

  it("answers 401 CRON_UNAUTHORIZED and posts nothing without the Authorization header", async () => {
    const res = await call();
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("CRON_UNAUTHORIZED");
    expect(mockPostDue).not.toHaveBeenCalled();
  });

  it("answers 401 and posts nothing with a wrong secret", async () => {
    const res = await call("Bearer not-the-secret");
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("CRON_UNAUTHORIZED");
    expect(mockPostDue).not.toHaveBeenCalled();
  });

  it("answers 401 and posts nothing when CRON_SECRET is unset, even for 'Bearer undefined'", async () => {
    vi.stubEnv("CRON_SECRET", undefined);
    const res = await call("Bearer undefined");
    expect(res.status).toBe(401);
    expect(mockPostDue).not.toHaveBeenCalled();
  });

  it("runs postDue for every rule with the server clock and a 30 s deadline", async () => {
    await call(`Bearer ${SECRET}`);
    expect(mockPostDue).toHaveBeenCalledTimes(1);
    const [now, options] = mockPostDue.mock.calls[0];
    expect(now).toEqual(NOW);
    expect(options).toEqual({ deadline: new Date(NOW.getTime() + 30_000) });
    expect(options.recurringExpenseId).toBeUndefined();
  });

  it("responds 200 with the counts only", async () => {
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ...COUNTS });
  });

  it("never echoes anything but the counts, even if the service result grows extra fields", async () => {
    mockPostDue.mockResolvedValue({ ...COUNTS, expenseIds: [1, 2], descriptions: ["Rent"] });
    const body = await (await call(`Bearer ${SECRET}`)).json();
    expect(Object.keys(body).sort()).toEqual(["duplicates", "failed", "ok", "paused", "posted", "remaining", "skipped"]);
  });

  it("logs one info line carrying the counts and no names, ids or amounts", async () => {
    await call(`Bearer ${SECRET}`);
    expect(mockInfo).toHaveBeenCalledTimes(1);
    const [message, fields] = mockInfo.mock.calls[0];
    expect(message).toBe("recurring expenses cron finished");
    expect(fields).toMatchObject({ route: "/api/cron/recurring-expenses", ...COUNTS });
    expect(JSON.stringify(mockInfo.mock.calls)).not.toContain(SECRET);
  });

  it("maps an unexpected failure to a generic 500 without leaking its message", async () => {
    mockPostDue.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432 user=postgres"));
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).toContain("Failed to post recurring expenses");
    expect(text).not.toContain("ECONNREFUSED");
  });

  it("keeps a typed service failure's status and code", async () => {
    mockPostDue.mockRejectedValue(new ApiError("Nope", 409, "SOME_CODE"));
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("SOME_CODE");
  });
});

describe("vercel.json cron schedule (Hobby plan: once a day)", () => {
  const config = JSON.parse(readFileSync(path.join(process.cwd(), "vercel.json"), "utf8"));

  it("registers this route exactly once", () => {
    const entries = (config.crons as { path: string; schedule: string }[]).filter((c) => c.path === "/api/cron/recurring-expenses");
    expect(entries).toHaveLength(1);
  });

  it("fires once a day: fixed minute and hour, every day, month and weekday", () => {
    const { schedule } = (config.crons as { path: string; schedule: string }[]).find((c) => c.path === "/api/cron/recurring-expenses")!;
    const [minute, hour, dayOfMonth, month, dayOfWeek] = schedule.split(" ");
    expect(schedule.split(" ")).toHaveLength(5);
    expect(minute).toMatch(/^\d+$/);
    expect(hour).toMatch(/^\d+$/);
    expect([dayOfMonth, month, dayOfWeek]).toEqual(["*", "*", "*"]);
    // 08:00 in America/Sao_Paulo (UTC-3) — ADR 0010.
    expect(schedule).toBe("0 11 * * *");
  });

  it("keeps the existing build settings", () => {
    expect(config.buildCommand).toBe("prisma generate && next build");
    expect(config.framework).toBe("nextjs");
  });
});
