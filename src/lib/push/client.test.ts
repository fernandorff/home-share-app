import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/api", () => ({ api: { post: vi.fn(), del: vi.fn() } }));

import { api } from "@/lib/api";
import {
  PUSH_OWNER_KEY,
  listenForPushMessages,
  notificationPermission,
  pushConfigured,
  pushEnabledHere,
  pushSupport,
  sameVapidKey,
  subscribePush,
  syncPush,
  unsubscribePush,
  urlBase64ToUint8Array,
  watchNotificationPermission,
} from "./client";

// Client side of Web Push (spec 010 — criteria 3, 8, 11; design › Client sync). The browser APIs are faked on a
// stubbed `window` (no DOM environment here): service worker container, PushManager, Notification, localStorage.

const post = vi.mocked(api.post);
const del = vi.mocked(api.del);

/** A real-shaped VAPID public key: 65 bytes (0x04 + X + Y); its base64url uses both "-" and "_". */
const KEY_BYTES = Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : (i + 98) % 256));
const PUBLIC_KEY = Buffer.from(KEY_BYTES).toString("base64url");
const OLD_KEY_BYTES = KEY_BYTES.map((byte, i) => (i === 64 ? byte ^ 1 : byte));

const ME = "0192f0c4-0000-7000-8000-00000000aaaa";
const OTHER = "0192f0c4-0000-7000-8000-00000000bbbb";
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/existing-token";
const NEW_ENDPOINT = "https://fcm.googleapis.com/fcm/send/new-token";
const KEYS = { p256dh: "P256DH", auth: "AUTH" };
const API = "/api/push-subscriptions";

const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const IPAD_AS_MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

interface FakeOptions {
  userAgent?: string;
  maxTouchPoints?: number;
  standalone?: boolean;
  serviceWorker?: boolean;
  pushManager?: boolean;
  notification?: boolean;
  permission?: NotificationPermission;
  /** What the permission prompt answers. */
  answer?: NotificationPermission;
  /** The browser's current subscription: its endpoint and the key it was made with (null = not exposed). */
  subscription?: { endpoint: string; key: Uint8Array | null } | null;
  /** No registration at this scope yet (getRegistration resolves undefined). */
  unregistered?: boolean;
  marker?: string;
  /** "getter": reading window.localStorage throws; "methods": getItem/setItem/removeItem throw. */
  storageThrows?: "getter" | "methods";
}

type FakeSubscription = {
  endpoint: string;
  options: { userVisibleOnly: boolean; applicationServerKey: ArrayBuffer | null };
  toJSON: () => { endpoint: string; expirationTime: null; keys: typeof KEYS };
  unsubscribe: ReturnType<typeof vi.fn>;
};

