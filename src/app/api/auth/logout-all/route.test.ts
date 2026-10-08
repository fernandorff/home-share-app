import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import type * as ApiHelpers from "@/lib/api-helpers";

// POST /api/auth/logout-all (ADR 0013): revokes every session of the member (sessionVersion bump, which also deletes
// every push subscription in the same transaction — pinned in auth.service.test.ts) and clears this browser's cookies.
const { mockRequireSession, mockBump, mockLogError } = vi.hoisted(() => ({
  mockRequireSession: vi.fn(),
  mockBump: vi.fn(),
  mockLogError: vi.fn(),
}));
vi.mock("@/lib/api-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiHelpers>();
  return { ...actual, requireSession: mockRequireSession };
});
vi.mock("@/services/auth.service", () => ({ authService: { bumpSessionVersion: mockBump } }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: mockLogError } }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
vi.mock("@sentry/nextjs", () => ({ getClient: () => undefined, flush: async () => true, addBreadcrumb: () => {} }));

import { POST } from "./route";
import { GROUP_COOKIE, SESSION_COOKIE } from "@/lib/auth";

const session = { userId: 7, publicId: "user-7", name: "Bob", sessionVersion: 3, iat: 0, authAt: 0 };

function clearedCookies(res: Response): string[] {
  return res.headers
    .getSetCookie()
    .filter((line) => /expires=Thu, 01 Jan 1970|max-age=0/i.test(line))
    .map((line) => line.slice(0, line.indexOf("=")));
}

beforeEach(() => {
  vi.resetAllMocks();
  mockRequireSession.mockResolvedValue({ ok: true, session });
  mockBump.mockResolvedValue(4);
});

describe("POST /api/auth/logout-all", () => {
  it("bumps the session user's sessionVersion, clears both cookies and answers { ok: true }", async () => {
    const res = await POST();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockBump).toHaveBeenCalledWith(7);
    expect(clearedCookies(res).sort()).toEqual([GROUP_COOKIE, SESSION_COOKIE].sort());
  });

  it("without a valid session: the gate's 401, nothing revoked", async () => {
    mockRequireSession.mockResolvedValueOnce({
      ok: false,
      response: NextResponse.json({ error: "Not authenticated", code: "NOT_AUTHENTICATED" }, { status: 401 }),
    });
    const res = await POST();

    expect(res.status).toBe(401);
    expect(mockBump).not.toHaveBeenCalled();
  });

  it("a failed revocation is a 500 that keeps the cookies — the member sees it failed and can retry", async () => {
    mockBump.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    const res = await POST();

    expect(res.status).toBe(500);
    expect(clearedCookies(res)).toEqual([]);
  });
});
