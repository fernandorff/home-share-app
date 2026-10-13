import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { ApiError } from "@/lib/errors";

const { sentry, mockAfter, mockHeaders, mockCookies, mockPrisma, mockVerifySession } = vi.hoisted(() => ({
  sentry: { getClient: vi.fn(), captureException: vi.fn(), addBreadcrumb: vi.fn(), setUser: vi.fn(), setTag: vi.fn(), flush: vi.fn() },
  mockAfter: vi.fn(),
  mockHeaders: vi.fn(),
  mockCookies: vi.fn(),
  mockPrisma: { user: { findUnique: vi.fn() }, groupMember: { findMany: vi.fn() } },
  mockVerifySession: vi.fn(),
}));
vi.mock("@sentry/nextjs", () => sentry);
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: mockAfter };
});
vi.mock("next/headers", () => ({ headers: mockHeaders, cookies: mockCookies }));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, verifySession: mockVerifySession };
});

import { handleApiError, requireActiveGroup, requireSession } from "./api-helpers";

const USER_ID = "3f2b8c1e-5a6d-4e7f-9a0b-1c2d3e4f5a6b";
const HOUSE_ID = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
const EXPENSE_PATH = "/api/expenses/0b4f7c2e-1d2a-4c3b-9e8f-123456789abc";

let consoleError: MockInstance<typeof console.error>;

beforeEach(() => {
  vi.resetAllMocks();
  sentry.getClient.mockReturnValue({});
  sentry.captureException.mockReturnValue("evt-1");
  sentry.flush.mockResolvedValue(true);
  mockHeaders.mockResolvedValue(
    new Headers({
      "x-homeshare-request-id": "req-1",
      "x-homeshare-path": EXPENSE_PATH,
      "x-homeshare-start": String(Date.now() - 25),
    })
  );
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const logLine = () => JSON.parse(consoleError.mock.calls[0][0] as string);

function signedIn() {
  mockCookies.mockResolvedValue({
    get: (name: string) =>
      name === "homeshare_session" ? { value: "token" } : name === "homeshare_group" ? { value: "7" } : undefined,
  });
  mockVerifySession.mockResolvedValue({ userId: 1, publicId: USER_ID, name: "Ana", sessionVersion: 2, iat: 0 });
  mockPrisma.user.findUnique.mockResolvedValue({ sessionVersion: 2 });
}

describe("handleApiError — what reaches Sentry (spec 007)", () => {
  it("captures an unexpected error once, logs one JSON line, and answers the same generic 500 (R6)", async () => {
    const error = new Error("boom for ana@example.com");
    const response = await handleApiError(error, "Failed to load expense");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to load expense" });
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(error, {
      tags: { http_status: "500", route: "/api/expenses/:id", request_id: "req-1" },
    });
    expect(consoleError).toHaveBeenCalledTimes(1);
    const line = logLine();
    expect(line).toMatchObject({
      level: "error",
      msg: "Failed to load expense",
      requestId: "req-1",
      route: "/api/expenses/:id",
      status: 500,
      sentryEventId: "evt-1",
    });
    expect(line.durationMs).toBeGreaterThanOrEqual(25);
    expect(line.error.message).toBe("boom for [email]");
  });

  it("answers an expected 4xx ApiError as before and reports nothing (R7)", async () => {
    const response = await handleApiError(new ApiError("Expense not found", 404, "EXPENSE_NOT_FOUND"), "Failed to load expense");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Expense not found", code: "EXPENSE_NOT_FOUND" });
    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(mockHeaders).not.toHaveBeenCalled();
  });

  it("captures a 5xx ApiError with its code and keeps its own message (R6)", async () => {
    const response = await handleApiError(new ApiError("Upstream unavailable", 503, "UPSTREAM_DOWN"), "Failed to sync");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Upstream unavailable", code: "UPSTREAM_DOWN" });
    expect(sentry.captureException).toHaveBeenCalledWith(expect.any(ApiError), {
      tags: { http_status: "503", route: "/api/expenses/:id", api_error_code: "UPSTREAM_DOWN", request_id: "req-1" },
    });
    expect(logLine()).toMatchObject({ status: 503, code: "UPSTREAM_DOWN" });
  });

  it("still answers and captures outside a request scope (no headers)", async () => {
    mockHeaders.mockRejectedValue(new Error("headers() outside a request"));
    const response = await handleApiError(new Error("boom"), "Failed");
    expect(response.status).toBe(500);
    expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error), { tags: { http_status: "500" } });
  });

  it("logs without an event id while the SDK is off", async () => {
    sentry.getClient.mockReturnValue(undefined);
    await handleApiError(new Error("boom"), "Failed");
    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(logLine()).not.toHaveProperty("sentryEventId");
  });
});

