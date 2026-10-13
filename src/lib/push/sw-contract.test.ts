import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

// Contract of the push-only service worker (spec 010 — criterion 2, ADR 0011). public/sw.js is plain JS served as
// is (no build step), so it is read as text and run in a fake worker global (node:vm): `self` with the clients,
// registration and fetch APIs as spies, `caches` and `onfetch` as traps. Each test dispatches real-shaped events and
// asserts what the worker does with them.

const SOURCE = readFileSync(join(process.cwd(), "public/sw.js"), "utf8");
const ORIGIN = "https://homeshare.test";
const ICON = "/icons/icon-192.png";
const CENTER = `${ORIGIN}/notifications`;
const HOUSE = "0192f0c4-0000-7000-8000-00000000abcd";

/** Code without comments, for token checks (the header comment may name what the worker must not do). */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

type Listener = (event: Record<string, unknown>) => void;

interface FakeClient {
  url: string;
  focus: ReturnType<typeof vi.fn>;
  navigate: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
}

function windowClient(url: string, order: string[] = []): FakeClient {
  const client: FakeClient = {
    url,
    focus: vi.fn(async () => {
      order.push("focus");
      return client;
    }),
    navigate: vi.fn(async (to: string) => {
      order.push(`navigate ${to}`);
      return { ...client, url: to };
    }),
    postMessage: vi.fn(() => order.push("message")),
  };
  return client;
}

/** Runs public/sw.js in a fresh fake worker global, loaded from `scriptUrl` (the registrar adds ?k=<VAPID key>). */
function loadWorker(windows: FakeClient[] = [], scriptUrl = `${ORIGIN}/sw.js`) {
  const listeners = new Map<string, Listener[]>();
  const trapped: string[] = [];
  const order: string[] = [];
  const env: Record<string, unknown> = {
    location: new URL(scriptUrl),
    URL,
    atob,
    addEventListener: (type: string, listener: Listener) => listeners.set(type, [...(listeners.get(type) ?? []), listener]),
    skipWaiting: vi.fn(async () => undefined),
    clients: {
      claim: vi.fn(async () => undefined),
      matchAll: vi.fn(async () => windows),
      openWindow: vi.fn(async () => null),
    },
    registration: {
      showNotification: vi.fn(async () => {
        order.push("show");
      }),
      pushManager: { subscribe: vi.fn() },
    },
    fetch: vi.fn(async () => new Response(null, { status: 201 })),
  };
  Object.defineProperty(env, "caches", {
    get() {
      trapped.push("caches");
      return undefined;
    },
  });
  Object.defineProperty(env, "onfetch", {
    get: () => null,
    set() {
      trapped.push("onfetch");
    },
  });
  env.self = env;
  vm.createContext(env);
  new vm.Script(SOURCE, { filename: "public/sw.js" }).runInContext(env);

  /** Fires `type` like the browser: listeners run synchronously; the promises they pass to waitUntil are awaited. */
  async function dispatch(type: string, fields: Record<string, unknown> = {}) {
    const pending: Promise<unknown>[] = [];
    const event = { ...fields, waitUntil: (promise: unknown) => pending.push(Promise.resolve(promise)) };
    for (const listener of listeners.get(type) ?? []) listener(event);
    const waited = pending.length; // waitUntil must be called during the dispatch, not after an await
    await Promise.all(pending);
    return { waited };
  }

  const clients = env.clients as { claim: ReturnType<typeof vi.fn>; matchAll: ReturnType<typeof vi.fn>; openWindow: ReturnType<typeof vi.fn> };
  const registration = env.registration as {
    showNotification: ReturnType<typeof vi.fn>;
    pushManager: { subscribe: ReturnType<typeof vi.fn> };
  };
  const worker = {
    listeners,
    trapped,
    order,
    dispatch,
    clients,
    registration,
    skipWaiting: env.skipWaiting as ReturnType<typeof vi.fn>,
    fetch: env.fetch as ReturnType<typeof vi.fn>,
  };
  current = worker;
  return worker;
}

let current: ReturnType<typeof loadWorker> | null = null;

// Whatever a test made the worker do, it never touched the Cache API or set a fetch handler.
afterEach(() => {
  expect(current?.trapped ?? []).toEqual([]);
  current = null;
});

/** A PushMessageData whose json() parses like the browser's (throws on invalid JSON). */
const pushData = (text: string) => ({ text: () => text, json: () => JSON.parse(text) });
const push = (payload: unknown) => ({ data: pushData(JSON.stringify(payload)) });

