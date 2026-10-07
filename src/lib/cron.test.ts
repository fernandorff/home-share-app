import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: mockWarn, error: vi.fn() } }));

import { requireCron } from "./cron";

const SECRET = "0123456789abcdef0123456789abcdef";
const request = (authorization?: string) =>
  new Request("http://localhost/api/cron/recurring-expenses", {
    headers: authorization === undefined ? {} : { authorization },
  });

async function expectUnauthorized(check: ReturnType<typeof requireCron>) {
  expect(check.ok).toBe(false);
  if (check.ok) return;
  expect(check.response.status).toBe(401);
  expect(await check.response.json()).toEqual({ error: "Unauthorized", code: "CRON_UNAUTHORIZED" });
}

beforeEach(() => {
  mockWarn.mockClear();
  vi.stubEnv("CRON_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("requireCron (spec 008 — criterion 19, ADR 0010)", () => {
  it("accepts the exact 'Bearer <CRON_SECRET>' header", () => {
    expect(requireCron(request(`Bearer ${SECRET}`))).toEqual({ ok: true });
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("rejects a request with no Authorization header", async () => {
    await expectUnauthorized(requireCron(request()));
  });

  it("rejects the wrong scheme, even with the right secret", async () => {
    await expectUnauthorized(requireCron(request(`Basic ${SECRET}`)));
    await expectUnauthorized(requireCron(request(`bearer ${SECRET}`)));
    await expectUnauthorized(requireCron(request(SECRET)));
  });

  it("rejects a wrong value of the same length", async () => {
    const wrong = `${SECRET.slice(0, -1)}0`;
    expect(wrong).toHaveLength(SECRET.length);
    await expectUnauthorized(requireCron(request(`Bearer ${wrong}`)));
  });

  it("rejects values of a different length without throwing (shorter, longer, empty)", async () => {
    await expectUnauthorized(requireCron(request(`Bearer ${SECRET.slice(0, -1)}`)));
    await expectUnauthorized(requireCron(request(`Bearer ${SECRET}0`)));
    await expectUnauthorized(requireCron(request("Bearer ")));
    await expectUnauthorized(requireCron(request("")));
  });

  it("fails closed when CRON_SECRET is unset: 401 plus exactly one warning, even for 'Bearer undefined'", async () => {
    vi.stubEnv("CRON_SECRET", undefined);
    expect(process.env.CRON_SECRET).toBeUndefined();
    await expectUnauthorized(requireCron(request("Bearer undefined")));
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });

  it("treats an empty CRON_SECRET as unset (a bare 'Bearer ' header must not pass)", async () => {
    vi.stubEnv("CRON_SECRET", "");
    await expectUnauthorized(requireCron(request("Bearer ")));
    await expectUnauthorized(requireCron(request()));
    expect(mockWarn).toHaveBeenCalledTimes(2);
  });

  it("never logs the secret or the presented header", () => {
    vi.stubEnv("CRON_SECRET", undefined);
    requireCron(request("Bearer attacker-guess"));
    expect(JSON.stringify(mockWarn.mock.calls)).not.toContain("attacker-guess");
    expect(JSON.stringify(mockWarn.mock.calls)).not.toContain(SECRET);
  });

  it("with the secret set and a near-miss bearer, neither the logs nor the 401 body contain the secret", async () => {
    const check = requireCron(request(`Bearer ${SECRET}x`));
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.response.status).toBe(401);
    expect(await check.response.text()).not.toContain(SECRET);
    expect(JSON.stringify(mockWarn.mock.calls)).not.toContain(SECRET);
  });
});
