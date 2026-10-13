import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextResponse } from "next/server";
import type * as ApiHelpers from "@/lib/api-helpers";
import { ApiError } from "@/lib/errors";

// POST / DELETE /api/push-subscriptions (spec 010 — criteria 1, 3, 4, 5, 13). The session gate and the push service
// are faked (no pglite socket, no network); the validators (src/lib/push/endpoint.ts) and the env guard
// (pushConfig) are the real ones, so every 400/503 here is the production decision. Upsert, owner move, cap and
// own-only delete against a real DB live in tenant-isolation.test.ts.
const { mockRequireSession, mockRequireActiveGroup, mockRegister, mockUnregister, mockLogError, mockCapture } = vi.hoisted(() => ({
  mockRequireSession: vi.fn(),
  mockRequireActiveGroup: vi.fn(),
  mockRegister: vi.fn(),
  mockUnregister: vi.fn(),
  mockLogError: vi.fn(),
  mockCapture: vi.fn(),
}));
vi.mock("@/lib/api-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiHelpers>();
  return { ...actual, requireSession: mockRequireSession, requireActiveGroup: mockRequireActiveGroup };
});
vi.mock("@/services/push.service", () => ({ pushService: { register: mockRegister, unregister: mockUnregister } }));
// Tests never reach the network, even if a later change imports the real service.
vi.mock("web-push", () => ({ default: { sendNotification: vi.fn() } }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: mockLogError } }));
vi.mock("@/lib/observability/context", () => ({ captureServerError: mockCapture, setObservedHouse: vi.fn(), setObservedUser: vi.fn() }));
// handleApiError reads the request headers and talks to Sentry: both are irrelevant to these contracts.
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
vi.mock("@sentry/nextjs", () => ({ getClient: () => undefined, flush: async () => true, addBreadcrumb: () => {} }));

import { POST, DELETE } from "./route";

const session = { userId: 2, publicId: "bob", name: "Bob", sessionVersion: 1, iat: 0 };
const unauthenticated = { ok: false, response: NextResponse.json({ error: "Not authenticated", code: "NOT_AUTHENTICATED" }, { status: 401 }) };

const ENDPOINT = "https://fcm.googleapis.com/fcm/send/device-1-SECRETTOKEN";
const P256DH = Buffer.alloc(65, 4).toString("base64url");
const AUTH = Buffer.alloc(16, 9).toString("base64url");
const VALID = { endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: AUTH }, locale: "pt" };

const VAPID_VARS = ["NEXT_PUBLIC_VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"] as const;

function configure() {
  vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "public-key");
  vi.stubEnv("VAPID_PRIVATE_KEY", "private-key");
  vi.stubEnv("VAPID_SUBJECT", "mailto:owner@example.com");
}

// lib/api and the service worker both send JSON with its content type; the CSRF tests override it.
const send = (
  handler: (request: Request) => Promise<Response>,
  method: string,
  payload: unknown,
  contentType: string | null = "application/json"
) =>
  handler(
    new Request("http://localhost/api/push-subscriptions", {
      method,
      headers: contentType === null ? {} : { "content-type": contentType },
      body: payload === undefined ? undefined : typeof payload === "string" ? payload : JSON.stringify(payload),
    })
  );
const post = (payload: unknown) => send(POST, "POST", payload);
const del = (payload: unknown) => send(DELETE, "DELETE", payload);

