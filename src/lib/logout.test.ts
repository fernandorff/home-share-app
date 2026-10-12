import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({ api: { post: vi.fn() } }));
vi.mock("@/lib/push/client", () => ({ unsubscribePush: vi.fn() }));

import { api } from "@/lib/api";
import { unsubscribePush } from "@/lib/push/client";
import { logout } from "./logout";

// Client logout (ADR 0013): this device's push subscription goes first — while the session still authorizes the
// DELETE — then the cookies; the browser always ends on the login page.
const post = vi.mocked(api.post);
const unsubscribe = vi.mocked(unsubscribePush);
const location = { href: "/expenses" };

beforeEach(() => {
  vi.resetAllMocks();
  unsubscribe.mockResolvedValue(undefined);
  location.href = "/expenses";
  vi.stubGlobal("window", { location });
});
afterEach(() => vi.unstubAllGlobals());

describe("logout()", () => {
  it("releases this device's push subscription, then logs out, then goes to the login page", async () => {
    const calls: string[] = [];
    unsubscribe.mockImplementation(async () => void calls.push("unsubscribe"));
    post.mockImplementation(async () => void calls.push("logout"));

    await logout();

    expect(calls).toEqual(["unsubscribe", "logout"]);
    expect(post).toHaveBeenCalledWith("/api/auth/logout");
    expect(location.href).toBe("/auth/login");
  });

  it("a failed push release never blocks the logout", async () => {
    unsubscribe.mockRejectedValueOnce(new Error("offline"));
    post.mockResolvedValueOnce({ ok: true });

    await logout();

    expect(post).toHaveBeenCalledWith("/api/auth/logout");
    expect(location.href).toBe("/auth/login");
  });

  it("a failed logout request still lands on the login page", async () => {
    post.mockRejectedValueOnce(new Error("offline"));

    await expect(logout()).rejects.toThrow("offline");
    expect(location.href).toBe("/auth/login");
  });
});
