// Web Push in the browser (spec 010 — criteria 3, 8, 11; design › Client sync). Framework-free and SSR-safe: `window`
// is read only inside the functions, never at import time. The imports stay minimal on purpose — the API wrapper, the
// install helpers and the locale list, none of which imports anything — so no server module (the push validators,
// payload, scheduler or services) ever reaches the client bundle (pinned by client.test.ts).
import { api } from "@/lib/api";
import { isIos, isStandalone } from "@/lib/install-prompt";
import { LOCALES } from "@/i18n/locales";

export type PushSupport = "unconfigured" | "unsupported" | "ios-needs-install" | "ok";

/** Per-device owner marker: the publicId of the member who turned push on in this browser. */
export const PUSH_OWNER_KEY = "homeshare.push.owner";

const SUBSCRIPTIONS_API = "/api/push-subscriptions";
const BASE64URL = /^[A-Za-z0-9_-]*$/;

function browser(): typeof window | undefined {
  return typeof window === "undefined" ? undefined : window;
}

/** The VAPID public key inlined at build time, or null: the client's view of "push is configured". */
function vapidPublicKey(): string | null {
  return process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim() || null;
}

/** Push is configured for this build (the public key was inlined): the same answer on the server and in the browser. */
export function pushConfigured(): boolean {
  return vapidPublicKey() !== null;
}

/** The notification permission; "default" where the browser has no Notification API (a useSyncExternalStore snapshot). */
export function notificationPermission(): NotificationPermission {
  return browser()?.Notification?.permission ?? "default";
}

/**
 * Calls `onChange` when the notification permission changes outside the page (site settings, the browser's own UI).
 * A browser without the Permissions API, or one that refuses "notifications", is simply not watched — the card still
 * re-reads the permission on each render. Returns the cleanup.
 */
export function watchNotificationPermission(onChange: () => void): () => void {
  const permissions = browser()?.navigator.permissions;
  if (!permissions) return () => {};
  let status: PermissionStatus | null = null;
  let active = true;
  // Inside a promise chain, so an engine that throws synchronously for the name lands in the rejection handler too.
  Promise.resolve()
    .then(() => permissions.query({ name: "notifications" }))
    .then(
      (answer) => {
        if (!active) return;
        status = answer;
        answer.addEventListener("change", onChange);
      },
      () => {}
    );
  return () => {
    active = false;
    status?.removeEventListener("change", onChange);
  };
}

/** What this browser can do with push. Pure read of the environment (usable as a useSyncExternalStore snapshot). */
export function pushSupport(): PushSupport {
  if (!vapidPublicKey()) return "unconfigured";
  const w = browser();
  if (!w) return "unsupported";
  const nav = w.navigator;
  // iOS exposes push only to an app opened from the Home Screen (16.4+); a Safari tab lacks the APIs, so this goes first.
  if (isIos(nav.userAgent, nav.maxTouchPoints) && !isStandalone(w)) return "ios-needs-install";
  return "serviceWorker" in nav && "PushManager" in w && "Notification" in w ? "ok" : "unsupported";
}

/** Decodes base64url without padding (how VAPID keys are written) to bytes; throws on anything else. */
export function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  if (!BASE64URL.test(value)) throw new TypeError("Not a base64url string");
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Whether a subscription was made with `publicKey` (its `options.applicationServerKey`). A browser that does not expose
 * that key cannot be compared: counted as the same, so it is not resubscribed on every load. Throws on a malformed
 * `publicKey`, so a broken configuration never drops a working subscription.
 */
export function sameVapidKey(applicationServerKey: ArrayBuffer | null | undefined, publicKey: string): boolean {
  const expected = urlBase64ToUint8Array(publicKey);
  if (!applicationServerKey) return true;
  const actual = new Uint8Array(applicationServerKey);
  return actual.length === expected.length && actual.every((byte, i) => byte === expected[i]);
}

// Every marker access sits in a try/catch: the localStorage getter itself throws where site data is blocked.

/** The marker's member, or null when none is stored or storage is unreadable (ownership unknown). */
function readPushOwner(): string | null {
  try {
    return browser()?.localStorage.getItem(PUSH_OWNER_KEY) ?? null;
  } catch {
    return null;
  }
}

function writePushOwner(owner: string): void {
  try {
    browser()?.localStorage.setItem(PUSH_OWNER_KEY, owner);
  } catch {
    // Not kept: the next load finds no marker and releases the subscription (fail closed).
  }
}

function clearPushOwner(): void {
  try {
    browser()?.localStorage.removeItem(PUSH_OWNER_KEY);
  } catch {
    // Nothing stored to clear.
  }
}

/**
 * Registers the push worker at scope "/" and resolves once it is active. The key rides in the worker's URL for
 * Firefox's pushsubscriptionchange (public/sw.js). Registrations are keyed by scope: a browser that registered "/sw.js"
 * before (without a key, or with an older one) keeps its single registration, and its push subscription, and only
 * installs the worker from the new URL.
 */
async function registerServiceWorker(container: ServiceWorkerContainer, publicKey: string): Promise<ServiceWorkerRegistration> {
  await container.register(`/sw.js?k=${encodeURIComponent(publicKey)}`, { scope: "/", updateViaCache: "none" });
  return container.ready;
}

/** The browser's subscription at this page's registration, without registering anything. */
async function currentSubscription(): Promise<PushSubscription | null> {
  const container = browser()?.navigator.serviceWorker;
  if (!container) return null;
  const registration = await container.getRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
}

