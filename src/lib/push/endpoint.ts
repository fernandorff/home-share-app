import { LOCALES, type Locale } from "@/i18n/locales";
import { isPushServiceHost } from "@/lib/push/hosts";

// Push subscription validation (spec 010, criterion 4). The server POSTs every push to the subscription's
// endpoint, so an open list would be SSRF: only the browsers' push services get through (src/lib/push/hosts.ts —
// the one list, shared with the Sentry scrubber), as the host itself or a ".host" subdomain of it. Its host
// charset rule matters here: the WHATWG parser keeps ; ' " ` { } inside a domain (and its href stays canonical),
// but Node's legacy url.parse — the one web-push sends with — ends the host at them:
// https://127.0.0.1;.push.apple.com/x passes a suffix check yet is sent to 127.0.0.1. Empty labels fail too.
const MAX_ENDPOINT_LENGTH = 1024;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const P256DH_BYTES = 65; // uncompressed P-256 public key
const P256DH_CHARS = 87; // the only base64url length (no padding) that decodes to 65 bytes
const AUTH_BYTES = 16;
const AUTH_CHARS = 22;

/** A validated subscription, shaped like its PushSubscription row (the owner comes from the session). */
export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  /**
   * Absent when the client cannot know it (the service worker's pushsubscriptionchange re-registration):
   * a new row then gets the schema default and an existing row keeps its locale.
   */
  locale?: Locale;
}

/** True for an https URL on an allow-listed push service: no credentials, no port, canonical form only. */
export function isAllowedPushEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_ENDPOINT_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  // The WHATWG parser silently repairs case, whitespace, backslashes, percent-encoded hosts and default ports,
  // while web-push sends with Node's legacy url.parse, which reads some of those differently
  // (https://fcm%2egoogleapis.com/ is FCM here, host "fcm" there). Browsers always hand out the canonical form.
  // Necessary but not sufficient: the two parsers also disagree on host characters (isPushServiceHost's charset).
  if (url.href !== value) return false;
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  return isPushServiceHost(url.hostname);
}

function isKey(value: unknown, chars: number, bytes: number): value is string {
  // Length first: the regex and the decode only ever see a bounded string.
  return (
    typeof value === "string" &&
    value.length === chars &&
    BASE64URL.test(value) &&
    Buffer.from(value, "base64url").length === bytes
  );
}

/**
 * The body of POST /api/push-subscriptions — `{ endpoint, keys: { p256dh, auth }, locale }` — validated, or null
 * (→ 400 PUSH_SUBSCRIPTION_INVALID). Any other field is dropped.
 */
export function parsePushSubscription(body: unknown): PushSubscriptionInput | null {
  if (!body || typeof body !== "object") return null;
  const { endpoint, keys, locale } = body as { endpoint?: unknown; keys?: unknown; locale?: unknown };
  if (!isAllowedPushEndpoint(endpoint)) return null;
  if (!keys || typeof keys !== "object") return null;
  const { p256dh, auth } = keys as { p256dh?: unknown; auth?: unknown };
  if (!isKey(p256dh, P256DH_CHARS, P256DH_BYTES) || !isKey(auth, AUTH_CHARS, AUTH_BYTES)) return null;
  if (locale === undefined) return { endpoint, p256dh, auth };
  if (typeof locale !== "string" || !(LOCALES as readonly string[]).includes(locale)) return null;
  return { endpoint, p256dh, auth, locale: locale as Locale };
}
