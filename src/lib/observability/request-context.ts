// Request-scoped observability context (spec 007). The middleware stamps these headers on every
// request it lets through (always overwriting client values); handleApiError reads them for the log
// line and the Sentry tags. Edge-safe: no Next imports.

export const REQUEST_ID_HEADER = "x-homeshare-request-id";
export const REQUEST_PATH_HEADER = "x-homeshare-path";
export const REQUEST_START_HEADER = "x-homeshare-start";

export interface RequestContext {
  requestId?: string;
  route?: string;
  durationMs?: number;
}

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_SEGMENT = /^\d+$/;
const SAFE_REQUEST_ID = /^[\w.:-]{1,128}$/;

/** Low-cardinality route for dashboards: UUID and numeric path segments become ":id". */
export function normalizeRoute(pathname: string): string {
  const route = pathname
    .split("/")
    .map((segment) => (UUID_SEGMENT.test(segment) || NUMERIC_SEGMENT.test(segment) ? ":id" : segment))
    .join("/");
  return route || "/";
}

/** Copy of the request headers with fresh id/path/start values (Vercel's request id when present). */
export function stampRequestContext(
  source: Headers,
  pathname: string,
  now: number = Date.now(),
  requestId: string = source.get("x-vercel-id") ?? crypto.randomUUID()
): Headers {
  const headers = new Headers(source);
  headers.set(REQUEST_ID_HEADER, requestId);
  headers.set(REQUEST_PATH_HEADER, pathname);
  headers.set(REQUEST_START_HEADER, String(now));
  return headers;
}

/** Reads and validates the stamped values; anything missing or malformed is left out. */
export function readRequestContext(headers: Pick<Headers, "get">, now: number = Date.now()): RequestContext {
  const context: RequestContext = {};
  const requestId = headers.get(REQUEST_ID_HEADER);
  if (requestId && SAFE_REQUEST_ID.test(requestId)) context.requestId = requestId;
  const path = headers.get(REQUEST_PATH_HEADER);
  if (path && path.startsWith("/")) context.route = normalizeRoute(path);
  const start = Number(headers.get(REQUEST_START_HEADER));
  if (Number.isFinite(start) && start > 0 && now >= start) context.durationMs = now - start;
  return context;
}
