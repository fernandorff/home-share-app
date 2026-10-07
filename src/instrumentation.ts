import * as Sentry from "@sentry/nextjs";
import { initSentry } from "@/lib/observability/init";

// Server + edge SDK init (spec 007). Without SENTRY_DSN, initSentry is a no-op and nothing is sent.
export function register(): void {
  initSentry({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    tracesSampleRate: process.env.SENTRY_TRACES_SAMPLE_RATE,
  });
}

// Uncaught errors from server components, route handlers and middleware. Route handlers that catch
// through handleApiError report there instead (exactly once).
export const onRequestError = Sentry.captureRequestError;
