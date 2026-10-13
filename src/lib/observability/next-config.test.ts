import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockWithSentryConfig } = vi.hoisted(() => ({
  mockWithSentryConfig: vi.fn((config: object, options: object) => ({ ...config, sentryOptions: options })),
}));
vi.mock("@sentry/nextjs/config", () => ({ withSentryConfig: mockWithSentryConfig }));
vi.mock("next-intl/plugin", () => ({ default: () => (config: object) => config }));

const DSN = "https://k@o1.ingest.sentry.io/2";
const SENTRY_BUILD_VARS = ["SENTRY_DSN", "NEXT_PUBLIC_SENTRY_DSN", "SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT"];
const VAPID_VARS = ["NEXT_PUBLIC_VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"] as const;

type LoadedConfig = Record<string, unknown> & {
  sentryOptions?: Record<string, unknown>;
  headers?: () => Promise<Array<{ headers: Array<{ key: string; value: string }> }>>;
};

async function loadConfig(env: Record<string, string>): Promise<LoadedConfig> {
  for (const name of [...SENTRY_BUILD_VARS, ...VAPID_VARS]) vi.stubEnv(name, env[name] ?? "");
  vi.resetModules();
  return (await import("../../../next.config")).default as unknown as LoadedConfig;
}

beforeEach(() => {
  mockWithSentryConfig.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("next.config Sentry gate (R2, R12)", () => {
  it("exports the config untouched without a DSN", async () => {
    const config = await loadConfig({});
    expect(mockWithSentryConfig).not.toHaveBeenCalled();
    expect(config).not.toHaveProperty("sentryOptions");
    expect(typeof config.headers).toBe("function");
  });

  it("wraps with the same-origin tunnel and no source-map upload when there is no auth token", async () => {
    const config = await loadConfig({ NEXT_PUBLIC_SENTRY_DSN: DSN });
    expect(mockWithSentryConfig).toHaveBeenCalledTimes(1);
    expect(config.sentryOptions).toMatchObject({ tunnelRoute: "/monitoring", telemetry: false, sourcemaps: { disable: true } });
  });

  it("enables source-map upload only when SENTRY_AUTH_TOKEN exists", async () => {
    const config = await loadConfig({ SENTRY_DSN: DSN, SENTRY_AUTH_TOKEN: "sntrys_test", SENTRY_ORG: "acme", SENTRY_PROJECT: "home-share" });
    expect(config.sentryOptions).toMatchObject({
      org: "acme",
      project: "home-share",
      authToken: "sntrys_test",
      sourcemaps: { disable: false },
    });
  });

  it("keeps the production CSP connect-src same-origin", async () => {
    const config = await loadConfig({ NEXT_PUBLIC_SENTRY_DSN: DSN });
    vi.stubEnv("NODE_ENV", "production");
    const [rule] = await config.headers!();
    const csp = rule.headers.find((header) => header.key === "Content-Security-Policy")?.value ?? "";
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("sentry.io");
  });
});

// Cycle G review, M1: all three VAPID variables or none. A partial set used to ship a push switch and a worker while the
// server refused every subscription (503); the config now refuses to load, naming the missing variables only.
describe("next.config Web Push gate (spec 010, cycle G review M1)", () => {
  const VAPID = {
    NEXT_PUBLIC_VAPID_PUBLIC_KEY: "BPublicVALUE123",
    VAPID_PRIVATE_KEY: "privateVALUE456",
    VAPID_SUBJECT: "mailto:secret-subject@example.com",
  };
  const loadError = (env: Record<string, string>) => loadConfig(env).then(() => null, (error: Error) => error);

  it("loads with none of the VAPID variables (push off) and with all three (push on)", async () => {
    expect(typeof (await loadConfig({})).headers).toBe("function");
    expect(typeof (await loadConfig(VAPID)).headers).toBe("function");
  });

  it.each(VAPID_VARS)("refuses to load when only %s is missing, naming it", async (missing) => {
    const error = await loadError({ ...VAPID, [missing]: "" });
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain(`missing: ${missing}.`);
  });

  it("refuses to load with only the public key (the reviewed case), naming the two missing variables", async () => {
    const error = await loadError({ NEXT_PUBLIC_VAPID_PUBLIC_KEY: VAPID.NEXT_PUBLIC_VAPID_PUBLIC_KEY });
    expect(error?.message).toContain("missing: VAPID_PRIVATE_KEY, VAPID_SUBJECT.");
  });

  it("counts a blank value as unset, like pushConfig()", async () => {
    const error = await loadError({ ...VAPID, VAPID_SUBJECT: "  \n" });
    expect(error?.message).toContain("missing: VAPID_SUBJECT.");
  });

  it("never prints a value in the message", async () => {
    for (const missing of VAPID_VARS) {
      const error = await loadError({ ...VAPID, [missing]: "" });
      expect(error?.message).not.toMatch(/VALUE|secret-subject/);
    }
  });
});
