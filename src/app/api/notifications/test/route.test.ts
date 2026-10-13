import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextResponse } from "next/server";
import type * as ApiHelpers from "@/lib/api-helpers";
import { ApiError } from "@/lib/errors";

// POST /api/notifications/test (spec 010 — criteria 1, 10): "Send test notice". The session gate and the push service
// are faked (no pglite socket, no network); the env guard and the in-memory rate limiter (src/lib/rate-limit.ts) are
// the real ones, driven by a fake clock. sendTest's own counting lives in push.service.test.ts.
const { mockRequireSession, mockRequireActiveGroup, mockSendTest, mockLogError, mockCapture } = vi.hoisted(() => ({
  mockRequireSession: vi.fn(),
  mockRequireActiveGroup: vi.fn(),
  mockSendTest: vi.fn(),
  mockLogError: vi.fn(),
  mockCapture: vi.fn(),
}));
vi.mock("@/lib/api-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiHelpers>();
  return { ...actual, requireSession: mockRequireSession, requireActiveGroup: mockRequireActiveGroup };
});
vi.mock("@/services/push.service", () => ({ pushService: { sendTest: mockSendTest } }));
// Tests never reach the network, even if a later change imports the real service.
vi.mock("web-push", () => ({ default: { sendNotification: vi.fn() } }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: mockLogError } }));
vi.mock("@/lib/observability/context", () => ({ captureServerError: mockCapture, setObservedHouse: vi.fn(), setObservedUser: vi.fn() }));
// handleApiError reads the request headers and talks to Sentry: both are irrelevant to these contracts.
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
vi.mock("@sentry/nextjs", () => ({ getClient: () => undefined, flush: async () => true, addBreadcrumb: () => {} }));

import { POST } from "./route";

const sessionOf = (userId: number) => ({ ok: true, session: { userId, publicId: `user-${userId}`, name: "U", sessionVersion: 1, iat: 0 } });
const unauthenticated = { ok: false, response: NextResponse.json({ error: "Not authenticated", code: "NOT_AUTHENTICATED" }, { status: 401 }) };
const VAPID_VARS = ["NEXT_PUBLIC_VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"] as const;

// lib/api sends a JSON body with its content type even for an empty POST (pinned in api.test.ts); the CSRF tests override it.
const post = (contentType: string | null = "application/json") =>
  POST(
    new Request("http://localhost/api/notifications/test", {
      method: "POST",
      headers: contentType === null ? {} : { "content-type": contentType },
      body: "{}",
    })
  );

// The limiter's buckets are module state: every test starts an hour after the previous one, so no bucket carries over.
let clock = Date.UTC(2026, 9, 7, 12);
const at = (msFromStart: number) => vi.setSystemTime(clock + msFromStart);

