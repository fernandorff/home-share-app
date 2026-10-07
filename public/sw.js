/*
 * Home Share service worker (spec 010, ADR 0011): push only. It shows a notification for every push, opens the
 * app when one is tapped, and stores a subscription the browser replaced. On purpose it has no fetch handler and
 * never uses the Cache API, so it can never serve a stale app. Plain script, no build step, no imports.
 * Contract: src/lib/push/sw-contract.test.ts.
 */
"use strict";

const FALLBACK_TITLE = "Home Share";
const FALLBACK_PATH = "/notifications";
const ICON = "/icons/icon-192.png";
const SUBSCRIPTIONS_API = "/api/push-subscriptions";

/** An absolute URL on this app's origin, else the notification center: a push never opens another site. */
function appUrl(value) {
  if (typeof value === "string" && value) {
    try {
      const url = new URL(value, self.location.origin);
      // The protocol too: a blob: URL's origin is its inner origin (blob:https://this-app/… would pass).
      if (url.origin === self.location.origin && url.protocol === self.location.protocol) return url.href;
    } catch {
      // not a URL: the center below
    }
  }
  return new URL(FALLBACK_PATH, self.location.origin).href;
}

/** The payload's { title, body, url, tag }, or a generic notice: iOS requires a visible notification per push. */
function readPayload(data) {
  let payload = null;
  try {
    payload = data ? data.json() : null;
  } catch {
    payload = null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) payload = {};
  const title = typeof payload.title === "string" && payload.title.trim() ? payload.title : FALLBACK_TITLE;
  const options = { icon: ICON, badge: ICON, data: { url: appUrl(payload.url) } };
  if (typeof payload.body === "string" && payload.body) options.body = payload.body;
  if (typeof payload.tag === "string" && payload.tag) {
    // The tag replaces the previous notice of the same kind instead of stacking; renotify still alerts for the new one.
    options.tag = payload.tag;
    options.renotify = true;
  }
  return { title, options };
}

/** Tells the open app windows that a notice arrived (the bell refreshes its count). Best effort. */
async function notifyWindows() {
  try {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      try {
        client.postMessage({ type: "push" });
      } catch {
        // a closing window
      }
    }
  } catch {
    // nothing to tell
  }
}

/** Focuses an open app window and navigates it to `url`, or opens a new window there. */
async function openApp(url) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const client = windows.find((candidate) => new URL(candidate.url).origin === self.location.origin);
  if (client) {
    try {
      await client.focus();
      await client.navigate(url);
      return;
    } catch {
      // a window this worker does not control cannot be navigated: open a new one
    }
  }
  await self.clients.openWindow(url);
}

/**
 * The VAPID public key the app registered this worker with (/sw.js?k=<base64url key>), as bytes; null without one, and
 * a throw (atob) for an impossible length. Firefox can fire pushsubscriptionchange without the old subscription, so
 * there is no old key to reuse.
 */
function registeredKey() {
  const key = new URL(self.location.href).searchParams.get("k");
  if (!key || !/^[A-Za-z0-9_-]+$/.test(key)) return null;
  const binary = atob(key.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(key.length / 4) * 4, "="));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/**
 * The browser replaced the subscription (Firefox): subscribe again with the same VAPID key — the old subscription's,
 * else the one in this worker's URL — and store it. No locale — the worker cannot know the app's: the server keeps a
 * known row's, a new row starts in en until the app's next load re-registers it. Best effort: that on-load sync also
 * covers every other browser.
 */
async function resubscribe(event) {
  try {
    let subscription = event.newSubscription;
    if (!subscription) {
      const old = event.oldSubscription;
      const key = (old && old.options && old.options.applicationServerKey) || registeredKey();
      if (!key) return;
      subscription = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    }
    const { endpoint, keys } = subscription.toJSON();
    await fetch(SUBSCRIPTIONS_API, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint, keys }),
    });
  } catch {
    // best effort
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  const { title, options } = readPayload(event.data);
  event.waitUntil(self.registration.showNotification(title, options).then(() => notifyWindows()));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data;
  event.waitUntil(openApp(appUrl(data && data.url)));
});

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(resubscribe(event));
});
