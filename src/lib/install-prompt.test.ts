import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type * as InstallPromptModule from "./install-prompt";

// Install prompt logic of the Notices page (spec 009 — criteria 2 and 3). The deferred event lives in a
// module-level store, so every test imports a fresh copy of the module. Node has no window: the fakes
// below stand in for it, and the "no window" cases double as the SSR checks.

let mod: typeof InstallPromptModule;

beforeEach(async () => {
  vi.resetModules();
  mod = await import("./install-prompt");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const DAY_MS = 86_400_000;
const NOW = new Date("2026-10-04T12:00:00Z");

function fakePromptEvent(outcome: "accepted" | "dismissed" = "accepted") {
  const event = new Event("beforeinstallprompt", { cancelable: true });
  return Object.assign(event, {
    prompt: vi.fn(() => Promise.resolve()),
    userChoice: Promise.resolve({ outcome, platform: "web" }),
  });
}

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

const throwingStorage = {
  getItem: () => {
    throw new DOMException("The operation is insecure.", "SecurityError");
  },
  setItem: () => {
    throw new DOMException("Quota exceeded.", "QuotaExceededError");
  },
};

describe("deferred install prompt store (criterion 2)", () => {
  it("starts with no deferred event, not installed, prompt not used", () => {
    expect(mod.getInstallPromptState()).toEqual({ deferredPrompt: null, installed: false, promptUsed: false });
  });

  it("captures beforeinstallprompt, keeps Chrome's own infobar away and notifies subscribers", () => {
    const target = new EventTarget();
    const listener = vi.fn();
    mod.subscribeInstallPrompt(listener);
    mod.startInstallPromptCapture(target);

    const event = fakePromptEvent();
    target.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(mod.getInstallPromptState().deferredPrompt).toBe(event);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("serves the initial state as the server snapshot, even after an early capture (no hydration mismatch)", () => {
    const initial = mod.getServerInstallPromptState();
    expect(initial).toEqual({ deferredPrompt: null, installed: false, promptUsed: false });
    expect(Object.isFrozen(initial)).toBe(true);
    const target = new EventTarget();
    mod.startInstallPromptCapture(target);
    target.dispatchEvent(fakePromptEvent());
    expect(mod.getInstallPromptState().deferredPrompt).not.toBeNull();
    expect(mod.getServerInstallPromptState()).toBe(initial);
  });

  it("returns the same snapshot until something changes (useSyncExternalStore-safe)", () => {
    const target = new EventTarget();
    mod.startInstallPromptCapture(target);
    const before = mod.getInstallPromptState();
    expect(mod.getInstallPromptState()).toBe(before);
    target.dispatchEvent(fakePromptEvent());
    const after = mod.getInstallPromptState();
    expect(after).not.toBe(before);
    expect(mod.getInstallPromptState()).toBe(after);
  });

  it("stops notifying after unsubscribe", () => {
    const target = new EventTarget();
    const listener = vi.fn();
    const unsubscribe = mod.subscribeInstallPrompt(listener);
    mod.startInstallPromptCapture(target);
    unsubscribe();
    target.dispatchEvent(fakePromptEvent());
    expect(listener).not.toHaveBeenCalled();
    expect(mod.getInstallPromptState().deferredPrompt).not.toBeNull();
  });

  it("appinstalled clears the deferred event and marks the app installed", () => {
    const target = new EventTarget();
    const listener = vi.fn();
    mod.startInstallPromptCapture(target);
    target.dispatchEvent(fakePromptEvent());
    mod.subscribeInstallPrompt(listener);

    target.dispatchEvent(new Event("appinstalled"));

    expect(mod.getInstallPromptState()).toEqual({ deferredPrompt: null, installed: true, promptUsed: false });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("the cleanup detaches the listeners but keeps an event already captured (a remount must not lose it)", () => {
    const target = new EventTarget();
    const stop = mod.startInstallPromptCapture(target);
    const first = fakePromptEvent();
    target.dispatchEvent(first);
    stop();

    const later = fakePromptEvent();
    target.dispatchEvent(later);
    target.dispatchEvent(new Event("appinstalled"));

    expect(later.defaultPrevented).toBe(false);
    expect(mod.getInstallPromptState()).toEqual({ deferredPrompt: first, installed: false, promptUsed: false });
  });

  it("listens on window by default", () => {
    const fakeWindow = new EventTarget();
    vi.stubGlobal("window", fakeWindow);
    mod.startInstallPromptCapture();
    const event = fakePromptEvent();
    fakeWindow.dispatchEvent(event);
    expect(mod.getInstallPromptState().deferredPrompt).toBe(event);
  });

  it("is a no-op without a window (server render)", () => {
    expect(typeof window).toBe("undefined");
    const stop = mod.startInstallPromptCapture();
    expect(() => stop()).not.toThrow();
    expect(mod.getInstallPromptState()).toEqual({ deferredPrompt: null, installed: false, promptUsed: false });
  });
});

// Final review, minor 3: on a slow phone Chromium can fire the one-time event before React mounts the capture. The
// root layout's inline script keeps it on the window until startInstallPromptCapture adopts it.
describe("early capture before hydration (root layout inline script)", () => {
  type EarlyWindow = EventTarget & { __hsBip?: Event; __hsInstalled?: boolean; __hsBipStop?: () => void };

  /** A window where the root layout's inline script already ran (as during HTML parsing). */
  function windowWithEarlyScript(): EarlyWindow {
    const fakeWindow: EarlyWindow = new EventTarget();
    new Function("window", mod.EARLY_INSTALL_CAPTURE_SCRIPT)(fakeWindow);
    return fakeWindow;
  }

  it("the script keeps an early beforeinstallprompt on the window, with Chrome's own infobar kept away", () => {
    const fakeWindow = windowWithEarlyScript();
    const event = fakePromptEvent();
    fakeWindow.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(fakeWindow.__hsBip).toBe(event);
    expect(mod.getInstallPromptState().deferredPrompt).toBeNull(); // the store is not running yet
  });

  it("startInstallPromptCapture adopts the early event and removes the globals", () => {
    const fakeWindow = windowWithEarlyScript();
    const event = fakePromptEvent();
    fakeWindow.dispatchEvent(event);
    const listener = vi.fn();
    mod.subscribeInstallPrompt(listener);

    mod.startInstallPromptCapture(fakeWindow);

    expect(mod.getInstallPromptState()).toEqual({ deferredPrompt: event, installed: false, promptUsed: false });
    expect(listener).toHaveBeenCalledTimes(1);
    for (const key of ["__hsBip", "__hsInstalled", "__hsBipStop"]) expect(key in fakeWindow).toBe(false);
  });

  it("no double handling: once adopted, a later event is handled by the store alone (the script's listener is gone)", () => {
    const fakeWindow = windowWithEarlyScript();
    fakeWindow.dispatchEvent(fakePromptEvent());
    mod.startInstallPromptCapture(fakeWindow);

    const later = fakePromptEvent();
    const preventDefault = vi.spyOn(later, "preventDefault");
    fakeWindow.dispatchEvent(later);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect("__hsBip" in fakeWindow).toBe(false);
    expect(mod.getInstallPromptState().deferredPrompt).toBe(later);
  });

  it("adopts once: a remount (cleanup, then a new start) does not bring back a prompt already used", async () => {
    const fakeWindow = windowWithEarlyScript();
    const event = fakePromptEvent();
    fakeWindow.dispatchEvent(event);
    const stop = mod.startInstallPromptCapture(fakeWindow);
    await mod.promptInstall();
    stop();

    mod.startInstallPromptCapture(fakeWindow);

    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(mod.getInstallPromptState()).toEqual({ deferredPrompt: null, installed: false, promptUsed: true });
  });

  it("an early appinstalled is adopted as installed, and the event it made obsolete is dropped", () => {
    const fakeWindow = windowWithEarlyScript();
    fakeWindow.dispatchEvent(fakePromptEvent());
    fakeWindow.dispatchEvent(new Event("appinstalled"));

    mod.startInstallPromptCapture(fakeWindow);

    expect(mod.getInstallPromptState()).toEqual({ deferredPrompt: null, installed: true, promptUsed: false });
    expect("__hsInstalled" in fakeWindow).toBe(false);
  });

  it("nothing captured early (or no script at all): the capture starts from the initial state", () => {
    const listener = vi.fn();
    mod.subscribeInstallPrompt(listener);
    mod.startInstallPromptCapture(windowWithEarlyScript());
    mod.startInstallPromptCapture(new EventTarget());

    expect(listener).not.toHaveBeenCalled();
    expect(mod.getInstallPromptState()).toEqual({ deferredPrompt: null, installed: false, promptUsed: false });
  });

  it("SSR-safe: the script is a plain string, read without touching any window", () => {
    expect(typeof window).toBe("undefined");
    expect(typeof mod.EARLY_INSTALL_CAPTURE_SCRIPT).toBe("string");
    expect(mod.EARLY_INSTALL_CAPTURE_SCRIPT).toContain('"beforeinstallprompt"');
  });
});

describe("promptInstall (criterion 2)", () => {
  it("calls the deferred prompt() and resolves with the visitor's choice", async () => {
    const target = new EventTarget();
    mod.startInstallPromptCapture(target);
    const event = fakePromptEvent("accepted");
    target.dispatchEvent(event);

    await expect(mod.promptInstall()).resolves.toBe("accepted");
    expect(event.prompt).toHaveBeenCalledTimes(1);
  });

  it("reports a dismissed native dialog", async () => {
    const target = new EventTarget();
    mod.startInstallPromptCapture(target);
    target.dispatchEvent(fakePromptEvent("dismissed"));
    await expect(mod.promptInstall()).resolves.toBe("dismissed");
  });

  it("uses the event once: it leaves the store as soon as prompt() is called", async () => {
    const target = new EventTarget();
    mod.startInstallPromptCapture(target);
    const event = fakePromptEvent();
    target.dispatchEvent(event);
    const listener = vi.fn();
    mod.subscribeInstallPrompt(listener);

    const pending = mod.promptInstall();
    expect(mod.getInstallPromptState().deferredPrompt).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    await pending;

    await expect(mod.promptInstall()).resolves.toBe("unavailable");
    expect(event.prompt).toHaveBeenCalledTimes(1);
  });

  it("is 'unavailable' when no event was captured", async () => {
    await expect(mod.promptInstall()).resolves.toBe("unavailable");
  });

  it("never rejects: a prompt() that throws resolves 'unavailable' and the event is gone", async () => {
    const target = new EventTarget();
    mod.startInstallPromptCapture(target);
    const event = fakePromptEvent();
    event.prompt.mockImplementation(() => Promise.reject(new DOMException("No user activation.", "NotAllowedError")));
    target.dispatchEvent(event);

    await expect(mod.promptInstall()).resolves.toBe("unavailable");
    expect(mod.getInstallPromptState().deferredPrompt).toBeNull();
  });
});

describe("promptUsed (the one-time prompt is spent: 'no prompt right now' is not 'can't install')", () => {
  it.each(["accepted", "dismissed"] as const)("is set as soon as the event is used (%s)", async (outcome) => {
    const target = new EventTarget();
    mod.startInstallPromptCapture(target);
    target.dispatchEvent(fakePromptEvent(outcome));
    expect(mod.getInstallPromptState().promptUsed).toBe(false);

    const pending = mod.promptInstall();
    expect(mod.getInstallPromptState()).toEqual({ deferredPrompt: null, installed: false, promptUsed: true });
    await pending;
    expect(mod.getInstallPromptState().promptUsed).toBe(true);
  });

  it("is set by an 'unavailable' outcome with no event, notifying once (the same state twice is no change)", async () => {
    const listener = vi.fn();
    mod.subscribeInstallPrompt(listener);
    await expect(mod.promptInstall()).resolves.toBe("unavailable");
    expect(mod.getInstallPromptState()).toEqual({ deferredPrompt: null, installed: false, promptUsed: true });
    await mod.promptInstall();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("is cleared when the browser offers a new beforeinstallprompt", async () => {
    const target = new EventTarget();
    mod.startInstallPromptCapture(target);
    target.dispatchEvent(fakePromptEvent());
    await mod.promptInstall();
    const fresh = fakePromptEvent();
    target.dispatchEvent(fresh);
    expect(mod.getInstallPromptState()).toEqual({ deferredPrompt: fresh, installed: false, promptUsed: false });
  });

  it("survives appinstalled (installed wins in the UI anyway)", async () => {
    const target = new EventTarget();
    mod.startInstallPromptCapture(target);
    target.dispatchEvent(fakePromptEvent());
    await mod.promptInstall();
    target.dispatchEvent(new Event("appinstalled"));
    expect(mod.getInstallPromptState()).toEqual({ deferredPrompt: null, installed: true, promptUsed: true });
  });

  it("the server snapshot never reports it", () => {
    expect(mod.getServerInstallPromptState().promptUsed).toBe(false);
  });
});

describe("isIos (criterion 3)", () => {
  const UA = {
    iphoneSafari:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
    iphoneChrome:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0.7204.156 Mobile/15E148 Safari/604.1",
    ipadMobileSite:
      "Mozilla/5.0 (iPad; CPU OS 12_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1",
    ipod: "Mozilla/5.0 (iPod touch; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1",
    // iPadOS 13+ Safari requests the desktop site and reports a Mac.
    macintosh:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15",
    androidChrome:
      "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36",
    windowsChrome:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0",
  };

  it("recognizes iPhone, iPad and iPod user agents", () => {
    expect(mod.isIos(UA.iphoneSafari, 5)).toBe(true);
    expect(mod.isIos(UA.ipadMobileSite, 5)).toBe(true);
    expect(mod.isIos(UA.ipod, 5)).toBe(true);
  });

  it("counts other iOS browsers too (none of them fire beforeinstallprompt)", () => {
    expect(mod.isIos(UA.iphoneChrome, 5)).toBe(true);
  });

  it("recognizes iPadOS reporting 'Macintosh' by its touch screen", () => {
    expect(mod.isIos(UA.macintosh, 5)).toBe(true);
  });

  it("does not take a real Mac (no touch points) for an iPad", () => {
    expect(mod.isIos(UA.macintosh, 0)).toBe(false);
    expect(mod.isIos(UA.macintosh, 1)).toBe(false);
  });

  it("rejects Android and desktop browsers, even with a touch screen", () => {
    expect(mod.isIos(UA.androidChrome, 5)).toBe(false);
    expect(mod.isIos(UA.windowsChrome, 10)).toBe(false);
    expect(mod.isIos(UA.windowsChrome, 0)).toBe(false);
  });
});

describe("isStandalone (criterion 3)", () => {
  const media = (standalone: boolean) => vi.fn((query: string) => ({ matches: standalone && query === "(display-mode: standalone)" }));

  it("is true when the display-mode media query says standalone (installed app)", () => {
    const matchMedia = media(true);
    expect(mod.isStandalone({ matchMedia, navigator: {} })).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith("(display-mode: standalone)");
  });

  it("is true for an iOS home-screen app (navigator.standalone)", () => {
    expect(mod.isStandalone({ matchMedia: media(false), navigator: { standalone: true } })).toBe(true);
  });

  it("is false in a browser tab", () => {
    expect(mod.isStandalone({ matchMedia: media(false), navigator: { standalone: false } })).toBe(false);
    expect(mod.isStandalone({ matchMedia: media(false), navigator: {} })).toBe(false);
  });

  it("is false without matchMedia or navigator, and when matchMedia throws", () => {
    expect(mod.isStandalone({})).toBe(false);
    const matchMedia = () => {
      throw new Error("not supported");
    };
    expect(mod.isStandalone({ matchMedia, navigator: {} })).toBe(false);
    expect(mod.isStandalone({ matchMedia, navigator: { standalone: true } })).toBe(true);
  });

  it("reads window by default, and is false without one (server render)", () => {
    expect(mod.isStandalone()).toBe(false);
    vi.stubGlobal("window", { matchMedia: media(true), navigator: {} });
    expect(mod.isStandalone()).toBe(true);
  });
});

describe("'Not now' dismissal (criterion 2)", () => {
  it("stores the end of the 30-day window under homeshare.installDismissedUntil", () => {
    const storage = memoryStorage();
    mod.dismissInstall(NOW, storage);
    expect(mod.INSTALL_DISMISSED_KEY).toBe("homeshare.installDismissedUntil");
    expect(storage.data.get("homeshare.installDismissedUntil")).toBe(String(NOW.getTime() + 30 * DAY_MS));
  });

  it("hides the banner for 30 days: still dismissed after 29, shown again after 31", () => {
    const storage = memoryStorage();
    mod.dismissInstall(NOW, storage);
    expect(mod.isInstallDismissed(NOW, storage)).toBe(true);
    expect(mod.isInstallDismissed(new Date(NOW.getTime() + 29 * DAY_MS), storage)).toBe(true);
    expect(mod.isInstallDismissed(new Date(NOW.getTime() + 30 * DAY_MS), storage)).toBe(false);
    expect(mod.isInstallDismissed(new Date(NOW.getTime() + 31 * DAY_MS), storage)).toBe(false);
  });

  it("ignores a stamp further away than the 30-day window (a wrong clock must not hide the banner for years)", () => {
    const at = (ms: number) => memoryStorage({ "homeshare.installDismissedUntil": String(NOW.getTime() + ms) });
    expect(mod.isInstallDismissed(NOW, at(30 * DAY_MS))).toBe(true);
    expect(mod.isInstallDismissed(NOW, at(30 * DAY_MS + 1))).toBe(false);
    expect(mod.isInstallDismissed(NOW, at(10 * 365 * DAY_MS))).toBe(false);
  });

  it("is not dismissed when nothing (or garbage) is stored", () => {
    expect(mod.isInstallDismissed(NOW, memoryStorage())).toBe(false);
    expect(mod.isInstallDismissed(NOW, memoryStorage({ "homeshare.installDismissedUntil": "soon" }))).toBe(false);
    expect(mod.isInstallDismissed(NOW, memoryStorage({ "homeshare.installDismissedUntil": "" }))).toBe(false);
  });

  it("survives a storage that throws: never dismissed, and dismissing does not throw", () => {
    expect(mod.isInstallDismissed(NOW, throwingStorage)).toBe(false);
    expect(() => mod.dismissInstall(NOW, throwingStorage)).not.toThrow();
  });

  it("uses window.localStorage by default", () => {
    const storage = memoryStorage();
    vi.stubGlobal("window", { localStorage: storage });
    mod.dismissInstall(NOW);
    expect(mod.isInstallDismissed(new Date(NOW.getTime() + DAY_MS))).toBe(true);
    expect(storage.data.has("homeshare.installDismissedUntil")).toBe(true);
  });

  it("survives a blocked localStorage (the getter itself throws, e.g. storage disabled)", () => {
    const blocked = {};
    Object.defineProperty(blocked, "localStorage", {
      get() {
        throw new DOMException("Access is denied for this document.", "SecurityError");
      },
    });
    vi.stubGlobal("window", blocked);
    expect(() => mod.dismissInstall(NOW)).not.toThrow();
    expect(mod.isInstallDismissed(NOW)).toBe(false);
  });

  it("is a no-op without a window (server render)", () => {
    expect(() => mod.dismissInstall(NOW)).not.toThrow();
    expect(mod.isInstallDismissed(NOW)).toBe(false);
  });
});