/** Stubs `window` with a fake browser; `order` records the calls that matter for sequencing. */
function fakeBrowser(o: FakeOptions = {}) {
  const order: string[] = [];
  const store = new Map<string, string>();
  if (o.marker !== undefined) store.set(PUSH_OWNER_KEY, o.marker);
  const failing = () => {
    throw new DOMException("The operation is insecure.", "SecurityError");
  };
  const localStorage =
    o.storageThrows === "methods"
      ? { getItem: vi.fn(failing), setItem: vi.fn(failing), removeItem: vi.fn(failing) }
      : {
          getItem: vi.fn((key: string) => store.get(key) ?? null),
          setItem: vi.fn((key: string, value: string) => void store.set(key, value)),
          removeItem: vi.fn((key: string) => void store.delete(key)),
        };

  let current: FakeSubscription | null = null;
  function makeSubscription(endpoint: string, key: Uint8Array | null): FakeSubscription {
    const subscription: FakeSubscription = {
      endpoint,
      options: { userVisibleOnly: true, applicationServerKey: key ? key.slice().buffer : null },
      toJSON: () => ({ endpoint, expirationTime: null, keys: KEYS }),
      unsubscribe: vi.fn(async () => {
        order.push(`unsubscribe ${endpoint}`);
        if (current === subscription) current = null;
        return true;
      }),
    };
    return subscription;
  }
  if (o.subscription) current = makeSubscription(o.subscription.endpoint, o.subscription.key);
  const initial = current;

  const pushManager = {
    getSubscription: vi.fn(async () => current),
    subscribe: vi.fn(async (options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => {
      order.push("subscribe");
      current = makeSubscription(NEW_ENDPOINT, new Uint8Array(options.applicationServerKey));
      return current;
    }),
  };
  const registration = { scope: "https://homeshare.test/", pushManager };
  const messageListeners = new Set<(event: { data: unknown }) => void>();
  const serviceWorker = {
    register: vi.fn(async () => {
      order.push("register");
      return registration;
    }),
    ready: Promise.resolve(registration),
    getRegistration: vi.fn(async () => (o.unregistered ? undefined : registration)),
    addEventListener: vi.fn((type: string, listener: (event: { data: unknown }) => void) => {
      if (type === "message") messageListeners.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: (event: { data: unknown }) => void) => {
      if (type === "message") messageListeners.delete(listener);
    }),
  };
  const notification = {
    permission: o.permission ?? "granted",
    requestPermission: vi.fn(async () => {
      order.push("requestPermission");
      notification.permission = o.answer ?? "granted";
      return notification.permission;
    }),
  };
  const navigator: Record<string, unknown> = { userAgent: o.userAgent ?? DESKTOP_UA, maxTouchPoints: o.maxTouchPoints ?? 0 };
  if (o.serviceWorker !== false) navigator.serviceWorker = serviceWorker;
  if (o.standalone) navigator.standalone = true;
  const win: Record<string, unknown> = {
    navigator,
    matchMedia: () => ({ matches: false }),
  };
  if (o.pushManager !== false) win.PushManager = function PushManager() {};
  if (o.notification !== false) win.Notification = notification;
  Object.defineProperty(win, "localStorage", {
    get: () => (o.storageThrows === "getter" ? failing() : localStorage),
  });
  vi.stubGlobal("window", win);
  post.mockImplementation(async () => {
    order.push("POST");
    return { ok: true };
  });
  del.mockImplementation(async () => {
    order.push("DELETE");
    return { ok: true };
  });

  return {
    order,
    store,
    localStorage,
    serviceWorker,
    pushManager,
    notification,
    initial,
    emit: (data: unknown) => messageListeners.forEach((listener) => listener({ data })),
    listenerCount: () => messageListeners.size,
    current: () => current,
  };
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", PUBLIC_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe("urlBase64ToUint8Array", () => {
  it("decodes a VAPID public key (base64url, no padding) to its 65 bytes", () => {
    expect(PUBLIC_KEY).toMatch(/-/);
    expect(PUBLIC_KEY).toMatch(/_/);
    expect(Array.from(urlBase64ToUint8Array(PUBLIC_KEY))).toEqual(Array.from(KEY_BYTES));
  });

  it("maps - and _ back to the bytes standard base64 writes as + and /", () => {
    expect(Array.from(urlBase64ToUint8Array("-_8"))).toEqual([0xfb, 0xff]);
  });

  it.each([0, 1, 2, 3, 4, 5, 16, 32])("round-trips %i bytes (every padding length)", (length) => {
    const bytes = Uint8Array.from({ length }, (_, i) => (i * 53 + 7) % 256);
    expect(Array.from(urlBase64ToUint8Array(Buffer.from(bytes).toString("base64url")))).toEqual(Array.from(bytes));
  });

  it("returns a Uint8Array over its own ArrayBuffer (usable as applicationServerKey)", () => {
    const bytes = urlBase64ToUint8Array(PUBLIC_KEY);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteOffset).toBe(0);
    expect(bytes.buffer.byteLength).toBe(65);
  });

  it.each(["ab+c", "ab/c", "a b", "abc=", "key!", "a"])("throws on %j (not base64url without padding)", (value) => {
    expect(() => urlBase64ToUint8Array(value)).toThrow();
  });
});

describe("sameVapidKey — the key a subscription was made with vs the configured one (criterion 8)", () => {
  it("is true for the same key bytes", () => {
    expect(sameVapidKey(KEY_BYTES.slice().buffer, PUBLIC_KEY)).toBe(true);
  });

  it("is false when one byte differs (a rotated key) or the length differs", () => {
    expect(sameVapidKey(OLD_KEY_BYTES.slice().buffer, PUBLIC_KEY)).toBe(false);
    expect(sameVapidKey(KEY_BYTES.slice(0, 64).buffer, PUBLIC_KEY)).toBe(false);
    expect(sameVapidKey(new ArrayBuffer(0), PUBLIC_KEY)).toBe(false);
  });

  it("counts a browser that does not expose the key as the same (never resubscribed on every load)", () => {
    expect(sameVapidKey(null, PUBLIC_KEY)).toBe(true);
    expect(sameVapidKey(undefined, PUBLIC_KEY)).toBe(true);
  });

  it("throws on a malformed configured key instead of calling it different (also when the browser exposes no key)", () => {
    expect(() => sameVapidKey(KEY_BYTES.slice().buffer, "not a key!")).toThrow();
    expect(() => sameVapidKey(null, "not a key!")).toThrow();
  });
});