function subscribeWithKey(registration: ServiceWorkerRegistration, publicKey: string): Promise<PushSubscription> {
  return registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
}

/** Drops a subscription made with another VAPID key: in the browser, and its row on the server (best effort). */
async function dropStale(subscription: PushSubscription): Promise<void> {
  const { endpoint } = subscription;
  await subscription.unsubscribe();
  // Otherwise the row lingers: a push service may answer a key mismatch with 403, which never deletes it.
  await api.del(SUBSCRIPTIONS_API, { endpoint }).catch(() => {});
}

/** The POST body: endpoint, keys and the app locale (left out when unknown, so the server keeps the stored one). */
function subscriptionBody(subscription: PushSubscription, locale: string) {
  const { endpoint, keys } = subscription.toJSON();
  return (LOCALES as readonly string[]).includes(locale) ? { endpoint, keys, locale } : { endpoint, keys };
}

interface PushMember {
  /** The signed-in member's publicId (the owner marker's value). */
  owner: string;
  /** The app locale (next-intl), rendered into this device's pushes. */
  locale: string;
}

export type PushSyncOutcome = "unavailable" | "inactive" | "released" | "registered";

/**
 * On every app load (criterion 8). Where push is configured and supported: registers the worker; then, only with
 * permission granted and a browser subscription — a subscription the marker does not attribute to this member (another
 * member, none, or unreadable storage) is unsubscribed and push stays off (a shared browser never inherits an opt-in);
 * one made with another VAPID key is replaced; this member's is POSTed again, refreshing owner and locale (and bringing
 * the device back after a logout deleted every row, criterion 9). Never prompts. Rejects on failures (best effort for
 * the caller).
 */
export async function syncPush({ owner, locale }: PushMember): Promise<PushSyncOutcome> {
  const w = browser();
  const publicKey = vapidPublicKey();
  if (!w || !publicKey || pushSupport() !== "ok") return "unavailable";
  const registration = await registerServiceWorker(w.navigator.serviceWorker, publicKey);
  if (w.Notification.permission !== "granted") return "inactive";
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) return "inactive";
  if (readPushOwner() !== owner) {
    await subscription.unsubscribe();
    clearPushOwner();
    return "released";
  }
  if (!sameVapidKey(subscription.options.applicationServerKey, publicKey)) {
    await dropStale(subscription);
    subscription = await subscribeWithKey(registration, publicKey);
  }
  await api.post(SUBSCRIPTIONS_API, subscriptionBody(subscription, locale));
  return "registered";
}

export type PushSubscribeOutcome = "unavailable" | "denied" | "dismissed" | "subscribed";

/**
 * "Receive on this device" turned on (criterion 3). Call it straight from the tap: the permission prompt is the first
 * thing it awaits (iOS shows it only inside a user gesture), and a blocked permission is never prompted (criterion 11).
 * Subscribes with the VAPID key (userVisibleOnly), stores the subscription with the app locale, then marks the device.
 * Rejects when the subscription cannot be made or stored — with nothing left half on.
 */
export async function subscribePush({ owner, locale }: PushMember): Promise<PushSubscribeOutcome> {
  const w = browser();
  const publicKey = vapidPublicKey();
  if (!w || !publicKey || pushSupport() !== "ok") return "unavailable";
  const notifications = w.Notification;
  const permission = notifications.permission === "default" ? await notifications.requestPermission() : notifications.permission;
  if (permission === "denied") return "denied";
  if (permission !== "granted") return "dismissed";

  const registration = await registerServiceWorker(w.navigator.serviceWorker, publicKey);
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !sameVapidKey(subscription.options.applicationServerKey, publicKey)) {
    await dropStale(subscription);
    subscription = null;
  }
  subscription ??= await subscribeWithKey(registration, publicKey);
  try {
    await api.post(SUBSCRIPTIONS_API, subscriptionBody(subscription, locale));
  } catch (error) {
    await subscription.unsubscribe().catch(() => false);
    throw error;
  }
  writePushOwner(owner);
  return "subscribed";
}

/**
 * "Receive on this device" turned off (criterion 3). The row goes first: a failed DELETE rejects and leaves push on.
 * Then the marker and the browser subscription — best effort: with the marker gone, the next load releases it anyway.
 */
export async function unsubscribePush(): Promise<void> {
  const subscription = await currentSubscription();
  if (subscription) await api.del(SUBSCRIPTIONS_API, { endpoint: subscription.endpoint });
  clearPushOwner();
  await subscription?.unsubscribe().catch(() => false);
}

/** Push is on in this browser for `owner`: permission granted, a subscription, and the marker naming them. Read-only. */
export async function pushEnabledHere(owner: string): Promise<boolean> {
  const w = browser();
  if (!w || pushSupport() !== "ok" || w.Notification.permission !== "granted") return false;
  return (await currentSubscription()) !== null && readPushOwner() === owner;
}

/** Calls `onPush` whenever the worker reports a push (`{ type: "push" }`, public/sw.js). Returns the cleanup. */
export function listenForPushMessages(onPush: () => void): () => void {
  const container = browser()?.navigator.serviceWorker;
  if (!container) return () => {};
  const onMessage = (event: MessageEvent) => {
    if (event.data?.type === "push") onPush();
  };
  container.addEventListener("message", onMessage);
  return () => container.removeEventListener("message", onMessage);
}
