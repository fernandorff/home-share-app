// The browsers' push services (spec 010): Chrome/Android → FCM, Firefox → Mozilla, Safari → Apple, Edge → WNS. Every
// URL on them is a capability URL — the device token is its path (FCM, Mozilla, Apple) or its query (WNS) — so logs
// and Sentry keep only the origin (src/lib/observability/scrub.ts, criterion 13). Pure: no Node or Next imports.
export const PUSH_SERVICE_HOSTS = ["fcm.googleapis.com", "push.services.mozilla.com", "push.apple.com", "notify.windows.com"] as const;

// Real push hosts only use these characters; empty labels fail too (same rule as the endpoint validator).
const HOST_CHARSET = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;

/**
 * True for a push service's host or a subdomain of it, in any case. A subdomain means a ".host" suffix — never a bare
 * suffix, which would let evilfcm.googleapis.com in. Takes a bare host name: no port, no credentials.
 */
export function isPushServiceHost(host: string): boolean {
  const name = host.toLowerCase();
  return HOST_CHARSET.test(name) && PUSH_SERVICE_HOSTS.some((allowed) => name === allowed || name.endsWith(`.${allowed}`));
}
