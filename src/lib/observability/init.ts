import * as Sentry from "@sentry/nextjs";
import { buildSentryOptions, type SentryEnv } from "@/lib/observability/options";

/** Initializes the SDK for the calling runtime; returns false — and does nothing — without a DSN. */
export function initSentry(env: SentryEnv): boolean {
  const options = buildSentryOptions(env);
  if (!options) return false;
  Sentry.init(options);
  return true;
}
