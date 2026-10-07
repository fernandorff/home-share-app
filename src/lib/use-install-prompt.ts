"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import {
  dismissInstall,
  getInstallPromptState,
  getServerInstallPromptState,
  isInstallDismissed,
  isIos,
  isStandalone,
  promptInstall,
  subscribeInstallPrompt,
  type InstallOutcome,
} from "@/lib/install-prompt";
import {
  installBannerVisible,
  installCardState,
  installSheetAndroid,
  type InstallCardState,
  type InstallSheetAndroid,
} from "@/lib/notification-view";

const STANDALONE_QUERY = "(display-mode: standalone)";

function subscribeStandalone(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(STANDALONE_QUERY);
  query.addEventListener?.("change", onChange);
  return () => query.removeEventListener?.("change", onChange);
}

// The device and the stored "Not now" do not change while the page is open (except through `dismiss` below).
const subscribeNever = () => () => {};

export interface InstallPromptView {
  canPrompt: boolean;
  ios: boolean;
  bannerVisible: boolean;
  cardState: InstallCardState;
  /** What the install sheet's Android tab offers: the native prompt, the browser-menu step, or "can't install". */
  sheetAndroid: InstallSheetAndroid;
  /** The native install dialog (single use). */
  prompt: () => Promise<InstallOutcome>;
  /** Hides the banner on this device for 30 days. */
  dismiss: () => void;
}

/**
 * The install state the Notices page shows (spec 009, criteria 2–3): the deferred event from the store (captured
 * from the root layout), plus standalone / iOS / dismissal read from the device. Server snapshots are the "nothing
 * to offer" values, so hydration never disagrees with the server render.
 */
export function useInstallPrompt(): InstallPromptView {
  const { deferredPrompt, installed, promptUsed } = useSyncExternalStore(subscribeInstallPrompt, getInstallPromptState, getServerInstallPromptState);
  const standalone = useSyncExternalStore(subscribeStandalone, () => isStandalone(), () => false);
  const ios = useSyncExternalStore(subscribeNever, () => isIos(navigator.userAgent, navigator.maxTouchPoints), () => false);
  const storedDismissal = useSyncExternalStore(subscribeNever, () => isInstallDismissed(), () => true);
  const [dismissedNow, setDismissedNow] = useState(false);

  const dismiss = useCallback(() => {
    dismissInstall();
    setDismissedNow(true);
  }, []);

  const canPrompt = deferredPrompt !== null;
  const env = { standalone, installed, canPrompt, ios, dismissed: storedDismissal || dismissedNow, promptUsed };
  return {
    canPrompt,
    ios,
    bannerVisible: installBannerVisible(env),
    cardState: installCardState(env),
    sheetAndroid: installSheetAndroid(env),
    prompt: () => promptInstall(),
    dismiss,
  };
}
