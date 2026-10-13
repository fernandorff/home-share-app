import { describe, it, expect } from "vitest";
import { buildSentryOptions, createTracesSampler, resolveTracesSampleRate, type SentryInitOptions } from "./options";
import { ALLOWED_REQUEST_HEADERS, ALLOWED_RESPONSE_HEADERS, scrubEvent, scrubSpan } from "./scrub";

const DSN = "https://k@o1.ingest.sentry.io/2";

type SamplerContext = Parameters<NonNullable<SentryInitOptions["tracesSampler"]>>[0];

/** A sampling context whose inheritOrSampleWith mimics the SDK: parent decision first, else the fallback rate. */
function samplingContext(partial: Partial<SamplerContext> & { name: string }): SamplerContext {
  return {
    attributes: {},
    inheritOrSampleWith(fallback: number) {
      if (this.parentSampled !== undefined) return this.parentSampled ? 1 : 0;
      return fallback;
    },
    ...partial,
  };
}

describe("resolveTracesSampleRate (R14)", () => {
  it.each<[string | undefined, string, number]>([
    [undefined, "production", 0.1],
    [undefined, "preview", 1],
    [undefined, "development", 1],
    ["", "production", 0.1],
    ["0.25", "production", 0.25],
    ["0", "production", 0],
    ["1", "production", 1],
    ["abc", "production", 0.1],
    ["1.5", "development", 1],
    ["-0.1", "production", 0.1],
  ])("raw %s in %s → %s", (raw, environment, expected) => {
    expect(resolveTracesSampleRate(raw, environment)).toBe(expected);
  });
});

describe("buildSentryOptions", () => {
  it.each([undefined, "", "   "])("returns null without a DSN (%j)", (dsn) => {
    expect(buildSentryOptions({ dsn, environment: "production", tracesSampleRate: undefined })).toBeNull();
  });

  it("sets every data-collection category to the restrictive side (v11 defaults are permissive) — R3", () => {
    const options = buildSentryOptions({ dsn: ` ${DSN} `, environment: "production", tracesSampleRate: undefined });
    expect(options).toMatchObject({ dsn: DSN, environment: "production", tracesSampleRate: 0.1 });
    expect(options?.dataCollection).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: {
        request: { allow: ["user-agent", "content-type", "content-length", "accept-language"] },
        response: { allow: ["content-type", "content-length"] },
      },
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      graphQL: { document: false, variables: false },
      stackFrameVariables: false,
    });
  });

  it("keeps request/response bodies, user info and URL query params off — R4/R5", () => {
    const dataCollection = buildSentryOptions({ dsn: DSN, environment: "production", tracesSampleRate: undefined })?.dataCollection;
    expect(dataCollection?.httpBodies).toEqual([]);
    expect(dataCollection?.userInfo).toBe(false);
    expect(dataCollection?.urlQueryParams).toBe(false);
    expect(dataCollection?.cookies).toBe(false);
  });

  it("restricts HTTP headers to the allowlist the scrubbers use, for both directions — R4/R5", () => {
    const dataCollection = buildSentryOptions({ dsn: DSN, environment: "production", tracesSampleRate: undefined })?.dataCollection;
    expect(dataCollection?.httpHeaders).toEqual({
      request: { allow: ALLOWED_REQUEST_HEADERS },
      response: { allow: ALLOWED_RESPONSE_HEADERS },
    });
  });

  it("defaults the environment to development (full sampling)", () => {
    expect(buildSentryOptions({ dsn: DSN, environment: undefined, tracesSampleRate: undefined }))
      .toMatchObject({ environment: "development", tracesSampleRate: 1 });
  });

  it("drops health-check spans and wires the scrubbers", () => {
    const options = buildSentryOptions({ dsn: DSN, environment: "preview", tracesSampleRate: "0.5" });
    expect(options?.tracesSampleRate).toBe(0.5);
    expect(options?.ignoreSpans).toEqual([/\/api\/health/]);
    expect(options?.beforeSend).toBe(scrubEvent);
    expect(options?.beforeSendSpan).toBe(scrubSpan);
  });
});

describe("createTracesSampler — drops the whole /api/health trace at sampling time", () => {
  const sampler = createTracesSampler(0.25);

  it.each(["GET /api/health", "GET /api/health?db=1", "/api/health", "/api/health?db=1", "HEAD /api/health/"])(
    "returns 0 for the transaction name %s",
    (name) => {
      expect(sampler(samplingContext({ name }))).toBe(0);
    },
  );

  it("returns 0 when the request URL is the health endpoint, whatever the span name", () => {
    const context = samplingContext({
      name: "resolve page components",
      normalizedRequest: { url: "http://127.0.0.1:3100/api/health?db=1", method: "GET" },
    });
    expect(sampler(context)).toBe(0);
  });

  it("returns 0 when a request-path span attribute is the health endpoint", () => {
    expect(sampler(samplingContext({ name: "GET", attributes: { "url.path": "/api/health" } }))).toBe(0);
    expect(sampler(samplingContext({ name: "GET", attributes: { "http.target": "/api/health?db=1" } }))).toBe(0);
  });

  it("drops the trace even when the parent decided to sample it", () => {
    expect(sampler(samplingContext({ name: "GET /api/health", parentSampled: true }))).toBe(0);
  });

  it("returns the configured rate for other routes", () => {
    expect(sampler(samplingContext({ name: "GET /api/expenses" }))).toBe(0.25);
    expect(
      sampler(samplingContext({ name: "GET /api/expenses", normalizedRequest: { url: "http://localhost:3000/api/expenses?month=2026-10" } })),
    ).toBe(0.25);
  });

  it("respects an inherited parent decision for other routes", () => {
    expect(sampler(samplingContext({ name: "GET /api/expenses", parentSampled: true }))).toBe(1);
    expect(sampler(samplingContext({ name: "GET /api/expenses", parentSampled: false }))).toBe(0);
  });

  it.each(["GET /api/healthcheck", "GET /api/health/x", "GET /api/healthx?db=1", "GET /app/api/health"])(
    "does NOT drop %s",
    (name) => {
      expect(sampler(samplingContext({ name }))).toBe(0.25);
    },
  );

  it("does NOT drop a URL that merely carries /api/health in its query string", () => {
    const context = samplingContext({
      name: "GET /api/expenses",
      normalizedRequest: { url: "http://localhost:3000/api/expenses?next=/api/health" },
    });
    expect(sampler(context)).toBe(0.25);
  });

  it("is wired into buildSentryOptions with the env-driven rate", () => {
    const options = buildSentryOptions({ dsn: DSN, environment: "preview", tracesSampleRate: "0.5" });
    expect(options?.tracesSampleRate).toBe(0.5);
    expect(options?.tracesSampler?.(samplingContext({ name: "GET /api/health" }))).toBe(0);
    expect(options?.tracesSampler?.(samplingContext({ name: "GET /api/expenses" }))).toBe(0.5);
  });
});