beforeEach(() => {
  vi.resetAllMocks();
  configure();
  mockRequireSession.mockResolvedValue({ ok: true, session });
  mockRegister.mockResolvedValue(undefined);
  mockUnregister.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/push-subscriptions (spec 010 — criteria 3, 4, 5)", () => {
  it("stores the validated subscription for the session user and answers 201 { ok: true }", async () => {
    const res = await post(VALID);

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockRegister).toHaveBeenCalledWith(2, 1, { endpoint: ENDPOINT, p256dh: P256DH, auth: AUTH, locale: "pt" });
  });

  it("takes the owner from the session only and drops every other field (no userId, no extra keys)", async () => {
    await post({ ...VALID, userId: 99, groupId: 7, keys: { ...VALID.keys, extra: "x" }, expirationTime: null });

    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(mockRegister).toHaveBeenCalledWith(2, 1, { endpoint: ENDPOINT, p256dh: P256DH, auth: AUTH, locale: "pt" });
  });

  it("accepts a body without locale (the worker's pushsubscriptionchange re-POST): the service keeps the stored one", async () => {
    const res = await post({ endpoint: ENDPOINT, keys: VALID.keys });

    expect(res.status).toBe(201);
    expect(mockRegister).toHaveBeenCalledWith(2, 1, { endpoint: ENDPOINT, p256dh: P256DH, auth: AUTH });
    expect(mockRegister.mock.calls[0][2]).not.toHaveProperty("locale");
  });

  it("never returns the subscription's keys or endpoint (criterion 13)", async () => {
    const text = await (await post(VALID)).text();
    expect(text).toBe(JSON.stringify({ ok: true }));
  });

  it.each([
    ["an http endpoint", { ...VALID, endpoint: "http://fcm.googleapis.com/fcm/send/x" }],
    ["a look-alike host", { ...VALID, endpoint: "https://fcm.googleapis.com.evil.test/fcm/send/x" }],
    ["a host the legacy parser reads as 127.0.0.1", { ...VALID, endpoint: "https://127.0.0.1;.push.apple.com/x" }],
    ["a non-string endpoint", { ...VALID, endpoint: 42 }],
    ["missing keys", { endpoint: ENDPOINT, locale: "pt" }],
    ["a p256dh of the wrong length", { ...VALID, keys: { p256dh: P256DH.slice(1), auth: AUTH } }],
    ["an auth secret that is not base64url", { ...VALID, keys: { p256dh: P256DH, auth: `${AUTH.slice(0, 21)}+` } }],
    ["a locale outside en/pt/es/fr", { ...VALID, locale: "de" }],
    ["a non-string locale", { ...VALID, locale: 1 }],
    ["an array body", [VALID]],
    ["a null body", null],
    ["a body that is not JSON", "{not json"],
    ["no body at all", undefined],
  ])("answers 400 PUSH_SUBSCRIPTION_INVALID for %s and stores nothing (criterion 4)", async (_label, payload) => {
    const res = await post(payload);

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("PUSH_SUBSCRIPTION_INVALID");
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it("passes the session gate's 401 through and stores nothing", async () => {
    mockRequireSession.mockResolvedValueOnce(unauthenticated);
    const res = await post(VALID);

    expect(res.status).toBe(401);
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it("needs a session but no active house (a subscription belongs to a person)", async () => {
    await post(VALID);
    expect(mockRequireActiveGroup).not.toHaveBeenCalled();
  });

  it("passes the session version and, when a logout committed meanwhile, answers 401 SESSION_REVOKED and drops the cookie", async () => {
    mockRegister.mockRejectedValue(new ApiError("Session expired, please log in again", 401, "SESSION_REVOKED"));
    const res = await post(VALID);

    expect(mockRegister).toHaveBeenCalledWith(2, 1, expect.objectContaining({ endpoint: ENDPOINT }));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("SESSION_REVOKED");
    expect(res.headers.get("set-cookie") ?? "").toMatch(/homeshare_session=;/);
    expect(mockLogError).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it("maps an unexpected failure to a generic 500 without leaking its message", async () => {
    mockRegister.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    const res = await post(VALID);

    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).toContain("Failed to save push subscription");
    expect(text).not.toContain("ECONNREFUSED");
  });
});

describe("POST /api/push-subscriptions while push is not configured (spec 010 — criterion 1)", () => {
  it.each(VAPID_VARS)("answers 503 PUSH_NOT_CONFIGURED without %s and stores nothing", async (name) => {
    vi.stubEnv(name, "");
    const res = await post(VALID);

    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("PUSH_NOT_CONFIGURED");
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it("answers 503 even for an invalid body: while unconfigured no subscription is accepted at all", async () => {
    vi.stubEnv("VAPID_SUBJECT", "   ");
    const res = await post({ endpoint: "http://evil.test/" });

    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("PUSH_NOT_CONFIGURED");
  });

  it("treats the unconfigured state as normal operation: no error log, no Sentry event", async () => {
    vi.stubEnv("VAPID_PRIVATE_KEY", "");
    await post(VALID);

    expect(mockLogError).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it("still answers 401 first to a request without a valid session", async () => {
    vi.stubEnv("VAPID_PRIVATE_KEY", "");
    mockRequireSession.mockResolvedValueOnce(unauthenticated);
    expect((await post(VALID)).status).toBe(401);
  });
});

describe("DELETE /api/push-subscriptions (spec 010 — criteria 3, 5)", () => {
  it("removes the session user's row for that endpoint and answers 200 { ok: true }", async () => {
    const res = await del({ endpoint: ENDPOINT });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockUnregister).toHaveBeenCalledWith(2, ENDPOINT);
  });

  it("is idempotent: deleting the same endpoint again still answers 200", async () => {
    expect((await del({ endpoint: ENDPOINT })).status).toBe(200);
    expect((await del({ endpoint: ENDPOINT })).status).toBe(200);
    expect(mockUnregister).toHaveBeenCalledTimes(2);
  });

  it("only ever targets the session user's rows (a userId in the body is ignored) and reads only the endpoint", async () => {
    await del({ endpoint: ENDPOINT, userId: 99, keys: VALID.keys });
    expect(mockUnregister).toHaveBeenCalledWith(2, ENDPOINT);
  });

  it("works while push is not configured: a device can always clean up", async () => {
    for (const name of VAPID_VARS) vi.stubEnv(name, "");
    const res = await del({ endpoint: ENDPOINT });

    expect(res.status).toBe(200);
    expect(mockUnregister).toHaveBeenCalledWith(2, ENDPOINT);
  });

  it.each([
    ["an http endpoint", { endpoint: "http://fcm.googleapis.com/fcm/send/x" }],
    ["a look-alike host", { endpoint: "https://evilfcm.googleapis.com/x" }],
    ["a non-string endpoint", { endpoint: ["x"] }],
    ["a missing endpoint", {}],
    ["a null body", null],
    ["a body that is not JSON", "nope"],
    ["no body at all", undefined],
  ])("answers 400 PUSH_SUBSCRIPTION_INVALID for %s and deletes nothing", async (_label, payload) => {
    const res = await del(payload);

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("PUSH_SUBSCRIPTION_INVALID");
    expect(mockUnregister).not.toHaveBeenCalled();
  });

  it("passes the session gate's 401 through and deletes nothing", async () => {
    mockRequireSession.mockResolvedValueOnce(unauthenticated);
    const res = await del({ endpoint: ENDPOINT });

    expect(res.status).toBe(401);
    expect(mockUnregister).not.toHaveBeenCalled();
  });
});

// CSRF from a same-site sibling (SameSite=Lax still sends the cookie): a form or a no-cors fetch cannot send
// application/json, so a write without it is refused before the body is read.
describe("/api/push-subscriptions refuses non-JSON writes (CSRF)", () => {
  it.each([
    ["a text/plain form", "text/plain"],
    ["an urlencoded form", "application/x-www-form-urlencoded"],
    ["a multipart form", "multipart/form-data; boundary=x"],
    ["no content type", null],
  ])("POST with %s → 415, nothing stored", async (_label, contentType) => {
    const res = await send(POST, "POST", VALID, contentType);
    expect(res.status).toBe(415);
    expect((await res.json()).code).toBe("UNSUPPORTED_MEDIA_TYPE");
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it("DELETE with a text/plain form → 415, nothing deleted", async () => {
    const res = await send(DELETE, "DELETE", { endpoint: ENDPOINT }, "text/plain");
    expect(res.status).toBe(415);
    expect(mockUnregister).not.toHaveBeenCalled();
  });

  it("accepts application/json with a charset", async () => {
    const res = await send(POST, "POST", VALID, "application/json; charset=utf-8");
    expect(res.status).toBe(201);
  });
});
