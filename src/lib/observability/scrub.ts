import type { Event } from "@sentry/nextjs";
import { isPushServiceHost, PUSH_SERVICE_HOSTS } from "@/lib/push/hosts";

/** Replacement for any value that must never leave the app (spec 007, LGPD). */
export const FILTERED = "[Filtered]";

/** The only request headers that may reach Sentry — never cookies, auth or client IPs. */
export const ALLOWED_REQUEST_HEADERS: string[] = ["user-agent", "content-type", "content-length", "accept-language"];
/** The only response headers that may reach Sentry. */
export const ALLOWED_RESPONSE_HEADERS: string[] = ["content-type", "content-length"];

// Keys whose VALUE is always secret or personal, wherever they appear (compared lowercased, without - and _).
const SENSITIVE_KEYS = new Set([
  "cookie", "cookies", "setcookie", "authorization", "proxyauthorization",
  "password", "newpassword", "currentpassword", "token", "accesstoken", "refreshtoken", "idtoken",
  "secret", "clientsecret", "jwt", "joincode", "email", "homesharesession", "homesharegroup",
]);
const MAX_DEPTH = 12;
// SDK-internal (never serialized) and may hold live scope objects — mutating it would corrupt the SDK.
const SKIPPED_EVENT_KEYS = new Set(["sdkProcessingMetadata"]);
const REQUEST_FIELDS_TO_DROP = ["cookies", "data", "env", "query_string"];

