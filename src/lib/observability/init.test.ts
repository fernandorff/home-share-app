import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockInit } = vi.hoisted(() => ({ mockInit: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ init: mockInit }));

import { initSentry } from "./init";

const DSN = "https://k@o1.ingest.sentry.io/2";

beforeEach(() => {
  mockInit.mockReset();
});

describe("initSentry — env guard (R1)", () => {
  it("does not initialize the SDK without a DSN", () => {
    expect(initSentry({ dsn: undefined, environment: "production", tracesSampleRate: undefined })).toBe(false);
    expect(initSentry({ dsn: "  ", environment: "production", tracesSampleRate: undefined })).toBe(false);
    expect(mockInit).not.toHaveBeenCalled();
  });

  it("initializes once with the privacy-first options when a DSN is set", () => {
    expect(initSentry({ dsn: DSN, environment: "preview", tracesSampleRate: undefined })).toBe(true);
    expect(mockInit).toHaveBeenCalledTimes(1);
    expect(mockInit.mock.calls[0][0]).toMatchObject({
      dsn: DSN,
      environment: "preview",
      tracesSampleRate: 1,
      dataCollection: { userInfo: false, cookies: false, httpBodies: [], databaseQueryData: false },
    });
  });
});
