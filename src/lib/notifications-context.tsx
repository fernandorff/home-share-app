"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import { answeredForOtherHouse } from "@/lib/notification-view";
import type { UnreadCountResponse } from "@/lib/types";

interface NotificationsValue {
  /** The active house's unread notices (0 until this house's count arrives). */
  unreadCount: number;
  /**
   * Bumped each time the person comes back to the tab (focus / visibility, coalesced) and each time a push reports a
   * new notice: an open list reloads on it.
   */
  returnCount: number;
  /** Re-reads the count from the server. */
  refreshUnread: () => Promise<void>;
  /** Takes a count a request already returned (list, mark read, remove, read-all) — no extra request. */
  setUnreadCount: (count: number, forGroupId: number | null) => void;
  /** The service worker reported a push (spec 010): re-reads the count and bumps `returnCount`, so an open list reloads. */
  noticeReceived: () => void;
}

const NotificationsContext = createContext<NotificationsValue | null>(null);

// Coalesces `focus` + `visibilitychange`, which fire together when the person comes back to the tab.
const RETURN_COALESCE_MS = 2_000;

/**
 * The bell's unread count (spec 009, task 18; criterion 14), shared by the header bell and the Notices page.
 * Refreshed on mount, on an active-house change, when the window regains focus or the tab becomes visible, and by
 * the page after its own read/remove actions. No timer polling (design › Alternatives considered). Each return also
 * bumps `returnCount`, so the open Notices list reloads with the bell instead of going stale under it. A count the
 * server read for another house (switched in another tab) is dropped and the session re-read: the bell follows the cookie.
 */
export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const { activeGroup, refresh: refreshSession } = useSession();
  const groupId = activeGroup?.id ?? null;
  const [state, setState] = useState<{ groupId: number | null; count: number }>({ groupId: null, count: 0 });
  const [returnCount, setReturnCount] = useState(0);
  // The house the answers are for; requests and mutation results about another house are dropped.
  const groupRef = useRef(groupId);
  // Newest wins: a refresh still in flight when a fresher count arrives is ignored.
  const seq = useRef(0);
  const lastReturn = useRef(0);

  useEffect(() => {
    groupRef.current = groupId;
  }, [groupId]);

  const refreshUnread = useCallback(async () => {
    const forGroup = groupRef.current;
    if (forGroup === null) return;
    const id = ++seq.current;
    try {
      const res = await api.get<UnreadCountResponse>("/api/notifications/unread-count");
      if (seq.current === id && groupRef.current === forGroup) {
        // Another tab switched the house: the session re-read brings it here, and the house-change effect counts for it.
        if (answeredForOtherHouse(res.groupId, forGroup)) void refreshSession().catch(() => {});
        else setState({ groupId: forGroup, count: res.count });
      }
    } catch {
      // Keep the last count (a 401 already redirects inside the api wrapper); the next trigger retries.
    }
  }, [refreshSession]);

  const setUnreadCount = useCallback((count: number, forGroupId: number | null) => {
    if (forGroupId !== groupRef.current) return;
    seq.current++;
    setState({ groupId: forGroupId, count });
  }, []);

  // A push is a new notice: never coalesced with a return, which may have landed just before it.
  const noticeReceived = useCallback(() => {
    void refreshUnread();
    setReturnCount((n) => n + 1);
  }, [refreshUnread]);

  // Declared after the groupRef sync above, so it reads the new house.
  useEffect(() => {
    void refreshUnread();
  }, [groupId, refreshUnread]);

  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState === "visible" && Date.now() - lastReturn.current > RETURN_COALESCE_MS) {
        lastReturn.current = Date.now();
        void refreshUnread();
        setReturnCount((n) => n + 1);
      }
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [refreshUnread]);

  const unreadCount = state.groupId === groupId ? state.count : 0;
  const value = useMemo<NotificationsValue>(
    () => ({ unreadCount, returnCount, refreshUnread, setUnreadCount, noticeReceived }),
    [unreadCount, returnCount, refreshUnread, setUnreadCount, noticeReceived]
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications(): NotificationsValue {
  const value = useContext(NotificationsContext);
  if (!value) throw new Error("useNotifications must be used inside <NotificationsProvider>");
  return value;
}
