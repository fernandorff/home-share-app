import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { sentry } = vi.hoisted(() => ({
  sentry: { init: vi.fn(), captureRequestError: vi.fn(), captureRouterTransitionStart: vi.fn() },
}));
vi.mock("@sentry/nextjs", () => sentry);

const DSN = "https://k@o1.ingest.sentry.io/2";

beforeEach(() => {
  vi.resetModules();
  sentry.init.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("server/edge instrumentation (R1)", () => {
  it("does not initialize the SDK without SENTRY_DSN", async () => {
    vi.stubEnv("SENTRY_DSN", "");
    const { register } = await import("./instrumentation");
    register();
    expect(sentry.init).not.toHaveBeenCalled();
  });

  it("initializes from SENTRY_DSN / SENTRY_TRACES_SAMPLE_RATE / VERCEL_ENV and exposes onRequestError", async () => {
    vi.stubEnv("SENTRY_DSN", DSN);
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("SENTRY_TRACES_SAMPLE_RATE", "0.5");
    const instrumentation = await import("./instrumentation");
    instrumentation.register();
    expect(sentry.init).toHaveBeenCalledTimes(1);
    expect(sentry.init.mock.calls[0][0]).toMatchObject({ dsn: DSN, environment: "production", tracesSampleRate: 0.5 });
    expect(instrumentation.onRequestError).toBe(sentry.captureRequestError);
  });
});

describe("browser instrumentation (R1)", () => {
  it("does not initialize the SDK without NEXT_PUBLIC_SENTRY_DSN", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "");
    await import("./instrumentation-client");
    expect(sentry.init).not.toHaveBeenCalled();
  });

  it("initializes from the NEXT_PUBLIC_* variables and exposes onRouterTransitionStart", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", DSN);
    vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", "preview");
    vi.stubEnv("NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE", "");
    const client = await import("./instrumentation-client");
    expect(sentry.init).toHaveBeenCalledTimes(1);
    expect(sentry.init.mock.calls[0][0]).toMatchObject({ dsn: DSN, environment: "preview", tracesSampleRate: 1 });
    expect(client.onRouterTransitionStart).toBe(sentry.captureRouterTransitionStart);
  });
});
