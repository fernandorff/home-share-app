"use client";

import { useEffect, useRef } from "react";
import { useLocale } from "next-intl";
import { useSession } from "@/lib/session";
import { useNotifications } from "@/lib/notifications-context";
import { listenForPushMessages, pushSupport, syncPush } from "@/lib/push/client";

// Web Push on this device (spec 010 — criteria 1, 2, 8), in two parts: the sync needs only the session and the
// locale, so the (app) layout renders it before the onboarding gate (a member without a house yet syncs too); the
// message listener needs the notifications provider, which exists only once there is a house. Neither renders anything
// nor does anything unless push is configured and the browser can receive it, and neither ever prompts: permission is
// only asked from the member's tap (Preferences).

/**
 * Registers /sw.js and syncs this browser's subscription for the signed-in member on every load — and when the app
 * language changes, so the device's pushes follow it (criterion 8).
 */
export function PushSync() {
  const { me } = useSession();
  const locale = useLocale();
  const owner = me?.user.publicId ?? null;
  // The owner + locale this mount last synced. A ref, not module state: StrictMode's double effect and re-renders never
  // sync twice, while signing in again remounts the (app) tree and syncs again (how a device returns after a logout).
  const synced = useRef<string | null>(null);

  useEffect(() => {
    if (!owner || pushSupport() !== "ok") return;
    const key = `${owner}|${locale}`;
    if (synced.current === key) return;
    synced.current = key;
    // Best effort: a failed sync only means no push on this device until the next load.
    syncPush({ owner, locale }).catch(() => {});
  }, [owner, locale]);

  return null;
}

/** When the worker reports a push, refreshes the bell and an open Notices list (the provider's noticeReceived). */
export function PushMessageListener() {
  const { noticeReceived } = useNotifications();

  useEffect(() => {
    if (pushSupport() !== "ok") return;
    return listenForPushMessages(noticeReceived);
  }, [noticeReceived]);

  return null;
}
