import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { withSentryConfig } from "@sentry/nextjs/config";
import { vapidConfigProblem } from "./src/lib/push/config";
import { robotsHeaders } from "./src/lib/deploy/robots";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

// Web Push (spec 010, ADR 0011): all three VAPID variables or none. With only some of them the push switch would show
// and the worker would register while the server refuses every subscription (503) — so the build, and `next dev`,
// stop here instead. The message names the missing variables only, never a value.
const missingVapid = vapidConfigProblem(process.env);
if (missingVapid) {
  throw new Error(
    `Web Push is partly configured — missing: ${missingVapid.join(", ")}. ` +
      "Set all three VAPID variables (NEXT_PUBLIC_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT), or none to keep push off."
  );
}

// CSP only in production: Turbopack's dev HMR needs 'unsafe-eval' + a ws:// connection that
// would otherwise have to be special-cased here for no real security benefit in local dev.
const CSP_PROD = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const nextConfig: NextConfig = {
  turbopack: {},
  // The floating dev badge overlaps the fixed bottom nav / modal footer in dev; it never ships
  // to production. Hide it so dev matches prod.
  devIndicators: false,
  // Drops the "X-Powered-By: Next.js" header (minor info-disclosure — no functional purpose).
  poweredByHeader: false,
  // The app's page routes were renamed from Portuguese to English; old bookmarks/deep links
  // still land in the right place.
  async redirects() {
    const renames: Array<[string, string]> = [
      ["despesas", "expenses"],
      ["saldos", "balances"],
      ["compras", "shopping"],
      ["catalogos", "catalogs"],
      ["atividade", "activity"],
      ["casa", "house"],
      ["conta", "account"],
    ];
    return renames.map(([from, to]) => ({
      source: `/${from}`,
      destination: `/${to}`,
      permanent: true,
    }));
  },
  async headers() {
    const securityHeaders = [
      { key: "X-Frame-Options", value: "DENY" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ...(process.env.NODE_ENV === "production"
        ? [
            { key: "Content-Security-Policy", value: CSP_PROD },
            // Force HTTPS for 2 years incl. subdomains — the app is HTTPS-only in prod and Vercel
            // doesn't add this automatically (found in a security audit). Dev stays plain HTTP.
            { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          ]
        : []),
    ];
    // noindex on staging (Vercel Preview) and local dev; production stays indexable — see src/lib/deploy/robots.ts.
    return [{ source: "/(.*)", headers: [...securityHeaders, ...robotsHeaders(process.env.VERCEL_ENV)] }];
  },
};

const config = withNextIntl(nextConfig);

// Observability (spec 007, ADR 0008): Sentry wraps the build ONLY when a DSN is configured, so a
// build without Sentry env vars is exactly the config above. Source maps are uploaded only when
// SENTRY_AUTH_TOKEN exists (the build never requires it). Browser envelopes go through the
// same-origin tunnel /monitoring, so the CSP keeps connect-src 'self' and ad-blockers can't drop them.
const sentryDsn = (process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN || "").trim();

export default sentryDsn
  ? withSentryConfig(config, {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
      tunnelRoute: "/monitoring",
      telemetry: false,
      silent: !process.env.CI,
    })
  : config;
