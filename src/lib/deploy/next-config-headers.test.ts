import { afterEach, describe, it, expect, vi } from "vitest";
import nextConfig from "../../../next.config";

// Dev-environment plan, decision 9 — the real next.config.ts wiring, not just the helper.
async function rootHeaders() {
  const rules = (await nextConfig.headers?.()) ?? [];
  const rule = rules.find((entry) => entry.source === "/(.*)");
  return Object.fromEntries((rule?.headers ?? []).map(({ key, value }) => [key, value]));
}

describe("next.config.ts headers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(["preview", "development"])("answers X-Robots-Tag: noindex, nofollow on every route in %s", async (env) => {
    vi.stubEnv("VERCEL_ENV", env);
    expect((await rootHeaders())["X-Robots-Tag"]).toBe("noindex, nofollow");
  });

  it("omits X-Robots-Tag in production and keeps the security headers", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const headers = await rootHeaders();
    expect(headers["X-Robots-Tag"]).toBeUndefined();
    expect(headers).toMatchObject({ "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff" });
  });
});
