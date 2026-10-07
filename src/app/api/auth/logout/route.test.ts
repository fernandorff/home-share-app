import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as Auth from "@/lib/auth";

// POST /api/auth/logout: bumps sessionVersion (revoking every token and, spec 010 criterion 9, deleting the member's
// push subscriptions in the same transaction) and always clears this browser's cookies. The cookie store, the token
// check and the service are faked (no pglite socket); the bump's own transaction is pinned in auth.service.test.ts.
const { mockCookieGet, mockVerifySession, mockBump, mockLogError } = vi.hoisted(() => ({
  mockCookieGet: vi.fn(),
  mockVerifySession: vi.fn(),
  mockBump: vi.fn(),
  mockLogError: vi.fn(),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: mockCookieGet }) }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof Auth>();
  return { ...actual, verifySession: mockVerifySession };
});
vi.mock("@/services/auth.service", () => ({ authService: { bumpSessionVersion: mockBump } }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: mockLogError } }));

import { POST } from "./route";
import { GROUP_COOKIE, SESSION_COOKIE } from "@/lib/auth";

const session = { userId: 7, publicId: "user-7", name: "Bob", sessionVersion: 3, iat: 0 };

/** The cookie names this response expires (Set-Cookie with an empty value and a past expiry / Max-Age=0). */
function clearedCookies(res: Response): string[] {
  return res.headers
    .getSetCookie()
    .filter((line) => /expires=Thu, 01 Jan 1970|max-age=0/i.test(line))
    .map((line) => line.slice(0, line.indexOf("=")));
}

beforeEach(() => {
  vi.resetAllMocks();
  mockCookieGet.mockReturnValue({ value: "signed.jwt.token" });
  mockVerifySession.mockResolvedValue(session);
  mockBump.mockResolvedValue(4);
});

describe("POST /api/auth/logout", () => {
  it("revokes the session (sessionVersion bump), clears both cookies and answers { ok: true }", async () => {
    const res = await POST();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockBump).toHaveBeenCalledWith(7);
    expect(clearedCookies(res).sort()).toEqual([GROUP_COOKIE, SESSION_COOKIE].sort());
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it("without a valid token: nothing to revoke, the cookies are still cleared", async () => {
    mockVerifySession.mockResolvedValueOnce(null);
    const res = await POST();

    expect(res.status).toBe(200);
    expect(mockBump).not.toHaveBeenCalled();
    expect(clearedCookies(res).sort()).toEqual([GROUP_COOKIE, SESSION_COOKIE].sort());
  });

  // Cycle G review M8: the revocation failing used to be swallowed silently — the token (and, since spec 010, the push
  // subscriptions) would live on with no trace. Still logged out here; now logged as an error.
  it("a failed revocation is logged as an error (fixed message, no fields) — the browser is still logged out", async () => {
    const failure = new Error("connect ECONNREFUSED 10.0.0.5:5432");
    mockBump.mockRejectedValueOnce(failure);
    const res = await POST();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(clearedCookies(res).sort()).toEqual([GROUP_COOKIE, SESSION_COOKIE].sort());
    expect(mockLogError).toHaveBeenCalledTimes(1);
    expect(mockLogError).toHaveBeenCalledWith("logout: session revocation failed", {}, failure);
  });
});
