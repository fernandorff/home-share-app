import { describe, it, expect } from "vitest";
import {
  REQUEST_ID_HEADER,
  REQUEST_PATH_HEADER,
  REQUEST_START_HEADER,
  normalizeRoute,
  readRequestContext,
  stampRequestContext,
} from "./request-context";

describe("normalizeRoute", () => {
  it.each([
    ["/api/expenses/0b4f7c2e-1d2a-4c3b-9e8f-123456789abc/history", "/api/expenses/:id/history"],
    ["/api/groups/active/members/42", "/api/groups/active/members/:id"],
    ["/api/health", "/api/health"],
    ["/", "/"],
  ])("%s → %s", (pathname, expected) => {
    expect(normalizeRoute(pathname)).toBe(expected);
  });
});

describe("stampRequestContext", () => {
  it("stamps id, path and start, preferring Vercel's request id", () => {
    const headers = stampRequestContext(new Headers({ "x-vercel-id": "gru1::iad1::abc-123" }), "/api/expenses", 1000);
    expect(headers.get(REQUEST_ID_HEADER)).toBe("gru1::iad1::abc-123");
    expect(headers.get(REQUEST_PATH_HEADER)).toBe("/api/expenses");
    expect(headers.get(REQUEST_START_HEADER)).toBe("1000");
  });

  it("overwrites client-supplied values and generates an id off Vercel", () => {
    const forged = new Headers({ [REQUEST_ID_HEADER]: "forged", [REQUEST_PATH_HEADER]: "/x", [REQUEST_START_HEADER]: "1" });
    const headers = stampRequestContext(forged, "/api/shopping-items", 2000);
    expect(headers.get(REQUEST_ID_HEADER)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(headers.get(REQUEST_PATH_HEADER)).toBe("/api/shopping-items");
    expect(headers.get(REQUEST_START_HEADER)).toBe("2000");
  });
});

describe("readRequestContext", () => {
  it("returns the id, the normalized route and the elapsed time", () => {
    const headers = new Headers({
      [REQUEST_ID_HEADER]: "gru1::iad1::abc-123",
      [REQUEST_PATH_HEADER]: "/api/expenses/0b4f7c2e-1d2a-4c3b-9e8f-123456789abc",
      [REQUEST_START_HEADER]: "1000",
    });
    expect(readRequestContext(headers, 1250)).toEqual({ requestId: "gru1::iad1::abc-123", route: "/api/expenses/:id", durationMs: 250 });
  });

  it("ignores missing, malformed or future values", () => {
    expect(readRequestContext(new Headers(), 1000)).toEqual({});
    const bad = new Headers({ [REQUEST_ID_HEADER]: "has spaces", [REQUEST_PATH_HEADER]: "api/x", [REQUEST_START_HEADER]: "5000" });
    expect(readRequestContext(bad, 1000)).toEqual({});
  });
});