describe("handleApiError — flushing the event before the serverless function freezes (I1)", () => {
  /** The callback handed to after(): runs the scheduled flush the way Next does once the response is sent. */
  async function runScheduledFlush(): Promise<void> {
    const task = mockAfter.mock.calls[0][0] as () => unknown;
    await task();
  }

  it("schedules exactly one after() flush per captured 5xx, and the task flushes Sentry with a 2 s budget", async () => {
    await handleApiError(new Error("boom"), "Failed");
    expect(mockAfter).toHaveBeenCalledTimes(1);
    expect(sentry.flush).not.toHaveBeenCalled(); // deferred until the response is out
    await runScheduledFlush();
    expect(sentry.flush).toHaveBeenCalledTimes(1);
    expect(sentry.flush).toHaveBeenCalledWith(2000);
  });

  it("schedules one flush for a 5xx ApiError as well", async () => {
    await handleApiError(new ApiError("Upstream unavailable", 503, "UPSTREAM_DOWN"), "Failed to sync");
    expect(mockAfter).toHaveBeenCalledTimes(1);
  });

  it("schedules nothing for an expected 4xx", async () => {
    await handleApiError(new ApiError("Expense not found", 404, "EXPENSE_NOT_FOUND"), "Failed to load expense");
    expect(mockAfter).not.toHaveBeenCalled();
    expect(sentry.flush).not.toHaveBeenCalled();
  });

  it("schedules nothing while the SDK is off (no DSN: nothing was captured, so nothing to flush)", async () => {
    sentry.getClient.mockReturnValue(undefined);
    const response = await handleApiError(new Error("boom"), "Failed");
    expect(response.status).toBe(500);
    expect(mockAfter).not.toHaveBeenCalled();
  });

  it("never throws into the response when after() is unavailable (outside a request scope)", async () => {
    mockAfter.mockImplementation(() => {
      throw new Error("after() was called outside a request scope");
    });
    const response = await handleApiError(new Error("boom"), "Failed");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed" });
  });

  it("the scheduled task swallows a failing flush", async () => {
    sentry.flush.mockRejectedValue(new Error("network down"));
    await handleApiError(new Error("boom"), "Failed");
    await expect(runScheduledFlush()).resolves.toBeUndefined();
  });
});

describe("request identity (R8)", () => {
  it("requireSession sets the Sentry user to the member's publicId only", async () => {
    signedIn();
    const check = await requireSession();
    expect(check.ok).toBe(true);
    expect(sentry.setUser).toHaveBeenCalledWith({ id: USER_ID });
  });

  it("requireActiveGroup tags the house with its publicId", async () => {
    signedIn();
    mockPrisma.groupMember.findMany.mockResolvedValue([{ groupId: 7, role: "ADMIN", group: { publicId: HOUSE_ID } }]);
    const check = await requireActiveGroup();
    expect(check).toMatchObject({ ok: true, groupId: 7, role: "ADMIN" });
    expect(sentry.setTag).toHaveBeenCalledWith("house", HOUSE_ID);
    expect(mockPrisma.groupMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: { groupId: true, role: true, group: { select: { publicId: true } } } })
    );
  });
});
