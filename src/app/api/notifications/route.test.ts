import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import type * as ApiHelpers from "@/lib/api-helpers";

// The center's collection routes: GET /api/notifications, GET /api/notifications/unread-count and
// POST /api/notifications/read-all. The session gate and the service are faked (no pglite socket); the
// service's scoping is asserted by notification.service.test.ts and tenant-isolation.test.ts — here only
// that every route hands it the session user and the server-resolved active house, never the request's.
const { mockRequireActiveGroup, mockList, mockUnreadCount, mockMarkAllRead, mockLogError } = vi.hoisted(() => ({
  mockRequireActiveGroup: vi.fn(),
  mockList: vi.fn(),
  mockUnreadCount: vi.fn(),
  mockMarkAllRead: vi.fn(),
  mockLogError: vi.fn(),
}));
vi.mock("@/lib/api-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiHelpers>();
  return { ...actual, requireActiveGroup: mockRequireActiveGroup };
});
vi.mock("@/services/notification.service", () => ({
  notificationService: { list: mockList, unreadCount: mockUnreadCount, markAllRead: mockMarkAllRead },
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: mockLogError } }));
// handleApiError reads the request headers and talks to Sentry: both are irrelevant to these contracts.
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
vi.mock("@sentry/nextjs", () => ({ getClient: () => undefined, flush: async () => true, addBreadcrumb: () => {} }));

import { GET as list } from "./route";
import { GET as unreadCount } from "./unread-count/route";
import { POST as readAll } from "./read-all/route";

const session = { userId: 2, publicId: "bob", name: "Bob", sessionVersion: 1, iat: 0 };
const NOTICE = {
  publicId: "0192f0c4-0000-7000-8000-000000000001",
  type: "EXPENSE_NEW",
  actorId: 1,
  params: { expensePublicId: "0192f0c4-0000-7000-8000-0000000000aa", description: "Groceries", amount: "90.00", recurring: false },
  read: false,
  createdAt: "2026-10-04T12:00:00.000Z",
};

const unauthenticated = { ok: false, response: NextResponse.json({ error: "Not authenticated", code: "NOT_AUTHENTICATED" }, { status: 401 }) };
const noHouse = { ok: false, response: NextResponse.json({ error: "No house", code: "NO_GROUP" }, { status: 403 }) };

const getList = (query = "") => list(new Request(`http://localhost/api/notifications${query}`));

beforeEach(() => {
  vi.resetAllMocks();
  mockRequireActiveGroup.mockResolvedValue({ ok: true, session, groupId: 7, role: "MEMBER" });
  mockList.mockResolvedValue({ notifications: [NOTICE], unreadCount: 3 });
  mockUnreadCount.mockResolvedValue(3);
  mockMarkAllRead.mockResolvedValue(undefined);
});

describe("GET /api/notifications (spec 009 — criterion 11)", () => {
  it("answers 200 { notifications, unreadCount, groupId } for the session user in the active house", async () => {
    const res = await getList();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ notifications: [NOTICE], unreadCount: 3, groupId: 7 });
    expect(mockList).toHaveBeenCalledWith(2, 7, { unreadOnly: false });
  });

  // Another tab can move the active-house cookie: the answer names the house it was read for, so a client still
  // showing another house drops it and re-reads the session instead of listing house B's notices under house A.
  it("names the house it answered for: the server-resolved active house, never one from the request", async () => {
    mockRequireActiveGroup.mockResolvedValueOnce({ ok: true, session, groupId: 9, role: "ADMIN" });
    const res = await getList("?groupId=7");

    expect((await res.json()).groupId).toBe(9);
    expect(mockList).toHaveBeenCalledWith(2, 9, { unreadOnly: false });
  });

  it("?filter=unread lists unread notices only; any other filter value lists all", async () => {
    await getList("?filter=unread");
    expect(mockList).toHaveBeenLastCalledWith(2, 7, { unreadOnly: true });

    await getList("?filter=everything");
    expect(mockList).toHaveBeenLastCalledWith(2, 7, { unreadOnly: false });
  });

  it("never takes the member or the house from the query string", async () => {
    await getList("?userId=1&groupId=99");
    expect(mockList).toHaveBeenCalledWith(2, 7, { unreadOnly: false });
  });

  it("passes the session gate's 401 and 403 NO_GROUP through and reads nothing", async () => {
    mockRequireActiveGroup.mockResolvedValueOnce(unauthenticated);
    expect((await getList()).status).toBe(401);
    mockRequireActiveGroup.mockResolvedValueOnce(noHouse);
    const res = await getList();
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("NO_GROUP");
    expect(mockList).not.toHaveBeenCalled();
  });

  it("maps an unexpected failure to a generic 500 without leaking its message", async () => {
    mockList.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    const res = await getList();
    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).toContain("Failed to list notices");
    expect(text).not.toContain("ECONNREFUSED");
  });
});

describe("GET /api/notifications/unread-count (spec 009 — criteria 11, 14)", () => {
  it("answers 200 { count, groupId } for the session user in the active house", async () => {
    const res = await unreadCount();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 3, groupId: 7 });
    expect(mockUnreadCount).toHaveBeenCalledWith(2, 7);
  });

  it("names the house it counted for (the bell drops a count of another house)", async () => {
    mockRequireActiveGroup.mockResolvedValueOnce({ ok: true, session, groupId: 9, role: "ADMIN" });
    expect(await (await unreadCount()).json()).toEqual({ count: 3, groupId: 9 });
  });

  it("passes the session gate's 401 and 403 through and counts nothing", async () => {
    mockRequireActiveGroup.mockResolvedValueOnce(unauthenticated);
    expect((await unreadCount()).status).toBe(401);
    mockRequireActiveGroup.mockResolvedValueOnce(noHouse);
    expect((await unreadCount()).status).toBe(403);
    expect(mockUnreadCount).not.toHaveBeenCalled();
  });
});

describe("POST /api/notifications/read-all (spec 009 — criterion 12)", () => {
  // The handler takes no request at all: nothing a client sends can choose the member or the house.
  const post = () => readAll();

  it("marks the session user's notices in the active house read and answers 200 { unreadCount: 0 }", async () => {
    const res = await post();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unreadCount: 0 });
    expect(mockMarkAllRead).toHaveBeenCalledWith(2, 7);
  });

  it("passes the session gate's 401 and 403 through and changes nothing", async () => {
    mockRequireActiveGroup.mockResolvedValueOnce(unauthenticated);
    expect((await post()).status).toBe(401);
    mockRequireActiveGroup.mockResolvedValueOnce(noHouse);
    expect((await post()).status).toBe(403);
    expect(mockMarkAllRead).not.toHaveBeenCalled();
  });
});
