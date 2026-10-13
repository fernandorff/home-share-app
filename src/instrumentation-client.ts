import * as Sentry from "@sentry/nextjs";
import { initSentry } from "@/lib/observability/init";

// Browser SDK init (spec 007). NEXT_PUBLIC_* values are inlined at build time; without
// NEXT_PUBLIC_SENTRY_DSN nothing is initialized and nothing is sent.
initSentry({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,
  tracesSampleRate: process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE,
});

// Navigation spans for App Router transitions.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
