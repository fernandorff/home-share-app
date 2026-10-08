import { describe, it, expect } from "vitest";
import { POST } from "./route";
import { GROUP_COOKIE, SESSION_COOKIE } from "@/lib/auth";

// POST /api/auth/logout (ADR 0013): logs out THIS browser only — clears its cookies, revokes nothing, so the member's
// other devices stay signed in. The client deletes this device's push subscription first (lib/logout.test.ts);
// revoking every session is POST /api/auth/logout-all.

/** The cookie names this response expires (Set-Cookie with an empty value and a past expiry / Max-Age=0). */
function clearedCookies(res: Response): string[] {
  return res.headers
    .getSetCookie()
    .filter((line) => /expires=Thu, 01 Jan 1970|max-age=0/i.test(line))
    .map((line) => line.slice(0, line.indexOf("=")));
}

describe("POST /api/auth/logout", () => {
  it("clears both cookies and answers { ok: true }", async () => {
    const res = await POST();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(clearedCookies(res).sort()).toEqual([GROUP_COOKIE, SESSION_COOKIE].sort());
  });

  it("revokes nothing: the route never touches the user (sessionVersion) or the push subscriptions", async () => {
    const source = (await import("node:fs")).readFileSync(new URL("./route.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/bumpSessionVersion|authService|pushService|prisma/);
  });
});