function configure() {
  vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "public-key");
  vi.stubEnv("VAPID_PRIVATE_KEY", "private-key");
  vi.stubEnv("VAPID_SUBJECT", "mailto:owner@example.com");
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  clock += 3_600_000;
  at(0);
  configure();
  mockRequireSession.mockResolvedValue(sessionOf(2));
  mockSendTest.mockResolvedValue({ sent: 2, failed: 1 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("POST /api/notifications/test (spec 010 — criterion 10)", () => {
  it("sends the test notice to the session user's devices and answers 200 { sent, failed }", async () => {
    const res = await post();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 2, failed: 1 });
    expect(mockSendTest).toHaveBeenCalledWith(2);
  });

  it("answers 409 NO_PUSH_SUBSCRIPTION when the member has no subscription, as an expected 4xx (no error log)", async () => {
    mockSendTest.mockRejectedValueOnce(new ApiError("No push subscription for this account", 409, "NO_PUSH_SUBSCRIPTION"));
    const res = await post();

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("NO_PUSH_SUBSCRIPTION");
    expect(mockLogError).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it("needs a session but no active house (push is per person)", async () => {
    await post();
    expect(mockRequireActiveGroup).not.toHaveBeenCalled();
  });

  it("passes the session gate's 401 through and sends nothing", async () => {
    mockRequireSession.mockResolvedValueOnce(unauthenticated);
    expect((await post()).status).toBe(401);
    expect(mockSendTest).not.toHaveBeenCalled();
  });

  it("maps an unexpected failure to a generic 500 without leaking its message", async () => {
    mockSendTest.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    const res = await post();

    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).toContain("Failed to send the test notice");
    expect(text).not.toContain("ECONNREFUSED");
  });
});

describe("POST /api/notifications/test — rate limit: 1 per 10 s per user (criterion 10)", () => {
  it("answers 429 RATE_LIMITED to a second test within 10 s and sends nothing for it", async () => {
    expect((await post()).status).toBe(200);
    at(9_999);
    const res = await post();

    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe("RATE_LIMITED");
    expect(mockSendTest).toHaveBeenCalledTimes(1);
  });

  it("allows the next test once 10 s passed without a try", async () => {
    expect((await post()).status).toBe(200);
    at(9_999);
    expect((await post()).status).toBe(429);
    at(20_000);
    expect((await post()).status).toBe(200);
    expect(mockSendTest).toHaveBeenCalledTimes(2);
  });

  it("counts per user: another member's test in the same second is not limited", async () => {
    expect((await post()).status).toBe(200);
    mockRequireSession.mockResolvedValueOnce(sessionOf(3));
    expect((await post()).status).toBe(200);
    expect(mockSendTest.mock.calls).toEqual([[2], [3]]);
  });

  it("a 409 (no subscription yet) counts as a try too", async () => {
    mockSendTest.mockRejectedValueOnce(new ApiError("No push subscription for this account", 409, "NO_PUSH_SUBSCRIPTION"));
    expect((await post()).status).toBe(409);
    expect((await post()).status).toBe(429);
  });

  it("an unauthenticated request never touches the member's bucket", async () => {
    mockRequireSession.mockResolvedValueOnce(unauthenticated);
    expect((await post()).status).toBe(401);
    expect((await post()).status).toBe(200);
  });
});

describe("POST /api/notifications/test while push is not configured (spec 010 — criterion 1)", () => {
  it.each(VAPID_VARS)("answers 503 PUSH_NOT_CONFIGURED without %s and sends nothing", async (name) => {
    vi.stubEnv(name, "");
    const res = await post();

    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("PUSH_NOT_CONFIGURED");
    expect(mockSendTest).not.toHaveBeenCalled();
  });

  it("treats it as normal operation (no error log, no Sentry event) and never spends the member's bucket", async () => {
    vi.stubEnv("VAPID_SUBJECT", "");
    expect((await post()).status).toBe(503);
    expect((await post()).status).toBe(503);
    expect(mockLogError).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();

    configure();
    expect((await post()).status).toBe(200);
  });
});

// Cycle G review M4: the same CSRF guard as /api/push-subscriptions. A same-site sibling (SameSite=Lax still sends the
// cookie) could otherwise fire real pushes to the member's devices and spend their test bucket with a plain form.
// Order: 401 → 503 → 415 → 429 → send — a refused form never touches the bucket.
describe("POST /api/notifications/test refuses non-JSON requests (CSRF)", () => {
  it.each([
    ["a text/plain form", "text/plain"],
    ["an urlencoded form", "application/x-www-form-urlencoded"],
    ["a multipart form", "multipart/form-data; boundary=x"],
    ["no content type", null],
  ])("%s → 415 UNSUPPORTED_MEDIA_TYPE, nothing sent", async (_label, contentType) => {
    const res = await post(contentType);
    expect(res.status).toBe(415);
    expect((await res.json()).code).toBe("UNSUPPORTED_MEDIA_TYPE");
    expect(mockSendTest).not.toHaveBeenCalled();
  });

  it("a refused form never spends the member's bucket: the next JSON test still goes out", async () => {
    expect((await post("text/plain")).status).toBe(415);
    expect((await post()).status).toBe(200);
    expect(mockSendTest).toHaveBeenCalledTimes(1);
  });

  it("accepts application/json with a charset", async () => {
    expect((await post("application/json; charset=utf-8")).status).toBe(200);
  });

  it("answers 401 first without a session, and 503 before 415 while push is not configured", async () => {
    mockRequireSession.mockResolvedValueOnce(unauthenticated);
    expect((await post("text/plain")).status).toBe(401);
    vi.stubEnv("VAPID_PRIVATE_KEY", "");
    expect((await post("text/plain")).status).toBe(503);
  });
});