// JSON.parse errors echo the start of the body: Unexpected token 'o', "not json a"... is not valid JSON
const JSON_PARSE_SNIPPET = /"[\s\S]*"(?:\.\.\.)? is not valid JSON/g;
const SESSION_COOKIE_VALUE = /\b(homeshare_session|homeshare_group)=[^;\s,"']+/gi;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
// Bounded parts (RFC 5321: local part ≤ 64, domain ≤ 255): an unbounded `+` rescanned a long run of letters from
// every start position — quadratic (16 KB took ~240 ms per string, on unauthenticated URLs).
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/g;
// The browser SDK describes a clicked/measured element as `button[aria-label="Actions for Ana"]` (aria-label,
// type, name, title, alt) in ui.* breadcrumbs and Web Vitals span attributes, and the app puts people's
// names there (avatars, split inputs, tag names). Every `[attr="…"]` value goes, including one cut short by
// the SDK's length limit (no closing `"]`). HTML-style `title="…"` / `alt='…'` text goes too.
const SELECTOR_ATTRIBUTE = /\[([\w:.-]+)="[\s\S]*?(?:"\]|$)/g;
const HTML_TEXT_ATTRIBUTE = /\b(aria-label|aria-labelledby|aria-description|aria-valuetext|title|alt|placeholder)\s*=\s*(?:"[^"]*"|'[^']*')/gi;
// A push subscription endpoint is a capability URL: the device token is its path (FCM, Mozilla, Apple) or its query
// (WNS), and the SDK records web-push's POST to it (http breadcrumb, client span name, url.full). Only the push
// service's origin may leave (spec 010, criterion 13). Groups: scheme + "//", authority, the rest (path, query, fragment).
const URL_WITH_AUTHORITY = /(https?:\/\/)([^\s/?#"'`<>]+)([^\s"'`<>]*)/gi;
// Span attributes naming the peer of an outgoing request, and the ones holding its host-less path (+ query).
const PEER_HOST_KEY = /^(server\.address|url\.domain|net\.peer\.name|http\.host)$/i;
const PEER_PATH_KEY = /^(url\.path|http\.target)$/i;

// Span attributes and breadcrumb data keys that hold a URL or path, possibly with a query string: `url`,
// `url.full`, `http.url`, and Next's `http.target` (the raw req.url — OAuth `code`, set-password `token`)
// and `next.span_name`.
// `sentry.segment.name` is Next's root span name, started as `${method} ${req.url}` before the route resolves.
const URL_KEY = /^url\.full$|(^|\.)(url|uri|target)$|(^|\.)(span_name|segment\.name)$/i;
// The query/fragment halves the SDK also writes on their own (spans and breadcrumbs).
const QUERY_PART_KEY = /^(url|http)\.(query|fragment)$/i;
// Client IPs are personal data (LGPD), as are the peer address of the socket and the user fields.
const DROPPED_SPAN_ATTRIBUTE = new RegExp(
  `cookie|authorization|${QUERY_PART_KEY.source}|^user\\.(email|ip_address|name|username)$|` +
    "^(client\\.(socket\\.)?address|network\\.peer\\.address|net\\.(sock\\.)?peer\\.(ip|addr)|http\\.client_ip)$",
  "i"
);
// `http.request.header.x_forwarded_for` — only the allowlisted headers survive (OTel writes `_` for `-`).
const HEADER_SPAN_ATTRIBUTE = /^http\.(request|response)\.header\.(.+)$/i;

/** The bare host name of a URL authority or a Host value: no credentials, no port, no trailing dot. */
function hostName(authority: string): string {
  return authority.replace(/^.*@/, "").replace(/:\d*$/, "").replace(/\.$/, "");
}

/**
 * A push URL keeps its origin; any other URL is kept, but its rest is scanned again (a push URL can sit in its
 * query). Iterative: resuming right after a non-push URL's authority replaces the old recursion, which overflowed
 * the stack on a long chain of nested URLs (a 27 KB string of `http://a/`).
 */
function cutPushUrls(text: string): string {
  const pattern = new RegExp(URL_WITH_AUTHORITY.source, "gi");
  let out = "";
  let last = 0;
  let found: RegExpExecArray | null;
  while ((found = pattern.exec(text)) !== null) {
    const [match, scheme, authority, rest] = found;
    if (isPushServiceHost(hostName(authority))) {
      out += text.slice(last, found.index) + (rest === "" || rest === "/" ? match : `${scheme}${authority}/${FILTERED}`);
      last = found.index + match.length;
    } else {
      const resume = found.index + scheme.length + authority.length;
      out += text.slice(last, resume);
      last = resume;
      pattern.lastIndex = resume;
    }
  }
  return out + text.slice(last);
}

// A push host followed by a path with no scheme in front (an attribute holding host + path): no SDK path produces
// it today, but the token would leave. Not after "/", "." or a word character, so an already cut URL stays as is.
// Built from PUSH_SERVICE_HOSTS (regex-escaped), so the endpoint validator and both scrubbers share one host list.
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PUSH_HOST_PATH_NO_SCHEME = new RegExp(
  `(?<![\\w./@-])((?:[a-z0-9-]+\\.)*(?:${PUSH_SERVICE_HOSTS.map(escapeRegExp).join("|")}))\\.?(\\/[^\\s"'\`<>]+)`,
  "gi"
);

/**
 * Redacts push-service URLs down to their origin, DOM attribute values (selector pairs and title/alt/aria-label
 * text), e-mails, session/group cookie values, bearer tokens, JWTs and JSON-parse body snippets.
 */
export function redactText(text: string): string {
  return cutPushUrls(text)
    .replace(PUSH_HOST_PATH_NO_SCHEME, (match: string, host: string, path: string) =>
      path === "/" ? match : `${host}/${FILTERED}`
    )
    .replace(JSON_PARSE_SNIPPET, `"${FILTERED}" is not valid JSON`)
    .replace(SELECTOR_ATTRIBUTE, `[$1="${FILTERED}"]`)
    .replace(HTML_TEXT_ATTRIBUTE, `$1="${FILTERED}"`)
    .replace(SESSION_COOKIE_VALUE, `$1=${FILTERED}`)
    .replace(BEARER_TOKEN, `Bearer ${FILTERED}`)
    .replace(JWT, "[jwt]")
    .replace(EMAIL, "[email]");
}

/** Drops the query string and the fragment of a URL or path. */
export function stripQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase().replace(/[-_]/g, ""));
}

function walk(value: unknown, depth: number): unknown {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object" || depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = walk(value[i], depth + 1);
    return value;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    record[key] = isSensitiveKey(key) ? FILTERED : walk(record[key], depth + 1);
  }
  return record;
}

function allowlisted(headers: Record<string, string>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (ALLOWED_REQUEST_HEADERS.includes(name.toLowerCase())) kept[name] = value;
  }
  return kept;
}

function isDroppedHeaderAttribute(key: string): boolean {
  const match = HEADER_SPAN_ATTRIBUTE.exec(key);
  if (!match) return false;
  const allowed = match[1].toLowerCase() === "request" ? ALLOWED_REQUEST_HEADERS : ALLOWED_RESPONSE_HEADERS;
  return !allowed.includes(match[2].toLowerCase().replace(/_/g, "-"));
}

function lastLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).filter(Boolean).pop() ?? "";
}

/**
 * beforeSend hook (spec 007): strips everything personal or secret from an error event. No I/O, no
 * SDK import (types only), idempotent. It mutates and returns the event it is given — Sentry's
 * documented beforeSend pattern: cloning would copy SDK-internal objects, and a throwing hook drops
 * the event.
 */
export function scrubEvent<T extends Event>(event: T): T {
  const request = event.request as unknown as (Record<string, unknown> & { url?: string; headers?: Record<string, string> }) | undefined;
  if (request) {
    for (const field of REQUEST_FIELDS_TO_DROP) delete request[field];
    if (typeof request.url === "string") request.url = stripQuery(request.url);
    if (request.headers) request.headers = allowlisted(request.headers);
  }
  if (event.user) {
    const id = event.user.id;
    if (id === undefined || id === null || id === "") delete event.user;
    else event.user = { id };
  }
  if (event.transaction) event.transaction = stripQuery(redactText(event.transaction));
  // Uncaught errors: Next's captureRequestError stores the raw req.url (query included) here.
  const nextjs = event.contexts?.nextjs;
  if (nextjs && typeof nextjs.request_path === "string") nextjs.request_path = stripQuery(nextjs.request_path);
  // console.* text is unscrubbed free text (Prisma invocation dumps with names and amounts, third-party
  // logs); the JSON logger already leaves a redacted `log` breadcrumb with the same content.
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.filter((crumb) => crumb.category !== "console");
  // ui.* breadcrumb messages (DOM selectors) are redacted by the walk() below, like every other string.
  for (const crumb of event.breadcrumbs ?? []) {
    const data = crumb.data;
    if (!data) continue;
    for (const key of Object.keys(data)) {
      if (QUERY_PART_KEY.test(key)) delete data[key];
      else if (typeof data[key] === "string" && (key === "from" || key === "to" || URL_KEY.test(key))) data[key] = stripQuery(data[key]);
    }
  }
  // Prisma's "Invalid `prisma.x.y()` invocation" message prints the query arguments (names, amounts);
  // keep only the final reason line — the stack trace already shows the call site.
  for (const exception of event.exception?.values ?? []) {
    if (exception.type?.startsWith("PrismaClient") && exception.value) exception.value = lastLine(exception.value);
  }
  const record = event as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!SKIPPED_EVENT_KEYS.has(key)) record[key] = walk(record[key], 1);
  }
  return event;
}

// Redact first, then cut the query: a name containing # or ? must not leave a half-cut selector behind.
function scrubSpanText(key: string, text: string): string {
  const redacted = redactText(text);
  return URL_KEY.test(key) ? stripQuery(redacted) : redacted;
}

// The client span of a request to a push service: its url.path / http.target is the device token, with no host to
// recognize it by (spec 010, criterion 13).
function isPushPeer(attributes: Record<string, unknown>): boolean {
  return Object.keys(attributes).some((key) => {
    const value = attributes[key];
    return PEER_HOST_KEY.test(key) && typeof value === "string" && isPushServiceHost(hostName(value));
  });
}

/**
 * beforeSendSpan hook (spec 007): no query strings, no identifying attributes, no push-service paths (spec 010).
 * Mutates and returns the span.
 */
export function scrubSpan<T extends object>(span: T): T {
  const target = span as unknown as { name?: unknown; attributes?: Record<string, unknown> };
  if (typeof target.name === "string") target.name = stripQuery(redactText(target.name));
  const attributes = target.attributes;
  if (!attributes) return span;
  const pushPeer = isPushPeer(attributes);
  for (const key of Object.keys(attributes)) {
    const value = attributes[key];
    if (DROPPED_SPAN_ATTRIBUTE.test(key) || isDroppedHeaderAttribute(key)) delete attributes[key];
    else if (pushPeer && PEER_PATH_KEY.test(key)) attributes[key] = `/${FILTERED}`;
    else if (typeof value === "string") attributes[key] = scrubSpanText(key, value);
    else if (Array.isArray(value)) {
      attributes[key] = value.map((item) => (typeof item === "string" ? scrubSpanText(key, item) : item));
    }
  }
  return span;
}
