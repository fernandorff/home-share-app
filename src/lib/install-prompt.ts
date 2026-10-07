// Install prompt logic of the Notices page (spec 009 — criteria 2 and 3). Framework-agnostic and safe to
// import on the server: `window` is only read inside the functions, never at import time.

/** Chromium's `beforeinstallprompt` event (not in the DOM typings). */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

export interface InstallPromptState {
  /** The deferred event while the browser offers an install; single use. */
  deferredPrompt: BeforeInstallPromptEvent | null;
  /** `appinstalled` fired during this page's life. */
  installed: boolean;
  /**
   * The one-time prompt was used (or came back unavailable) and the browser has not offered a new one: the app
   * is still installable (browser menu), just not from a button here — not "this browser can't install".
   */
  promptUsed: boolean;
}

export type InstallOutcome = "accepted" | "dismissed" | "unavailable";

const INITIAL_STATE: InstallPromptState = Object.freeze({ deferredPrompt: null, installed: false, promptUsed: false });

let state = INITIAL_STATE;
const listeners = new Set<() => void>();

function setState(next: InstallPromptState): void {
  if (next.deferredPrompt === state.deferredPrompt && next.installed === state.installed && next.promptUsed === state.promptUsed) {
    return;
  }
  state = Object.freeze(next);
  listeners.forEach((listener) => listener());
}

/** Current state; the same object until it changes (usable as a `useSyncExternalStore` snapshot). */
export function getInstallPromptState(): InstallPromptState {
  return state;
}

/**
 * The state a server render (and hydration) sees: always the initial one, whatever the client store already
 * captured — `useSyncExternalStore`'s getServerSnapshot, so an early capture never causes a hydration mismatch.
 */
export function getServerInstallPromptState(): InstallPromptState {
  return INITIAL_STATE;
}

export function subscribeInstallPrompt(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Inline script of the root layout, run while the HTML is parsed — before hydration. On a slow phone Chromium can
 * fire the one-time `beforeinstallprompt` before React mounts InstallPromptCapture, and the event would be lost: the
 * script keeps it on `window.__hsBip` (an early `appinstalled` as `window.__hsInstalled`) until
 * startInstallPromptCapture adopts it, detaches these listeners (`window.__hsBipStop`) and removes the globals.
 */
export const EARLY_INSTALL_CAPTURE_SCRIPT = `(function(w){function b(e){e.preventDefault();w.__hsBip=e}function a(){w.__hsInstalled=true}w.addEventListener("beforeinstallprompt",b);w.addEventListener("appinstalled",a);w.__hsBipStop=function(){w.removeEventListener("beforeinstallprompt",b);w.removeEventListener("appinstalled",a)}})(window)`;

/** What EARLY_INSTALL_CAPTURE_SCRIPT leaves on the window. */
interface EarlyCapture {
  __hsBip?: BeforeInstallPromptEvent;
  __hsInstalled?: boolean;
  __hsBipStop?: () => void;
}

/** Takes over what the inline script caught before hydration — once: the globals and its listeners go away. */
function adoptEarlyCapture(target: EventTarget): void {
  const early = target as EventTarget & EarlyCapture;
  const { __hsBip: event, __hsInstalled: installed } = early;
  early.__hsBipStop?.();
  delete early.__hsBip;
  delete early.__hsInstalled;
  delete early.__hsBipStop;
  if (installed) setState({ deferredPrompt: null, installed: true, promptUsed: state.promptUsed });
  else if (event) setState({ deferredPrompt: event, installed: false, promptUsed: false });
}

/**
 * Captures `beforeinstallprompt` and `appinstalled` on `target` (window by default). Meant to be started
 * once from the app layout, so the event — fired once, early — is not lost before /notifications mounts; an event
 * the root layout's inline script caught before hydration is adopted here.
 * The returned cleanup only detaches the listeners: an event already captured stays in the store.
 */
export function startInstallPromptCapture(target?: EventTarget): () => void {
  const eventTarget = target ?? (typeof window === "undefined" ? undefined : window);
  if (!eventTarget) return () => {};

  const onBeforeInstallPrompt = (event: Event) => {
    // Keeps Chrome's own mini-infobar away: the Notices banner offers the install instead.
    event.preventDefault();
    setState({ deferredPrompt: event as BeforeInstallPromptEvent, installed: false, promptUsed: false });
  };
  const onAppInstalled = () => setState({ deferredPrompt: null, installed: true, promptUsed: state.promptUsed });

  eventTarget.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
  eventTarget.addEventListener("appinstalled", onAppInstalled);
  adoptEarlyCapture(eventTarget);
  return () => {
    eventTarget.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    eventTarget.removeEventListener("appinstalled", onAppInstalled);
  };
}

/** Shows the browser's install dialog from the deferred event. Never rejects. */
export async function promptInstall(): Promise<InstallOutcome> {
  const event = state.deferredPrompt;
  // The event is single use (a second prompt() throws), so it leaves the store before the call. Used or not there:
  // the prompt is spent until the browser offers a new one (promptUsed).
  setState({ deferredPrompt: null, installed: state.installed, promptUsed: true });
  if (!event) return "unavailable";
  try {
    await event.prompt();
    return (await event.userChoice).outcome;
  } catch {
    return "unavailable";
  }
}

/** iPhone, iPad or iPod — including iPadOS, whose Safari reports a Mac and only its touch screen tells. */
export function isIos(userAgent: string, maxTouchPoints: number): boolean {
  if (/iPhone|iPad|iPod/.test(userAgent)) return true;
  return /Macintosh/.test(userAgent) && maxTouchPoints > 1;
}

interface DisplayEnvironment {
  matchMedia?: (query: string) => { matches: boolean };
  navigator?: object;
}

/** Running as an installed app: `display-mode: standalone`, or an iOS home-screen app (`navigator.standalone`). */
export function isStandalone(env: DisplayEnvironment | undefined = typeof window === "undefined" ? undefined : window): boolean {
  if (!env) return false;
  try {
    if (env.matchMedia?.("(display-mode: standalone)").matches) return true;
  } catch {
    // An old engine without the media feature: fall through to the iOS flag.
  }
  return (env.navigator as { standalone?: unknown } | undefined)?.standalone === true;
}

export const INSTALL_DISMISSED_KEY = "homeshare.installDismissedUntil";
const DISMISS_MS = 30 * 86_400_000;

type KeyValueStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): KeyValueStorage | undefined {
  try {
    // The getter itself throws where storage is blocked (disabled site data, some private modes).
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/** "Not now": hides the install banner on this device for 30 days. Silently does nothing if storage fails. */
export function dismissInstall(now: Date = new Date(), storage: KeyValueStorage | undefined = defaultStorage()): void {
  try {
    storage?.setItem(INSTALL_DISMISSED_KEY, String(now.getTime() + DISMISS_MS));
  } catch {
    // Quota or blocked storage: the banner simply shows again next time.
  }
}

/**
 * Whether a "Not now" from the last 30 days still hides the banner. Unreadable storage counts as not dismissed,
 * and so does a stamp further ahead than the window (written under a wrong clock — it must not hide it for years).
 */
export function isInstallDismissed(now: Date = new Date(), storage: KeyValueStorage | undefined = defaultStorage()): boolean {
  try {
    const until = Number(storage?.getItem(INSTALL_DISMISSED_KEY));
    const left = until - now.getTime();
    return Number.isFinite(until) && left > 0 && left <= DISMISS_MS;
  } catch {
    return false;
  }
}
