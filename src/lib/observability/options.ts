import type { init } from "@sentry/nextjs";
import { ALLOWED_REQUEST_HEADERS, ALLOWED_RESPONSE_HEADERS, scrubEvent, scrubSpan } from "@/lib/observability/scrub";

/** What Sentry.init accepts in whichever runtime (browser, Node, edge) imports this module. */
export type SentryInitOptions = NonNullable<Parameters<typeof init>[0]>;

type TracesSampler = NonNullable<SentryInitOptions["tracesSampler"]>;

/** Raw env values — each runtime passes its own (NEXT_PUBLIC_* literals in the browser). */
export interface SentryEnv {
  dsn: string | undefined;
  environment: string | undefined;
  tracesSampleRate: string | undefined;
}

const PRODUCTION_TRACES_SAMPLE_RATE = 0.1;
const DEFAULT_TRACES_SAMPLE_RATE = 1.0;

/** The env value when it is a number in [0, 1]; otherwise 0.1 in production and 1.0 anywhere else. */
export function resolveTracesSampleRate(raw: string | undefined, environment: string): number {
  if (raw !== undefined && raw.trim() !== "") {
    const rate = Number(raw);
    if (Number.isFinite(rate) && rate >= 0 && rate <= 1) return rate;
  }
  return environment === "production" ? PRODUCTION_TRACES_SAMPLE_RATE : DEFAULT_TRACES_SAMPLE_RATE;
}

/** Span-attribute keys that carry the request path/URL (stable and legacy OpenTelemetry names). */
const REQUEST_PATH_ATTRIBUTES = ["url.path", "url.full", "http.target", "http.url"] as const;

/** True when a span name ("GET /api/health"), path or URL (query/hash allowed) is exactly /api/health. */
function isHealthPath(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const path = value
    .trim()
    .replace(/^[A-Z]+\s+/, "")
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "")
    .split(/[?#]/)[0];
  return path === "/api/health" || path === "/api/health/";
}

/**
 * Drops the WHOLE trace of the keep-warm /api/health pings at sampling time — ignoreSpans only removes
 * the root span, its children (prisma, pg-pool, …) would still be sent. Everything else keeps today's
 * behaviour: an inherited parent decision wins, otherwise the configured rate.
 */
export function createTracesSampler(rate: number): TracesSampler {
  return (context) => {
    const { name, attributes, normalizedRequest } = context;
    const isHealth =
      isHealthPath(name) ||
      isHealthPath(normalizedRequest?.url) ||
      REQUEST_PATH_ATTRIBUTES.some((key) => isHealthPath(attributes?.[key]));
    return isHealth ? 0 : context.inheritOrSampleWith(rate);
  };
}

/**
 * Options for every runtime, or null when no DSN is configured (the SDK must then stay off — R1).
 * SDK v11 removed sendDefaultPii and made dataCollection PERMISSIVE by default (cookies, bodies, DB
 * query data, user info), so every category is set explicitly here (spec 007, LGPD).
 */
export function buildSentryOptions(env: SentryEnv): SentryInitOptions | null {
  const dsn = env.dsn?.trim();
  if (!dsn) return null;
  const environment = env.environment?.trim() || "development";
  const tracesSampleRate = resolveTracesSampleRate(env.tracesSampleRate, environment);
  return {
    dsn,
    environment,
    tracesSampleRate,
    tracesSampler: createTracesSampler(tracesSampleRate),
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: {
        request: { allow: ALLOWED_REQUEST_HEADERS },
        response: { allow: ALLOWED_RESPONSE_HEADERS },
      },
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      graphQL: { document: false, variables: false },
      stackFrameVariables: false,
    },
    // The keep-warm cron (BL-15) pings /api/health every few minutes — pure noise in traces. The sampler
    // above drops the whole trace; this is the safety net for any span that still slips through.
    ignoreSpans: [/\/api\/health/],
    beforeSend: scrubEvent,
    beforeSendSpan: scrubSpan,
  };
}
