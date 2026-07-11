import { describe, it, expect } from "vitest";
import { rateLimit, clientIp } from "./rate-limit";

const req = (headers: Record<string, string>) => new Request("http://x", { headers });

describe("clientIp — spoof-resistant per-IP key (security)", () => {
  it("prefers x-real-ip (Vercel sets it from the real connection, unspoofable)", () => {
    // Even with a forged XFF, the real-ip wins — so rotating XFF can't move the bucket.
    expect(clientIp(req({ "x-real-ip": "9.9.9.9", "x-forwarded-for": "1.2.3.4" }))).toBe("9.9.9.9");
  });

  it("never trusts the leftmost (client-controlled) x-forwarded-for value", () => {
    // Leftmost is attacker-controlled; the rightmost is the hop appended by the trusted proxy.
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.1, 70.70.70.70" }))).toBe("70.70.70.70");
  });

  it("a rotating leftmost XFF maps to the SAME key when the trusted rightmost is constant", () => {
    const a = clientIp(req({ "x-forwarded-for": "10.0.0.1, 70.70.70.70" }));
    const b = clientIp(req({ "x-forwarded-for": "10.0.0.2, 70.70.70.70" }));
    expect(a).toBe(b); // the bypass: this used to differ, giving each spoof its own bucket
  });

  it("falls back to 'unknown' when no proxy headers are present", () => {
    expect(clientIp(req({}))).toBe("unknown");
  });
});

describe("rateLimit — sliding window", () => {
  it("allows up to max then blocks within the window", () => {
    const key = `t-${Math.random()}`;
    for (let i = 0; i < 3; i++) expect(rateLimit(key, 3, 60_000)).toBe(true);
    expect(rateLimit(key, 3, 60_000)).toBe(false);
  });
});
