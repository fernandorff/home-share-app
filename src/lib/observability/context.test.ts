import { describe, it, expect, vi, beforeEach } from "vitest";

const { sentry } = vi.hoisted(() => ({
  sentry: { getClient: vi.fn(), captureException: vi.fn(), setUser: vi.fn(), setTag: vi.fn() },
}));
vi.mock("@sentry/nextjs", () => sentry);

import { captureServerError, setObservedHouse, setObservedUser } from "./context";

const USER_ID = "3f2b8c1e-5a6d-4e7f-9a0b-1c2d3e4f5a6b";
const HOUSE_ID = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("observed identity (R8)", () => {
  it("sets only the opaque user id, and clears it", () => {
    setObservedUser(USER_ID);
    setObservedUser(null);
    expect(sentry.setUser.mock.calls).toEqual([[{ id: USER_ID }], [null]]);
  });

  it("tags the house with its publicId, and clears it", () => {
    setObservedHouse(HOUSE_ID);
    setObservedHouse(null);
    expect(sentry.setTag.mock.calls).toEqual([["house", HOUSE_ID], ["house", undefined]]);
  });
});

describe("captureServerError (R6)", () => {
  it("captures once with the dashboard tags and returns the event id", () => {
    sentry.getClient.mockReturnValue({});
    sentry.captureException.mockReturnValue("evt-1");
    const error = new Error("boom");
    expect(captureServerError(error, { route: "/api/expenses/:id", status: 503, code: "UPSTREAM_DOWN", requestId: "req-1" })).toBe("evt-1");
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(error, {
      tags: { http_status: "503", route: "/api/expenses/:id", api_error_code: "UPSTREAM_DOWN", request_id: "req-1" },
    });
  });

  it("omits absent tags", () => {
    sentry.getClient.mockReturnValue({});
    captureServerError(new Error("x"), { status: 500 });
    expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error), { tags: { http_status: "500" } });
  });

  it("does nothing and returns undefined while the SDK is not initialized", () => {
    sentry.getClient.mockReturnValue(undefined);
    expect(captureServerError(new Error("x"), { status: 500 })).toBeUndefined();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });
});
