import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pushConfig, vapidConfigProblem } from "@/lib/push/config";

// Spec 010 criterion 1: push is env-guarded like Sentry — all three VAPID variables, or nothing.
// Placeholder values: the guard checks presence only (web-push validates the key format when it signs).
const VARS = ["NEXT_PUBLIC_VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"] as const;

describe("pushConfig (spec 010, criterion 1)", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "public-key");
    vi.stubEnv("VAPID_PRIVATE_KEY", "private-key");
    vi.stubEnv("VAPID_SUBJECT", "mailto:owner@example.com");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the VAPID details when all three variables are set", () => {
    expect(pushConfig()).toEqual({
      publicKey: "public-key",
      privateKey: "private-key",
      subject: "mailto:owner@example.com",
    });
  });

  it("trims each value (a pasted key often carries a trailing newline)", () => {
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "  public-key\n");
    vi.stubEnv("VAPID_PRIVATE_KEY", "\tprivate-key ");
    vi.stubEnv("VAPID_SUBJECT", " https://homeshare.example.com\r\n");
    expect(pushConfig()).toEqual({
      publicKey: "public-key",
      privateKey: "private-key",
      subject: "https://homeshare.example.com",
    });
  });

  it.each(VARS)("is null when %s is unset (a partial config turns push off)", (name) => {
    vi.stubEnv(name, undefined);
    expect(pushConfig()).toBeNull();
  });

  it.each(VARS)("is null when %s is empty or only whitespace", (name) => {
    vi.stubEnv(name, "");
    expect(pushConfig()).toBeNull();
    vi.stubEnv(name, " \n\t ");
    expect(pushConfig()).toBeNull();
  });

  it("is null when none of the variables is set", () => {
    for (const name of VARS) vi.stubEnv(name, undefined);
    expect(pushConfig()).toBeNull();
  });

  it("reads the environment on every call, not once at import", () => {
    expect(pushConfig()).not.toBeNull();
    vi.stubEnv("VAPID_PRIVATE_KEY", undefined);
    expect(pushConfig()).toBeNull();
    vi.stubEnv("VAPID_PRIVATE_KEY", "rotated-key");
    expect(pushConfig()?.privateKey).toBe("rotated-key");
  });
});

// Cycle G review, M1: a partial set (e.g. only the public key) showed the push switch and registered the worker while
// the server answered 503 to every subscription. next.config.ts now fails the build / dev server on it; the rule is here.
describe("vapidConfigProblem — all three VAPID variables or none (cycle G review, M1)", () => {
  const ALL = {
    NEXT_PUBLIC_VAPID_PUBLIC_KEY: "public-VALUE-1",
    VAPID_PRIVATE_KEY: "private-VALUE-2",
    VAPID_SUBJECT: "mailto:value-3@example.com",
  };

  it("is null with all three set (push on)", () => {
    expect(vapidConfigProblem(ALL)).toBeNull();
  });

  it("is null with none set — unset, empty or blank (push off)", () => {
    expect(vapidConfigProblem({})).toBeNull();
    expect(vapidConfigProblem({ NEXT_PUBLIC_VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: " ", VAPID_SUBJECT: "\n\t" })).toBeNull();
  });

  it.each(VARS)("names %s when only it is missing (unset, empty or blank)", (name) => {
    expect(vapidConfigProblem({ ...ALL, [name]: undefined })).toEqual([name]);
    expect(vapidConfigProblem({ ...ALL, [name]: "" })).toEqual([name]);
    expect(vapidConfigProblem({ ...ALL, [name]: "  \r\n" })).toEqual([name]);
  });

  it.each(VARS)("names the other two when only %s is set", (name) => {
    expect(vapidConfigProblem({ [name]: ALL[name] })).toEqual(VARS.filter((other) => other !== name));
  });

  it("answers names only, in a fixed order — never a value", () => {
    const problem = vapidConfigProblem({ VAPID_SUBJECT: ALL.VAPID_SUBJECT });
    expect(problem).toEqual(["NEXT_PUBLIC_VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"]);
    expect(JSON.stringify(problem)).not.toMatch(/VALUE|value-3/);
  });

  it("ignores every other variable", () => {
    expect(vapidConfigProblem({ SENTRY_DSN: "https://k@o1.ingest.sentry.io/2", VAPID_KEY: "typo" })).toBeNull();
  });
});