describe("pushSupport() (criteria 1, 11)", () => {
  it.each([["unset", undefined], ["empty", ""], ["blank", "   "]])("is 'unconfigured' with the public key %s, even on a capable browser", (_label, value) => {
    fakeBrowser();
    if (value === undefined) delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    else vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", value);
    expect(pushSupport()).toBe("unconfigured");
  });

  it("is 'unsupported' outside a browser (server render)", () => {
    vi.stubGlobal("window", undefined);
    expect(pushSupport()).toBe("unsupported");
  });

  it("is 'ok' on a desktop browser with service workers, PushManager and Notification", () => {
    fakeBrowser();
    expect(pushSupport()).toBe("ok");
  });

  it.each([
    ["service workers", { serviceWorker: false }],
    ["PushManager", { pushManager: false }],
    ["Notification", { notification: false }],
  ])("is 'unsupported' without %s", (_label, options) => {
    fakeBrowser(options);
    expect(pushSupport()).toBe("unsupported");
  });

  it("is 'ios-needs-install' in iPhone Safari outside the Home Screen (where the push APIs are missing)", () => {
    fakeBrowser({ userAgent: IPHONE_UA, maxTouchPoints: 5, pushManager: false, notification: false });
    expect(pushSupport()).toBe("ios-needs-install");
  });

  it("is 'ios-needs-install' on an iPad that reports a Mac (touch screen)", () => {
    fakeBrowser({ userAgent: IPAD_AS_MAC_UA, maxTouchPoints: 5 });
    expect(pushSupport()).toBe("ios-needs-install");
  });

  it("a real Mac (no touch) is a desktop browser", () => {
    fakeBrowser({ userAgent: IPAD_AS_MAC_UA, maxTouchPoints: 0 });
    expect(pushSupport()).toBe("ok");
  });

  it("is 'ok' in the installed iPhone app (16.4+) and 'unsupported' in an older one without PushManager", () => {
    fakeBrowser({ userAgent: IPHONE_UA, maxTouchPoints: 5, standalone: true });
    expect(pushSupport()).toBe("ok");
    fakeBrowser({ userAgent: IPHONE_UA, maxTouchPoints: 5, standalone: true, pushManager: false });
    expect(pushSupport()).toBe("unsupported");
  });

  it("reads no window at import time (SSR-safe module)", async () => {
    vi.resetModules();
    vi.stubGlobal("window", undefined);
    const fresh = await import("./client");
    expect(fresh.pushSupport()).toBe("unsupported");
  });
});

