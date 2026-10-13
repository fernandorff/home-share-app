import { describe, it, expect, vi, afterEach } from "vitest";
import { api, redirectOnSessionLoss } from "./api";

function stubWindow(pathname: string) {
  const location = { pathname, href: pathname };
  vi.stubGlobal("window", { location });
  return location;
}

afterEach(() => vi.unstubAllGlobals());

describe("redirectOnSessionLoss", () => {
  it("sends the browser to the login page when the session is gone", () => {
    for (const code of [undefined, "NOT_AUTHENTICATED", "SESSION_REVOKED"]) {
      const location = stubWindow("/expenses");
      redirectOnSessionLoss(code);
      expect(location.href).toBe("/auth/login");
    }
  });

  it("leaves a different 401 (wrong credentials, reauth) to the caller", () => {
    const location = stubWindow("/account");
    redirectOnSessionLoss("INVALID_CREDENTIALS");
    expect(location.href).toBe("/account");
  });

  it("never redirects from an /auth page", () => {
    const location = stubWindow("/auth/login");
    redirectOnSessionLoss("NOT_AUTHENTICATED");
    expect(location.href).toBe("/auth/login");
  });
});

// Cycle G review M4: the push routes refuse a write without application/json (CSRF, 415). The card's
// api.post("/api/notifications/test") passes no body — the wrapper still sends "{}" with the JSON content type.
describe("api.post without a body", () => {
  it("sends an empty JSON object with Content-Type application/json", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ sent: 1, failed: 0 }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(api.post("/api/notifications/test")).resolves.toEqual({ sent: 1, failed: 0 });
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/notifications/test");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });
});
