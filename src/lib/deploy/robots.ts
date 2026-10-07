// Search engines (dev-environment plan, decision 9): only production is indexable. Staging is a Vercel Preview on a
// custom domain (dev.homeshare.fernandorffdev.com), where Vercel omits its own automatic noindex, so next.config.ts
// adds the header to every route whenever VERCEL_ENV is not "production" (local dev included).

/** The X-Robots-Tag header for every route outside Vercel Production, or none in production. */
export function robotsHeaders(vercelEnv: string | undefined): Array<{ key: string; value: string }> {
  return vercelEnv === "production" ? [] : [{ key: "X-Robots-Tag", value: "noindex, nofollow" }];
}