describe("syncPush — on every app load (criterion 8)", () => {
  const sync = (locale = "pt") => syncPush({ owner: ME, locale });

  it("registers /sw.js with the VAPID key in its URL at scope / (updateViaCache none)", async () => {
    const browser = fakeBrowser({ permission: "default" });
    await sync();
    expect(browser.serviceWorker.register).toHaveBeenCalledTimes(1);
    expect(browser.serviceWorker.register).toHaveBeenCalledWith(`/sw.js?k=${encodeURIComponent(PUBLIC_KEY)}`, {
      scope: "/",
      updateViaCache: "none",
    });
  });

  it("URL-encodes the key in the worker URL", async () => {
    // A real key is base64url (nothing to encode); a mistyped env value must still not break the URL.
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "a+b/c=&d");
    const browser = fakeBrowser({ permission: "default" });
    await sync();
    expect(browser.serviceWorker.register).toHaveBeenCalledWith("/sw.js?k=a%2Bb%2Fc%3D%26d", { scope: "/", updateViaCache: "none" });
  });

  it("does nothing at all while push is unconfigured or unsupported (no worker registered)", async () => {
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "");
    let browser = fakeBrowser();
    await expect(sync()).resolves.toBe("unavailable");
    expect(browser.serviceWorker.register).not.toHaveBeenCalled();

    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", PUBLIC_KEY);
    browser = fakeBrowser({ pushManager: false });
    await expect(sync()).resolves.toBe("unavailable");
    expect(browser.serviceWorker.register).not.toHaveBeenCalled();

    browser = fakeBrowser({ userAgent: IPHONE_UA, maxTouchPoints: 5 });
    await expect(sync()).resolves.toBe("unavailable");
    expect(browser.serviceWorker.register).not.toHaveBeenCalled();
  });

  it.each(["default", "denied"] as const)("with permission %s: registers the worker, never prompts, touches no subscription", async (permission) => {
    const browser = fakeBrowser({ permission, marker: ME, subscription: { endpoint: ENDPOINT, key: KEY_BYTES } });
    await expect(sync()).resolves.toBe("inactive");
    expect(browser.serviceWorker.register).toHaveBeenCalledTimes(1);
    expect(browser.notification.requestPermission).not.toHaveBeenCalled();
    expect(browser.pushManager.subscribe).not.toHaveBeenCalled();
    expect(browser.initial?.unsubscribe).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("with no browser subscription: nothing to sync (push stays off, no prompt, no subscribe)", async () => {
    const browser = fakeBrowser({ marker: ME });
    await expect(sync()).resolves.toBe("inactive");
    expect(browser.pushManager.subscribe).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("this member's subscription, same key: re-registers it with the app locale (owner + locale refreshed)", async () => {
    const browser = fakeBrowser({ marker: ME, subscription: { endpoint: ENDPOINT, key: KEY_BYTES } });
    await expect(sync("pt")).resolves.toBe("registered");

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(API, { endpoint: ENDPOINT, keys: KEYS, locale: "pt" });
    expect(browser.initial?.unsubscribe).not.toHaveBeenCalled();
    expect(browser.pushManager.subscribe).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(browser.store.get(PUSH_OWNER_KEY)).toBe(ME);
  });

  it("sends only endpoint, keys and locale (no expirationTime)", async () => {
    fakeBrowser({ marker: ME, subscription: { endpoint: ENDPOINT, key: KEY_BYTES } });
    await sync("fr");
    expect(Object.keys(post.mock.calls[0][1] as object).sort()).toEqual(["endpoint", "keys", "locale"]);
  });

  it("leaves out a locale the app does not have (the server keeps the stored one)", async () => {
    fakeBrowser({ marker: ME, subscription: { endpoint: ENDPOINT, key: KEY_BYTES } });
    await sync("de");
    expect(post).toHaveBeenCalledWith(API, { endpoint: ENDPOINT, keys: KEYS });
  });

  it.each([
    ["another member", { marker: OTHER }],
    ["nobody (no marker stored)", {}],
  ])("a subscription the marker attributes to %s: unsubscribed, marker cleared, left off — never inherited", async (_label, options) => {
    const browser = fakeBrowser({ ...options, subscription: { endpoint: ENDPOINT, key: KEY_BYTES } });
    await expect(sync()).resolves.toBe("released");

    expect(browser.initial?.unsubscribe).toHaveBeenCalledTimes(1);
    expect(browser.pushManager.subscribe).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(browser.store.has(PUSH_OWNER_KEY)).toBe(false);
  });

  it.each([
    ["the storage getter throws", "getter" as const],
    ["getItem throws", "methods" as const],
  ])("ownership unknown because %s (even with this member's marker behind it): unsubscribed, never re-registered", async (_label, storageThrows) => {
    const browser = fakeBrowser({ marker: ME, storageThrows, subscription: { endpoint: ENDPOINT, key: KEY_BYTES } });
    await expect(sync()).resolves.toBe("released");

    expect(browser.initial?.unsubscribe).toHaveBeenCalledTimes(1);
    expect(browser.pushManager.subscribe).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("another member's subscription made with an old key: only released, never resubscribed", async () => {
    const browser = fakeBrowser({ marker: OTHER, subscription: { endpoint: ENDPOINT, key: OLD_KEY_BYTES } });
    await expect(sync()).resolves.toBe("released");
    expect(browser.pushManager.subscribe).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("this member's subscription made with another VAPID key: dropped (browser + its row) and made again with the current key", async () => {
    const browser = fakeBrowser({ marker: ME, subscription: { endpoint: ENDPOINT, key: OLD_KEY_BYTES } });
    await expect(sync("es")).resolves.toBe("registered");

    expect(browser.order).toEqual(["register", `unsubscribe ${ENDPOINT}`, "DELETE", "subscribe", "POST"]);
    expect(del).toHaveBeenCalledWith(API, { endpoint: ENDPOINT });
    const options = browser.pushManager.subscribe.mock.calls[0][0];
    expect(options.userVisibleOnly).toBe(true);
    expect(Array.from(options.applicationServerKey)).toEqual(Array.from(KEY_BYTES));
    expect(post).toHaveBeenCalledWith(API, { endpoint: NEW_ENDPOINT, keys: KEYS, locale: "es" });
    expect(browser.store.get(PUSH_OWNER_KEY)).toBe(ME);
  });

  it("a failed DELETE of the old row never stops the resubscription", async () => {
    const browser = fakeBrowser({ marker: ME, subscription: { endpoint: ENDPOINT, key: OLD_KEY_BYTES } });
    del.mockRejectedValueOnce(new TypeError("offline"));
    await expect(sync()).resolves.toBe("registered");
    expect(browser.pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(API, { endpoint: NEW_ENDPOINT, keys: KEYS, locale: "pt" });
  });

  it("a browser that does not expose the subscription's key is re-registered as is (no resubscribe)", async () => {
    const browser = fakeBrowser({ marker: ME, subscription: { endpoint: ENDPOINT, key: null } });
    await expect(sync()).resolves.toBe("registered");
    expect(browser.pushManager.subscribe).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith(API, { endpoint: ENDPOINT, keys: KEYS, locale: "pt" });
  });

  it("a failed POST rejects (the registrar swallows it) and keeps the subscription for the next load", async () => {
    const browser = fakeBrowser({ marker: ME, subscription: { endpoint: ENDPOINT, key: KEY_BYTES } });
    post.mockRejectedValueOnce(new Error("Error 503"));
    await expect(sync()).rejects.toThrow("Error 503");
    expect(browser.initial?.unsubscribe).not.toHaveBeenCalled();
    expect(browser.store.get(PUSH_OWNER_KEY)).toBe(ME);
  });

  it("a malformed configured key rejects before any subscription is dropped", async () => {
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "not a key!");
    const browser = fakeBrowser({ marker: ME, subscription: { endpoint: ENDPOINT, key: KEY_BYTES } });
    await expect(sync()).rejects.toThrow();
    expect(browser.initial?.unsubscribe).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  // Cycle D review minor 2 / cycle G review M6: the rejections the helpers pass on.
  it("a worker that fails to register rejects the sync and touches nothing (no subscription read, no POST, marker kept)", async () => {
    const browser = fakeBrowser({ marker: ME, subscription: { endpoint: ENDPOINT, key: KEY_BYTES } });
    browser.serviceWorker.register.mockRejectedValueOnce(new DOMException("Failed to register a ServiceWorker", "SecurityError"));
    await expect(sync()).rejects.toThrow("Failed to register a ServiceWorker");
    expect(browser.pushManager.getSubscription).not.toHaveBeenCalled();
    expect(browser.initial?.unsubscribe).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(browser.store.get(PUSH_OWNER_KEY)).toBe(ME);
  });

  it.each([
    ["another member", { marker: OTHER }, OTHER],
    ["nobody (no marker stored)", {}, undefined],
  ])("releasing a subscription the marker attributes to %s: a failed unsubscribe rejects the sync, the marker untouched", async (_label, options, marker) => {
    const browser = fakeBrowser({ ...options, subscription: { endpoint: ENDPOINT, key: KEY_BYTES } });
    browser.initial?.unsubscribe.mockRejectedValueOnce(new DOMException("unsubscribe failed", "InvalidStateError"));
    await expect(sync()).rejects.toThrow("unsubscribe failed");
    expect(browser.store.get(PUSH_OWNER_KEY)).toBe(marker);
    expect(browser.localStorage.removeItem).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(browser.pushManager.subscribe).not.toHaveBeenCalled();
  });
});

describe("subscribePush — the member turns push on (criteria 3, 11)", () => {
  const turnOn = (locale = "pt") => subscribePush({ owner: ME, locale });

  it("asks for permission first (inside the tap), then subscribes with the VAPID key, stores it and marks the device", async () => {
    const browser = fakeBrowser({ permission: "default", answer: "granted" });
    await expect(turnOn("pt")).resolves.toBe("subscribed");

    expect(browser.order).toEqual(["requestPermission", "register", "subscribe", "POST"]);
    const options = browser.pushManager.subscribe.mock.calls[0][0];
    expect(options.userVisibleOnly).toBe(true);
    expect(Array.from(options.applicationServerKey)).toEqual(Array.from(KEY_BYTES));
    expect(post).toHaveBeenCalledWith(API, { endpoint: NEW_ENDPOINT, keys: KEYS, locale: "pt" });
    expect(browser.store.get(PUSH_OWNER_KEY)).toBe(ME);
  });

  it("with permission already granted: no prompt", async () => {
    const browser = fakeBrowser({ permission: "granted" });
    await expect(turnOn()).resolves.toBe("subscribed");
    expect(browser.notification.requestPermission).not.toHaveBeenCalled();
  });

  it("while blocked: never prompts, registers nothing, stores nothing", async () => {
    const browser = fakeBrowser({ permission: "denied" });
    await expect(turnOn()).resolves.toBe("denied");
    expect(browser.notification.requestPermission).not.toHaveBeenCalled();
    expect(browser.serviceWorker.register).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(browser.store.has(PUSH_OWNER_KEY)).toBe(false);
  });

  it.each([
    ["denied", "denied"],
    ["default", "dismissed"],
  ] as const)("a prompt answered %s → '%s': no subscription, nothing stored", async (answer, outcome) => {
    const browser = fakeBrowser({ permission: "default", answer });
    await expect(turnOn()).resolves.toBe(outcome);
    expect(browser.pushManager.subscribe).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(browser.store.has(PUSH_OWNER_KEY)).toBe(false);
  });

  it("returns 'unavailable' without prompting where push is unconfigured or unsupported", async () => {
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "");
    let browser = fakeBrowser({ permission: "default" });
    await expect(turnOn()).resolves.toBe("unavailable");
    expect(browser.notification.requestPermission).not.toHaveBeenCalled();

    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", PUBLIC_KEY);
    browser = fakeBrowser({ permission: "default", userAgent: IPHONE_UA, maxTouchPoints: 5 });
    await expect(turnOn()).resolves.toBe("unavailable");
    expect(browser.notification.requestPermission).not.toHaveBeenCalled();
  });

  it("reuses a subscription already made with the current key (no second subscribe)", async () => {
    const browser = fakeBrowser({ subscription: { endpoint: ENDPOINT, key: KEY_BYTES } });
    await expect(turnOn()).resolves.toBe("subscribed");
    expect(browser.pushManager.subscribe).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith(API, { endpoint: ENDPOINT, keys: KEYS, locale: "pt" });
    expect(browser.store.get(PUSH_OWNER_KEY)).toBe(ME);
  });

  it("replaces a subscription made with another key (browser + its row) before subscribing", async () => {
    const browser = fakeBrowser({ subscription: { endpoint: ENDPOINT, key: OLD_KEY_BYTES } });
    await expect(turnOn()).resolves.toBe("subscribed");
    expect(browser.order).toEqual(["register", `unsubscribe ${ENDPOINT}`, "DELETE", "subscribe", "POST"]);
    expect(del).toHaveBeenCalledWith(API, { endpoint: ENDPOINT });
    expect(post).toHaveBeenCalledWith(API, { endpoint: NEW_ENDPOINT, keys: KEYS, locale: "pt" });
  });

  it("a worker that fails to register rejects the switch: nothing subscribed, nothing POSTed, no marker", async () => {
    const browser = fakeBrowser({ permission: "default", answer: "granted" });
    browser.serviceWorker.register.mockRejectedValueOnce(new DOMException("Failed to register a ServiceWorker", "SecurityError"));
    await expect(turnOn()).rejects.toThrow("Failed to register a ServiceWorker");
    expect(browser.order).toEqual(["requestPermission"]);
    expect(browser.pushManager.subscribe).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(browser.store.has(PUSH_OWNER_KEY)).toBe(false);
  });

  it("a failed POST leaves nothing half on: the browser subscription is undone, no marker, the error surfaces", async () => {
    const browser = fakeBrowser();
    post.mockRejectedValueOnce(new Error("Error 503"));
    await expect(turnOn()).rejects.toThrow("Error 503");
    expect(browser.current()).toBeNull();
    expect(browser.store.has(PUSH_OWNER_KEY)).toBe(false);
  });

  it("an unwritable marker never fails the switch (the next load then releases the subscription)", async () => {
    fakeBrowser({ storageThrows: "methods" });
    await expect(turnOn()).resolves.toBe("subscribed");
    fakeBrowser({ storageThrows: "getter" });
    await expect(turnOn()).resolves.toBe("subscribed");
  });
});

describe("unsubscribePush — the member turns push off (criterion 3)", () => {
  it("deletes the row, clears the marker, then unsubscribes the browser", async () => {
    const browser = fakeBrowser({ marker: ME, subscription: { endpoint: ENDPOINT, key: KEY_BYTES } });
    await unsubscribePush();

    expect(browser.order).toEqual(["DELETE", `unsubscribe ${ENDPOINT}`]);
    expect(del).toHaveBeenCalledWith(API, { endpoint: ENDPOINT });
    expect(browser.store.has(PUSH_OWNER_KEY)).toBe(false);
    expect(browser.current()).toBeNull();
    expect(browser.serviceWorker.register).not.toHaveBeenCalled();
  });

  it("a failed DELETE rejects and changes nothing (push stays on)", async () => {
    const browser = fakeBrowser({ marker: ME, subscription: { endpoint: ENDPOINT, key: KEY_BYTES } });
    del.mockRejectedValueOnce(new TypeError("offline"));
    await expect(unsubscribePush()).rejects.toThrow("offline");
    expect(browser.store.get(PUSH_OWNER_KEY)).toBe(ME);
    expect(browser.initial?.unsubscribe).not.toHaveBeenCalled();
  });

  it("a failed browser unsubscribe after the DELETE still resolves (marker gone: the next load releases it)", async () => {
    const browser = fakeBrowser({ marker: ME, subscription: { endpoint: ENDPOINT, key: KEY_BYTES } });
    browser.initial?.unsubscribe.mockRejectedValueOnce(new Error("failed"));
    await expect(unsubscribePush()).resolves.toBeUndefined();
    expect(browser.store.has(PUSH_OWNER_KEY)).toBe(false);
  });

  it("with no subscription or no registration: just clears the marker", async () => {
    let browser = fakeBrowser({ marker: ME });
    await unsubscribePush();
    expect(browser.store.has(PUSH_OWNER_KEY)).toBe(false);
    expect(del).not.toHaveBeenCalled();

    browser = fakeBrowser({ marker: ME, unregistered: true });
    await unsubscribePush();
    expect(browser.store.has(PUSH_OWNER_KEY)).toBe(false);
    expect(del).not.toHaveBeenCalled();
  });

  it("never throws on unusable storage", async () => {
    fakeBrowser({ subscription: { endpoint: ENDPOINT, key: KEY_BYTES }, storageThrows: "getter" });
    await expect(unsubscribePush()).resolves.toBeUndefined();
    fakeBrowser({ subscription: { endpoint: ENDPOINT, key: KEY_BYTES }, storageThrows: "methods" });
    await expect(unsubscribePush()).resolves.toBeUndefined();
  });
});

describe("pushEnabledHere — is push on in this browser for this member (the card's switch)", () => {
  it("is true with permission granted, a subscription and the marker naming the member", async () => {
    const browser = fakeBrowser({ marker: ME, subscription: { endpoint: ENDPOINT, key: KEY_BYTES } });
    await expect(pushEnabledHere(ME)).resolves.toBe(true);
    // Read-only: no worker registered, nothing sent, nothing changed.
    expect(browser.serviceWorker.register).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(browser.initial?.unsubscribe).not.toHaveBeenCalled();
  });

  it.each([
    ["no subscription", { marker: ME }],
    ["no registration", { marker: ME, unregistered: true }],
    ["another member's marker", { marker: OTHER, subscription: { endpoint: ENDPOINT, key: KEY_BYTES } }],
    ["no marker", { subscription: { endpoint: ENDPOINT, key: KEY_BYTES } }],
    ["unreadable storage", { marker: ME, subscription: { endpoint: ENDPOINT, key: KEY_BYTES }, storageThrows: "getter" as const }],
    ["permission default", { marker: ME, permission: "default" as const, subscription: { endpoint: ENDPOINT, key: KEY_BYTES } }],
    ["permission denied", { marker: ME, permission: "denied" as const, subscription: { endpoint: ENDPOINT, key: KEY_BYTES } }],
    ["no PushManager", { marker: ME, pushManager: false, subscription: { endpoint: ENDPOINT, key: KEY_BYTES } }],
  ])("is false with %s", async (_label, options) => {
    fakeBrowser(options);
    await expect(pushEnabledHere(ME)).resolves.toBe(false);
  });

  it("is false while push is unconfigured", async () => {
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "");
    fakeBrowser({ marker: ME, subscription: { endpoint: ENDPOINT, key: KEY_BYTES } });
    await expect(pushEnabledHere(ME)).resolves.toBe(false);
  });
});

describe("listenForPushMessages — the worker reports a push, the bell refreshes", () => {
  it("calls back for { type: 'push' } only", () => {
    const browser = fakeBrowser();
    const onPush = vi.fn();
    listenForPushMessages(onPush);

    browser.emit({ type: "push" });
    browser.emit({ type: "other" });
    browser.emit(null);
    browser.emit("push");
    browser.emit(undefined);
    expect(onPush).toHaveBeenCalledTimes(1);
  });

  it("returns a cleanup that removes the listener", () => {
    const browser = fakeBrowser();
    const onPush = vi.fn();
    const stop = listenForPushMessages(onPush);
    expect(browser.listenerCount()).toBe(1);
    stop();
    expect(browser.listenerCount()).toBe(0);
    browser.emit({ type: "push" });
    expect(onPush).not.toHaveBeenCalled();
  });

  it("is a no-op without service workers or outside a browser", () => {
    fakeBrowser({ serviceWorker: false });
    expect(() => listenForPushMessages(vi.fn())()).not.toThrow();
    vi.stubGlobal("window", undefined);
    expect(() => listenForPushMessages(vi.fn())()).not.toThrow();
  });
});

describe("pushConfigured — the install banner's push wording (task 16)", () => {
  it("is true with the public key inlined, in the browser and on the server alike (no hydration mismatch)", () => {
    fakeBrowser();
    expect(pushConfigured()).toBe(true);
    vi.stubGlobal("window", undefined);
    expect(pushConfigured()).toBe(true);
  });

  it.each(["", "   "])("is false with the key %j (unconfigured, criterion 1)", (value) => {
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", value);
    fakeBrowser();
    expect(pushConfigured()).toBe(false);
  });
});

describe("notificationPermission — read on every render of the card", () => {
  it.each(["default", "granted", "denied"] as const)("returns the browser's %s", (permission) => {
    fakeBrowser({ permission });
    expect(notificationPermission()).toBe(permission);
  });

  it("is 'default' without the Notification API (Safari on iPhone outside the Home Screen app) or outside a browser", () => {
    fakeBrowser({ notification: false });
    expect(notificationPermission()).toBe("default");
    vi.stubGlobal("window", undefined);
    expect(notificationPermission()).toBe("default");
  });
});

describe("watchNotificationPermission — the card follows a permission changed outside the page", () => {
  /** A fake `navigator.permissions` whose query resolves with a status the test can fire `change` on. */
  function fakePermissions(query: () => Promise<unknown>) {
    const browser = fakeBrowser();
    (window.navigator as unknown as Record<string, unknown>).permissions = { query: vi.fn(query) };
    return browser;
  }
  function fakeStatus() {
    const listeners = new Set<() => void>();
    return {
      addEventListener: vi.fn((type: string, listener: () => void) => void (type === "change" && listeners.add(listener))),
      removeEventListener: vi.fn((type: string, listener: () => void) => void (type === "change" && listeners.delete(listener))),
      fire: () => listeners.forEach((listener) => listener()),
      count: () => listeners.size,
    };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("queries 'notifications' and calls back on each change; the cleanup stops it", async () => {
    const status = fakeStatus();
    fakePermissions(async () => status);
    const onChange = vi.fn();
    const stop = watchNotificationPermission(onChange);
    await settle();

    expect((window.navigator as unknown as { permissions: { query: ReturnType<typeof vi.fn> } }).permissions.query).toHaveBeenCalledWith({ name: "notifications" });
    status.fire();
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
    expect(status.count()).toBe(0);
    status.fire();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("a cleanup before the query answers never leaves a listener behind", async () => {
    const status = fakeStatus();
    fakePermissions(async () => status);
    const stop = watchNotificationPermission(vi.fn());
    stop();
    await settle();
    expect(status.addEventListener).not.toHaveBeenCalled();
    expect(status.count()).toBe(0);
  });

  it("a browser that rejects the query (or throws) is simply not watched", async () => {
    fakePermissions(async () => {
      throw new TypeError("notifications is not a valid permission name");
    });
    expect(() => watchNotificationPermission(vi.fn())()).not.toThrow();
    fakePermissions(() => {
      throw new TypeError("thrown synchronously");
    });
    expect(() => watchNotificationPermission(vi.fn())()).not.toThrow();
    await settle();
  });

  it("is a no-op without the Permissions API or outside a browser", () => {
    fakeBrowser();
    expect(() => watchNotificationPermission(vi.fn())()).not.toThrow();
    vi.stubGlobal("window", undefined);
    expect(() => watchNotificationPermission(vi.fn())()).not.toThrow();
  });
});

describe("client graph stays minimal (no server module reaches the browser bundle)", () => {
  // Every way a module can pull another one in (cycle D review minor 2 / cycle G review M6): `import … from` and
  // `export … from`, a side-effect `import "x"`, a dynamic `import("x")` and a `require("x")`.
  const IMPORT_FORMS = [
    /(?:^|\n)\s*(?:import|export)\b[^"';]*?from\s*["']([^"']+)["']/g,
    /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    /\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
  ];
  const specifiersOf = (source: string) => IMPORT_FORMS.flatMap((form) => [...source.matchAll(form)].map(([, specifier]) => specifier));

  it("the scanner sees every import form (a guard that missed side-effect or dynamic imports proved nothing)", () => {
    const source = [
      'import { a } from "./static";',
      'import type { B } from "@/types-only";',
      'export { c } from "./re-export";',
      'import "./side-effect";',
      "import './side-effect-single';",
      'const lazy = await import("./dynamic");',
      "const later = () => import( './dynamic-spaced' );",
      'const cjs = require("web-push");',
      "const tpl = require(`next/headers`);",
    ].join("\n");
    expect(specifiersOf(source).sort()).toEqual(
      ["./static", "@/types-only", "./re-export", "./side-effect", "./side-effect-single", "./dynamic", "./dynamic-spaced", "web-push", "next/headers"].sort()
    );
  });

  /** Every local module client.ts reaches through any import form, and every package import on the way. */
  function graph(entry: string) {
    const files = new Set<string>();
    const packages = new Set<string>();
    const visit = (file: string) => {
      if (files.has(file)) return;
      files.add(file);
      const source = readFileSync(join(process.cwd(), file), "utf8");
      for (const specifier of specifiersOf(source)) {
        if (!specifier.startsWith("@/") && !specifier.startsWith(".")) {
          packages.add(specifier);
          continue;
        }
        const base = specifier.startsWith("@/") ? `src/${specifier.slice(2)}` : join(file, "..", specifier).replace(/\\/g, "/");
        const resolved = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((candidate) => existsSync(join(process.cwd(), candidate)));
        expect(resolved, `${file} → ${specifier}`).toBeDefined();
        visit(resolved as string);
      }
    };
    visit(entry);
    return { files: [...files].sort(), packages: [...packages] };
  }

  it("client.ts reaches only the API wrapper, the install helpers and the locale list — and no package", () => {
    const { files, packages } = graph("src/lib/push/client.ts");
    expect(files).toEqual(["src/i18n/locales.ts", "src/lib/api.ts", "src/lib/install-prompt.ts", "src/lib/push/client.ts"]);
    expect(packages).toEqual([]);
  });

  it("never names the server-only push modules, the services, web-push or next/*", () => {
    const source = readFileSync(join(process.cwd(), "src/lib/push/client.ts"), "utf8");
    for (const forbidden of ["./endpoint", "./payload", "./schedule", "./config", "@/services", "web-push", "next/", "@/i18n/request"]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
