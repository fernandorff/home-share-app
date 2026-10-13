// Web Push env guard (spec 010, ADR 0011): like Sentry, push exists only when it is configured. Without all
// three VAPID variables the service worker is not registered, the push card is hidden, the routes answer 503
// and nothing is sent. VAPID_PRIVATE_KEY is server-only (never NEXT_PUBLIC_).

/** The VAPID details web-push signs with (the shape of its `vapidDetails` option). */
export interface PushConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/** Trimmed VAPID settings, or null unless all three are set — read on every call, never cached. */
export function pushConfig(): PushConfig | null {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.VAPID_SUBJECT?.trim();
  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject };
}

/** The three VAPID variables, in the order a configuration problem names them. */
export const VAPID_VARIABLES = ["NEXT_PUBLIC_VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"] as const;

/**
 * All three VAPID variables or none (cycle G review, M1). With only some of them the public key is inlined into the
 * client, so the push switch shows and the worker registers, while pushConfig() is null and the server answers 503 to
 * every subscription. Returns the names of the missing variables when one or two are set (non-empty after trim, as in
 * pushConfig), else null. Names only, never a value. next.config.ts calls it with process.env and stops the build (and
 * `next dev`) on a problem.
 */
export function vapidConfigProblem(env: Readonly<Record<string, string | undefined>>): string[] | null {
  const missing = VAPID_VARIABLES.filter((name) => !env[name]?.trim());
  return missing.length === 0 || missing.length === VAPID_VARIABLES.length ? null : missing;
}
