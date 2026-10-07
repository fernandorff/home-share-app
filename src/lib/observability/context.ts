import * as Sentry from "@sentry/nextjs";

// What Sentry may know about who/where (spec 007, LGPD): opaque publicIds only — never names,
// e-mails or amounts. Without an initialized SDK every call is a no-op.

export interface ServerErrorContext {
  route?: string;
  status: number;
  code?: string;
  requestId?: string;
}

/** The signed-in member as Sentry's user — their publicId (UUID) and nothing else. */
export function setObservedUser(publicId: string | null): void {
  Sentry.setUser(publicId ? { id: publicId } : null);
}

/** Tags events with the active house's publicId (never its name). */
export function setObservedHouse(publicId: string | null): void {
  Sentry.setTag("house", publicId ?? undefined);
}

/** Reports a server failure once, tagged for the dashboard; returns the event id when the SDK is on. */
export function captureServerError(error: unknown, context: ServerErrorContext): string | undefined {
  if (!Sentry.getClient()) return undefined;
  const tags: Record<string, string> = { http_status: String(context.status) };
  if (context.route) tags.route = context.route;
  if (context.code) tags.api_error_code = context.code;
  if (context.requestId) tags.request_id = context.requestId;
  return Sentry.captureException(error, { tags });
}