/** The [title, options] of the only notification shown, options as a plain object. */
function shown(worker: ReturnType<typeof loadWorker>): [string, Record<string, unknown>] {
  expect(worker.registration.showNotification).toHaveBeenCalledTimes(1);
  const [title, options] = worker.registration.showNotification.mock.calls[0] as [string, Record<string, unknown>];
  return [title, JSON.parse(JSON.stringify(options))];
}

const UNSAFE_URLS = [
  "https://evil.test/expenses",
  "//evil.test/expenses",
  "/\\evil.test/expenses",
  "http://homeshare.test/expenses",
  "javascript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  // A blob: URL's origin is its inner origin: same origin, other protocol.
  "blob:https://homeshare.test/9f8e7d6c-0000-4000-8000-000000000000",
];

describe("public/sw.js — static contract (spec 010 — criterion 2)", () => {
  it("is a plain classic script: no import/export and no importScripts", () => {
    expect(CODE).not.toMatch(/^\s*(?:import|export)\b/m);
    expect(CODE).not.toMatch(/\bimportScripts\b/);
    expect(() => loadWorker()).not.toThrow();
  });

  it("registers no fetch handler, in any form", () => {
    expect(SOURCE).not.toMatch(/addEventListener\(\s*["'`]fetch["'`]/);
    expect(SOURCE).not.toMatch(/\bonfetch\b/);
  });

  it("never uses the Cache API", () => {
    expect(CODE).not.toMatch(/\bcaches\b/);
  });

  it("listens to exactly install, activate, push, notificationclick and pushsubscriptionchange", () => {
    const worker = loadWorker();
    expect([...worker.listeners.keys()].sort()).toEqual(["activate", "install", "notificationclick", "push", "pushsubscriptionchange"]);
  });
});

describe("lifecycle: an update takes over at once (no cache can strand an old version)", () => {
  it("install → skipWaiting()", async () => {
    const worker = loadWorker();
    await worker.dispatch("install");
    expect(worker.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it("activate → clients.claim() inside waitUntil", async () => {
    const worker = loadWorker();
    const { waited } = await worker.dispatch("activate");
    expect(worker.clients.claim).toHaveBeenCalledTimes(1);
    expect(waited).toBe(1);
  });
});

describe("push → one notification per push (spec 010 — criteria 2, 6)", () => {
  const PAYLOAD = { title: "Casa Bolitas", body: "Bruno added “Electricity”", url: `/expenses?house=${HOUSE}`, tag: `EXPENSE_NEW:${HOUSE}` };

  it("shows the payload's title and body with its tag, the app icon and the url to open, inside waitUntil", async () => {
    const worker = loadWorker();
    const { waited } = await worker.dispatch("push", push(PAYLOAD));

    expect(waited).toBe(1);
    expect(shown(worker)).toEqual([
      "Casa Bolitas",
      { body: PAYLOAD.body, tag: PAYLOAD.tag, renotify: true, icon: ICON, badge: ICON, data: { url: `${ORIGIN}/expenses?house=${HOUSE}` } },
    ]);
  });

  it("then tells every open app window (the bell refreshes), only after the notification is shown", async () => {
    const order: string[] = [];
    const windows = [windowClient(`${ORIGIN}/expenses`, order), windowClient(`${ORIGIN}/balances`, order)];
    const worker = loadWorker(windows);
    worker.registration.showNotification.mockImplementation(async () => {
      order.push("show");
    });
    await worker.dispatch("push", push(PAYLOAD));

    expect(order).toEqual(["show", "message", "message"]);
    for (const client of windows) expect(JSON.parse(JSON.stringify(client.postMessage.mock.calls[0][0]))).toEqual({ type: "push" });
    expect(JSON.parse(JSON.stringify(worker.clients.matchAll.mock.calls[0][0]))).toEqual({ type: "window", includeUncontrolled: true });
  });

  it("a window that cannot take the message never fails the push event", async () => {
    const broken = windowClient(`${ORIGIN}/expenses`);
    broken.postMessage.mockImplementation(() => {
      throw new Error("closing");
    });
    const worker = loadWorker([broken]);
    await expect(worker.dispatch("push", push(PAYLOAD))).resolves.toEqual({ waited: 1 });
  });

  it.each([
    ["no data", { data: null }],
    ["a body that is not JSON", { data: pushData("not json") }],
    ["JSON null", { data: pushData("null") }],
    ["a JSON string", { data: pushData('"hello"') }],
    ["a JSON array", { data: pushData('[{"title":"x"}]') }],
    ["fields of the wrong type", push({ title: 5, body: { a: 1 }, url: 7, tag: ["x"] })],
    ["a blank title and empty strings", push({ title: "   ", body: "", url: "", tag: "" })],
  ])("still shows a generic notification for %s (iOS requires one for every push)", async (_label, event) => {
    const worker = loadWorker();
    await worker.dispatch("push", event);

    const [title, options] = shown(worker);
    expect(title).toBe("Home Share");
    expect(options).toEqual({ icon: ICON, badge: ICON, data: { url: CENTER } });
    expect(Object.keys(options).sort()).toEqual(["badge", "data", "icon"]); // no body, no tag
  });

  it("keeps the payload's text when only the url is missing (opens the notification center)", async () => {
    const worker = loadWorker();
    await worker.dispatch("push", push({ title: "Casa", body: "Text", tag: "TEST" }));
    expect(shown(worker)).toEqual(["Casa", { body: "Text", tag: "TEST", renotify: true, icon: ICON, badge: ICON, data: { url: CENTER } }]);
  });

  it.each(UNSAFE_URLS)("never stores another origin's url (%s): the notification opens the center instead", async (url) => {
    const worker = loadWorker();
    await worker.dispatch("push", push({ ...PAYLOAD, url }));
    expect(shown(worker)[1].data).toEqual({ url: CENTER });
  });

  it.each([
    ["/balances?house=abc#settle", `${ORIGIN}/balances?house=abc#settle`],
    [`${ORIGIN}/recurring?house=abc`, `${ORIGIN}/recurring?house=abc`],
    ["/notifications", CENTER],
  ])("keeps a same-origin url (%s) with its query and hash", async (url, expected) => {
    const worker = loadWorker();
    await worker.dispatch("push", push({ ...PAYLOAD, url }));
    expect(shown(worker)[1].data).toEqual({ url: expected });
  });
});

describe("notificationclick → focus an open app window or open one (spec 010 — criteria 2, 12)", () => {
  const click = (url: unknown, close = vi.fn()) => ({ notification: { close, data: url === undefined ? undefined : { url } } });
  const TARGET = `${ORIGIN}/expenses?house=${HOUSE}`;

  it("closes the notification, focuses the open window and navigates it to the url, inside waitUntil", async () => {
    const order: string[] = [];
    const client = windowClient(`${ORIGIN}/balances`, order);
    const worker = loadWorker([client]);
    const close = vi.fn();
    const { waited } = await worker.dispatch("notificationclick", click(TARGET, close));

    expect(close).toHaveBeenCalledTimes(1);
    expect(waited).toBe(1);
    expect(order).toEqual(["focus", `navigate ${TARGET}`]);
    expect(worker.clients.openWindow).not.toHaveBeenCalled();
    expect(JSON.parse(JSON.stringify(worker.clients.matchAll.mock.calls[0][0]))).toEqual({ type: "window", includeUncontrolled: true });
  });

  it("opens a new window at the url when no app window is open", async () => {
    const worker = loadWorker([]);
    await worker.dispatch("notificationclick", click(TARGET));
    expect(worker.clients.openWindow).toHaveBeenCalledWith(TARGET);
  });

  it("opens a new window when the open one cannot be navigated (not controlled by this worker)", async () => {
    const client = windowClient(`${ORIGIN}/balances`);
    client.navigate.mockRejectedValue(new TypeError("not controlled"));
    const worker = loadWorker([client]);
    await worker.dispatch("notificationclick", click(TARGET));
    expect(worker.clients.openWindow).toHaveBeenCalledWith(TARGET);
  });

  it("never reuses a window of another origin", async () => {
    const foreign = windowClient("https://evil.test/");
    const worker = loadWorker([foreign]);
    await worker.dispatch("notificationclick", click(TARGET));

    expect(foreign.focus).not.toHaveBeenCalled();
    expect(foreign.navigate).not.toHaveBeenCalled();
    expect(worker.clients.openWindow).toHaveBeenCalledWith(TARGET);
  });

  it.each(UNSAFE_URLS)("never opens another origin's url (%s): it opens the notification center", async (url) => {
    const client = windowClient(`${ORIGIN}/expenses`);
    const worker = loadWorker([client]);
    await worker.dispatch("notificationclick", click(url));

    expect(client.navigate).toHaveBeenCalledWith(CENTER);
    expect(worker.clients.openWindow).not.toHaveBeenCalled();
  });

  it.each([
    ["no data", click(undefined)],
    ["data without a url", { notification: { close: vi.fn(), data: {} } }],
    ["a non-string url", click(42)],
  ])("opens the notification center for a notification with %s", async (_label, event) => {
    const worker = loadWorker([]);
    await worker.dispatch("notificationclick", event);
    expect(worker.clients.openWindow).toHaveBeenCalledWith(CENTER);
  });
});

describe("pushsubscriptionchange → subscribe again and store it (spec 010 — criteria 3, 8)", () => {
  const KEY = new Uint8Array([4, 1, 2, 3]).buffer;
  const NEW = { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/new", expirationTime: null, keys: { p256dh: "P256", auth: "AUTH" } };
  const subscription = (json: typeof NEW) => ({ toJSON: () => json });
  const change = (fields: Record<string, unknown>) => ({ oldSubscription: null, newSubscription: null, ...fields });

  /** The single POST the worker sent: [url, init] with the JSON body parsed. */
  function posted(worker: ReturnType<typeof loadWorker>) {
    expect(worker.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = worker.fetch.mock.calls[0] as [string, RequestInit];
    return { url, init: JSON.parse(JSON.stringify({ ...init, body: undefined })), body: JSON.parse(init.body as string) };
  }

  it("re-subscribes with the old subscription's VAPID key (userVisibleOnly) and POSTs it same-origin, without a locale", async () => {
    const worker = loadWorker();
    worker.registration.pushManager.subscribe.mockResolvedValue(subscription(NEW));
    const { waited } = await worker.dispatch("pushsubscriptionchange", change({ oldSubscription: { options: { applicationServerKey: KEY } } }));

    expect(waited).toBe(1);
    const options = worker.registration.pushManager.subscribe.mock.calls[0][0];
    expect(options.userVisibleOnly).toBe(true);
    expect(options.applicationServerKey).toBe(KEY);

    const { url, init, body } = posted(worker);
    expect(url).toBe("/api/push-subscriptions");
    expect(init).toEqual({ method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" } });
    // The worker cannot know the app's locale: the server keeps a known row's and a new row takes the default.
    expect(body).toEqual({ endpoint: NEW.endpoint, keys: NEW.keys });
  });

  it("uses the browser's new subscription when the event carries one (no second subscribe)", async () => {
    const worker = loadWorker();
    await worker.dispatch("pushsubscriptionchange", change({ newSubscription: subscription(NEW) }));

    expect(worker.registration.pushManager.subscribe).not.toHaveBeenCalled();
    expect(posted(worker).body).toEqual({ endpoint: NEW.endpoint, keys: NEW.keys });
  });

  it("does nothing without a new subscription or an old key to subscribe with", async () => {
    const worker = loadWorker();
    await worker.dispatch("pushsubscriptionchange", change({ oldSubscription: { options: {} } }));
    await worker.dispatch("pushsubscriptionchange", change({}));

    expect(worker.registration.pushManager.subscribe).not.toHaveBeenCalled();
    expect(worker.fetch).not.toHaveBeenCalled();
  });

  it("is best effort: a refused subscribe or a failed POST never rejects the event", async () => {
    const worker = loadWorker();
    worker.registration.pushManager.subscribe.mockRejectedValue(new Error("permission revoked"));
    await expect(
      worker.dispatch("pushsubscriptionchange", change({ oldSubscription: { options: { applicationServerKey: KEY } } }))
    ).resolves.toEqual({ waited: 1 });
    expect(worker.fetch).not.toHaveBeenCalled();

    worker.fetch.mockRejectedValue(new TypeError("offline"));
    await expect(worker.dispatch("pushsubscriptionchange", change({ newSubscription: subscription(NEW) }))).resolves.toEqual({ waited: 1 });
  });

  // Firefox can fire the event with no oldSubscription, so there is no old key to reuse. The registrar registers the
  // worker as /sw.js?k=<NEXT_PUBLIC_VAPID_PUBLIC_KEY> (cycle C review, minor 3): the worker reads the key from its URL.
  describe("without an old key: the VAPID key in the worker's own URL (/sw.js?k=<key>)", () => {
    const KEY_BYTES = Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : (i + 98) % 256));
    const PUBLIC_KEY = Buffer.from(KEY_BYTES).toString("base64url");
    const registeredAs = (key: string) => `${ORIGIN}/sw.js?k=${encodeURIComponent(key)}`;
    const bytesOf = (value: unknown) => {
      expect(Object.prototype.toString.call(value)).toBe("[object Uint8Array]");
      return Array.from(value as Uint8Array);
    };

    it("the test key covers both base64url-only characters (- and _)", () => {
      expect(PUBLIC_KEY).toHaveLength(87);
      expect(PUBLIC_KEY).toMatch(/-/);
      expect(PUBLIC_KEY).toMatch(/_/);
    });

    it("re-subscribes with the URL's key decoded to bytes (userVisibleOnly) and POSTs it, without a locale", async () => {
      const worker = loadWorker([], registeredAs(PUBLIC_KEY));
      worker.registration.pushManager.subscribe.mockResolvedValue(subscription(NEW));
      const { waited } = await worker.dispatch("pushsubscriptionchange", change({}));

      expect(waited).toBe(1);
      expect(worker.registration.pushManager.subscribe).toHaveBeenCalledTimes(1);
      const options = worker.registration.pushManager.subscribe.mock.calls[0][0];
      expect(options.userVisibleOnly).toBe(true);
      expect(bytesOf(options.applicationServerKey)).toEqual(Array.from(KEY_BYTES));
      expect(posted(worker).body).toEqual({ endpoint: NEW.endpoint, keys: NEW.keys });
    });

    it("also when the old subscription exposes no key", async () => {
      const worker = loadWorker([], registeredAs(PUBLIC_KEY));
      worker.registration.pushManager.subscribe.mockResolvedValue(subscription(NEW));
      await worker.dispatch("pushsubscriptionchange", change({ oldSubscription: { options: { applicationServerKey: null } } }));

      expect(bytesOf(worker.registration.pushManager.subscribe.mock.calls[0][0].applicationServerKey)).toEqual(Array.from(KEY_BYTES));
      expect(posted(worker).body).toEqual({ endpoint: NEW.endpoint, keys: NEW.keys });
    });

    it("the old subscription's key still wins when the event carries one", async () => {
      const worker = loadWorker([], registeredAs(PUBLIC_KEY));
      worker.registration.pushManager.subscribe.mockResolvedValue(subscription(NEW));
      await worker.dispatch("pushsubscriptionchange", change({ oldSubscription: { options: { applicationServerKey: KEY } } }));

      expect(worker.registration.pushManager.subscribe.mock.calls[0][0].applicationServerKey).toBe(KEY);
    });

    it("the browser's new subscription still wins over both (no subscribe at all)", async () => {
      const worker = loadWorker([], registeredAs(PUBLIC_KEY));
      await worker.dispatch("pushsubscriptionchange", change({ newSubscription: subscription(NEW) }));

      expect(worker.registration.pushManager.subscribe).not.toHaveBeenCalled();
      expect(posted(worker).body).toEqual({ endpoint: NEW.endpoint, keys: NEW.keys });
    });

    it.each([
      ["an empty key", `${ORIGIN}/sw.js?k=`],
      ["a key outside base64url", `${ORIGIN}/sw.js?k=${encodeURIComponent("not base64url!")}`],
      ["a standard-base64 key (+ and /)", `${ORIGIN}/sw.js?k=${encodeURIComponent("ab+c/d")}`],
      ["a key of impossible length", `${ORIGIN}/sw.js?k=abcde`],
      ["another parameter only", `${ORIGIN}/sw.js?key=${PUBLIC_KEY}`],
    ])("does nothing with %s: no subscribe, no POST", async (_label, scriptUrl) => {
      const worker = loadWorker([], scriptUrl);
      await expect(worker.dispatch("pushsubscriptionchange", change({}))).resolves.toEqual({ waited: 1 });

      expect(worker.registration.pushManager.subscribe).not.toHaveBeenCalled();
      expect(worker.fetch).not.toHaveBeenCalled();
    });

    it("is best effort: a key the browser refuses never rejects the event", async () => {
      const worker = loadWorker([], registeredAs(PUBLIC_KEY));
      worker.registration.pushManager.subscribe.mockRejectedValue(new DOMException("bad key", "InvalidAccessError"));
      await expect(worker.dispatch("pushsubscriptionchange", change({}))).resolves.toEqual({ waited: 1 });
      expect(worker.fetch).not.toHaveBeenCalled();
    });
  });
});
