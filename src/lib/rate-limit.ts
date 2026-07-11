// Best-effort in-memory sliding-window rate limiter. Scoped to a single warm
// serverless instance (not shared across instances) — enough to blunt brute-force
// and enumeration on the auth endpoints without adding external infra.

const hits = new Map<string, number[]>();

/** Returns true if the action is allowed, false if the key exceeded `max` within `windowMs`. */
export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(key, recent);
  // Opportunistic cleanup so the map doesn't grow unbounded across many keys.
  if (hits.size > 5000) {
    for (const [k, v] of hits) {
      if (v.every((t) => now - t >= windowMs)) hits.delete(k);
    }
  }
  return recent.length <= max;
}

/**
 * Best-effort client IP for per-IP rate-limit buckets.
 *
 * MUST NOT trust the leftmost `x-forwarded-for` value: that position is client-controllable, so
 * rotating it defeats the login/register brute-force throttle entirely (found in a security audit).
 * On Vercel, `x-real-ip` is set by the platform from the real connection and can't be spoofed by a
 * request header, so prefer it. If only XFF is present we take the RIGHTMOST hop (the one appended
 * by the nearest trusted proxy), never the leftmost.
 */
export function clientIp(request: Request): string {
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) {
    const parts = fwd.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return "unknown";
}
