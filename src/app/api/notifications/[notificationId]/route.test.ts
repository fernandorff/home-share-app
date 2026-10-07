import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import { ApiError } from "@/lib/errors";
import type * as ApiHelpers from "@/lib/api-helpers";

// PATCH (mark read) and DELETE of one notice. The session gate and the service are faked (no pglite socket);
// the compound { publicId, userId, groupId } scope — another member's or house's id is a 404 — is asserted by
// notification.service.test.ts and tenant-isolation.test.ts. Here: the route's body contract, that it hands
// the service the session user and the active house, and that the service's 404 reaches the client as is.
const { mockRequireActiveGroup, mockMarkRead, mockDelete } = vi.hoisted(() => ({
  mockRequireActiveGroup: vi.fn(),
  mockMarkRead: vi.fn(),
  mockDelete: vi.fn(),
}));
vi.mock("@/lib/api-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiHelpers>();
  return { ...actual, requireActiveGroup: mockRequireActiveGroup };
});
vi.mock("@/services/notification.service", () => ({ notificationService: { markRead: mockMarkRead, delete: mockDelete } }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
// handleApiError reads the request headers and talks to Sentry: both are irrelevant to these contracts.
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
vi.mock("@sentry/nextjs", () => ({ getClient: () => undefined, flush: async () => true, addBreadcrumb: () => {} }));

import { PATCH, DELETE } from "./route";

const session = { userId: 2, publicId: "bob", name: "Bob", sessionVersion: 1, iat: 0 };
const PUBLIC_ID = "0192f0c4-0000-7000-8000-000000000001";
const context = { params: Promise.resolve({ notificationId: PUBLIC_ID }) };
const notFound = () => new ApiError("Notice not found", 404, "NOTIFICATION_NOT_FOUND");

const patch = (payload: unknown) =>
  PATCH(
    new Request(`http://localhost/api/notifications/${PUBLIC_ID}`, {
      method: "PATCH",
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    }),
    context
  );
const remove = () => DELETE(new Request(`http://localhost/api/notifications/${PUBLIC_ID}`, { method: "DELETE" }), context);

beforeEach(() => {
  vi.resetAllMocks();
  mockRequireActiveGroup.mockResolvedValue({ ok: true, session, groupId: 7, role: "MEMBER" });
  mockMarkRead.mockResolvedValue(4);
  mockDelete.mockResolvedValue(4);
});

describe("PATCH /api/notifications/[notificationId] (spec 009 — criterion 12)", () => {
  it("{ read: true } marks the notice read for the session user in the active house and answers 200 { unreadCount }", async () => {
    const res = await patch({ read: true });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unreadCount: 4 });
    expect(mockMarkRead).toHaveBeenCalledWith(2, 7, PUBLIC_ID);
  });

  it("never takes the member or the house from the body", async () => {
    await patch({ read: true, userId: 1, groupId: 99 });
    expect(mockMarkRead).toHaveBeenCalledWith(2, 7, PUBLIC_ID);
  });

  it.each([
    ["read: false (no 'mark unread')", { read: false }],
    ["a string 'true'", { read: "true" }],
    ["no read field", {}],
    ["null", null],
    ["an array", [true]],
    ["malformed JSON", "{ read: true"],
  ])("%s → 400 NOTIFICATION_PATCH_INVALID and nothing changes", async (_label, payload) => {
    const res = await patch(payload);

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("NOTIFICATION_PATCH_INVALID");
    expect(mockMarkRead).not.toHaveBeenCalled();
  });

  it("another member's or house's notice (the service's 404) → 404 NOTIFICATION_NOT_FOUND", async () => {
    mockMarkRead.mockRejectedValue(notFound());
    const res = await patch({ read: true });

    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("NOTIFICATION_NOT_FOUND");
  });

  it("passes the session gate's 401 through before reading the body", async () => {
    mockRequireActiveGroup.mockResolvedValueOnce({ ok: false, response: NextResponse.json({ error: "Not authenticated" }, { status: 401 }) });
    expect((await patch({ read: true })).status).toBe(401);
    expect(mockMarkRead).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/notifications/[notificationId] (spec 009 — criterion 12)", () => {
  it("removes the notice for the session user in the active house and answers 200 { unreadCount }", async () => {
    const res = await remove();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unreadCount: 4 });
    expect(mockDelete).toHaveBeenCalledWith(2, 7, PUBLIC_ID);
  });

  it("another member's or house's notice (the service's 404) → 404 NOTIFICATION_NOT_FOUND", async () => {
    mockDelete.mockRejectedValue(notFound());
    const res = await remove();

    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("NOTIFICATION_NOT_FOUND");
  });

  it("passes the session gate's 403 through and deletes nothing", async () => {
    mockRequireActiveGroup.mockResolvedValueOnce({ ok: false, response: NextResponse.json({ error: "No house", code: "NO_GROUP" }, { status: 403 }) });
    expect((await remove()).status).toBe(403);
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
