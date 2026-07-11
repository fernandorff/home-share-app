import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

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
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default withNextIntl(nextConfig);
