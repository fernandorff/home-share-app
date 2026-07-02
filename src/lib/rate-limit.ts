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

/** Best-effort client IP from proxy headers (Vercel sets x-forwarded-for). */
export function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}
