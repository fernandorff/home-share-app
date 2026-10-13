"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { api, ApiError } from "@/lib/api";
import { useApiError } from "@/lib/api-errors";
import { useSession } from "@/lib/session";
import { useNotifications } from "@/lib/notifications-context";
import { groupByDay, notificationHref } from "@/lib/notifications";
import {
  answeredForOtherHouse,
  badgeText,
  focusAfterRemove,
  isFullList,
  markAllNoticesRead,
  noticesPath,
  removeNotice,
  restoreNotice,
  restoreUnread,
  setNoticeRead,
  unreadIds,
  visibleNotices,
  type NoticeFilter,
} from "@/lib/notification-view";
import type { AppNotification, NotificationListResponse, NotificationMutationResponse } from "@/lib/types";
import { cn } from "@/components/ui/cn";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/Feedback";
import { PageHeader } from "@/components/ui/PageHeader";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { Stamp } from "@/components/ui/Stamp";
import { useToast } from "@/components/ui/Toast";
import { revealDelay } from "@/components/ui/motion";
import { NotificationItem } from "@/components/notifications/NotificationItem";
import { InstallBanner } from "@/components/notifications/InstallBanner";
import { useInstallFlow } from "@/components/notifications/InstallSheet";

const FILTERS: NoticeFilter[] = ["all", "unread"];
// Where focus goes when the control that had it disappears (a removed row, the install banner).
const noticesList = () => document.getElementById("notices-list");

/** The list as loaded for one house and filter — a list from another house is never shown after a switch. */
interface Loaded {
  groupId: number | undefined;
  filter: NoticeFilter;
  /** null = the load failed and there is no earlier list of this house and filter to keep. */
  items: AppNotification[] | null;
  /** The server list was at its bound when loaded: the limit notice stays after a remove shortens it. */
  full: boolean;
  /** Relative times and day groups read from this moment. */
  loadedAt: Date;
}

const segment = (active: boolean) =>
  cn(
    "px-3",
    // ring-inset: an offset ring is clipped by the neighbours (same as the other segmented toggles).
    "min-h-11 rounded-md border py-1.5 text-xs font-display font-bold uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-stamp md:min-h-0",
    active ? "border-ink bg-ink text-paper" : "border-rule bg-card text-ink-soft hover:bg-panel"
  );

/** Notices (spec 009, task 19; criteria 2, 3, 15, 16) — reached from the header bell. */
export default function NotificationsPage() {
  const t = useTranslations("Notifications");
  const apiErr = useApiError();
  const toast = useToast();
  const router = useRouter();
  const { activeGroup, membersLoading, refresh: refreshSession } = useSession();
  const groupId = activeGroup?.id;
  const { unreadCount, returnCount, setUnreadCount, refreshUnread } = useNotifications();
  const { install, startInstall, sheet } = useInstallFlow(noticesList);

  const [filter, setFilter] = useState<NoticeFilter>("all");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const reqId = useRef(0);
  // Synchronous double-tap guards (a removed row leaves the list at once, so no per-row busy state is shown).
  const removing = useRef(new Set<string>());
  const readingAll = useRef(false);
  // Only the newest mutation's count reaches the bell: answers can arrive out of order (two quick removes, remove +
  // mark all read), and an older one would overwrite the newer count.
  const mutationSeq = useRef(0);
  // Row to focus once a remove has re-rendered the list (null = the panel); undefined = nothing pending.
  const pendingFocus = useRef<string | null | undefined>(undefined);

  const load = useCallback(async () => {
    const id = ++reqId.current;
    try {
      const data = await api.get<NotificationListResponse>(noticesPath(filter));
      if (reqId.current !== id) return;
      // Another tab switched the house: this list is that house's. Re-read the session — the page then loads for the
      // new house — and keep showing what is on screen meanwhile.
      if (answeredForOtherHouse(data.groupId, groupId)) {
        void refreshSession().catch(() => {});
        return;
      }
      setLoaded({ groupId, filter, items: data.notifications, full: isFullList(data.notifications), loadedAt: new Date() });
      setUnreadCount(data.unreadCount, groupId ?? null);
    } catch (e) {
      if (reqId.current !== id) return;
      toast(apiErr(e, t("loadError")), "error");
      const loadedAt = new Date();
      // Keep this house's last good list of this filter on a failed refresh; nothing to show otherwise.
      setLoaded((previous) => {
        const keep = previous !== null && previous.groupId === groupId && previous.filter === filter;
        return { groupId, filter, items: keep ? previous.items : null, full: keep && previous.full, loadedAt };
      });
    }
  }, [groupId, filter, apiErr, t, toast, setUnreadCount, refreshSession]);

  // Also on every return to the tab (the provider's coalesced focus / visibility) and on every push the service worker
  // reports (spec 010), so the list follows the bell.
  // The same house and filter keep showing their list meanwhile: no skeleton, then fresh items and time labels.
  useEffect(() => {
    void load();
  }, [load, returnCount]);

  useEffect(() => {
    if (pendingFocus.current === undefined) return;
    const target = pendingFocus.current;
    pendingFocus.current = undefined;
    (target ? document.getElementById(`notice-${target}`) : noticesList())?.focus();
  }, [loaded]);

  const current = loaded?.groupId === groupId && loaded?.filter === filter ? loaded : null;
  const items = current?.items ?? [];
  const visible = visibleNotices(items, filter);
  // After a house switch the session keeps the previous house's members until its refresh lands: wait for it, so no
  // name, color or ex-member tag is resolved against the wrong house (and no name reads "—" meanwhile).
  const membersPending = membersLoading;

  // Updates the list of the house the action was taken in (`forGroup` = the click's house): a rollback that lands
  // after a house switch never writes into the other house's list.
  const setItems = (forGroup: number | undefined, update: (list: AppNotification[]) => AppNotification[]) =>
    setLoaded((previous) => (previous?.items && previous.groupId === forGroup ? { ...previous, items: update(previous.items) } : previous));

  // Tap = mark read (optimistic) and open the related screen; the request finishes after the navigation.
  function openNotice(notice: AppNotification) {
    if (!notice.read) {
      const seq = ++mutationSeq.current;
      setItems(groupId, (list) => setNoticeRead(list, notice.publicId, true));
      setUnreadCount(Math.max(0, unreadCount - 1), groupId ?? null);
      api.patch<NotificationMutationResponse>(`/api/notifications/${notice.publicId}`, { read: true }).then(
        (res) => {
          if (seq === mutationSeq.current) setUnreadCount(res.unreadCount, groupId ?? null);
        },
        (e) => {
          setItems(groupId, (list) => setNoticeRead(list, notice.publicId, false));
          void refreshUnread();
          // Already gone (removed on another device): nothing to report on the screen the tap opened.
          if (!(e instanceof ApiError && e.code === "NOTIFICATION_NOT_FOUND")) toast(apiErr(e, t("actionError")), "error");
        }
      );
    }
    router.push(notificationHref(notice.type));
  }

  async function removeOne(notice: AppNotification) {
    if (removing.current.has(notice.publicId)) return;
    removing.current.add(notice.publicId);
    const seq = ++mutationSeq.current;
    const index = items.findIndex((n) => n.publicId === notice.publicId);
    pendingFocus.current = focusAfterRemove(visible, notice.publicId);
    setItems(groupId, (list) => removeNotice(list, notice.publicId));
    if (!notice.read) setUnreadCount(Math.max(0, unreadCount - 1), groupId ?? null);
    try {
      const res = await api.del<NotificationMutationResponse>(`/api/notifications/${notice.publicId}`);
      if (seq === mutationSeq.current) setUnreadCount(res.unreadCount, groupId ?? null);
      toast(t("toast.removed"), "success");
    } catch (e) {
      // Already gone (removed on another device): it stays gone. Anything else puts it back where it was.
      if (!(e instanceof ApiError && e.code === "NOTIFICATION_NOT_FOUND")) {
        setItems(groupId, (list) => restoreNotice(list, notice, index));
      }
      void refreshUnread();
      toast(apiErr(e, t("actionError")), "error");
    } finally {
      removing.current.delete(notice.publicId);
    }
  }

  async function readAll() {
    if (readingAll.current || unreadCount === 0) return;
    readingAll.current = true;
    const seq = ++mutationSeq.current;
    const wereUnread = unreadIds(items);
    setItems(groupId, (list) => markAllNoticesRead(list));
    setUnreadCount(0, groupId ?? null);
    try {
      const res = await api.post<NotificationMutationResponse>("/api/notifications/read-all");
      if (seq === mutationSeq.current) setUnreadCount(res.unreadCount, groupId ?? null);
      toast(t("toast.allRead"), "success");
    } catch (e) {
      setItems(groupId, (list) => restoreUnread(list, wereUnread));
      void refreshUnread();
      toast(apiErr(e, t("actionError")), "error");
    } finally {
      readingAll.current = false;
    }
  }

  function notNow() {
    install.dismiss();
    toast(t("install.notNowToast"), "info");
    // The banner (and the focused button) is gone: keep keyboard focus on the page.
    noticesList()?.focus();
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            {t("title")}
            {unreadCount > 0 && (
              <span className="rounded-full bg-stamp-text px-2 py-0.5 font-display text-xs font-bold leading-normal text-paper tnum">
                <span aria-hidden>{badgeText(unreadCount)}</span>
                <span className="sr-only">{t("bellCount", { count: unreadCount })}</span>
              </span>
            )}
          </span>
        }
        subtitle={t("subtitle")}
        actions={
          // Spec 011 (criterion 9): the preferences moved to Settings › Notifications.
          <Link
            href="/settings/notifications"
            aria-label={t("settingsLink")}
            title={t("settingsLink")}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-rule bg-card text-lg text-ink transition-colors hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
          >
            {/* U+FE0E: text presentation, so it takes the ink color instead of rendering as an emoji. */}
            <span aria-hidden>{"⚙︎"}</span>
          </Link>
        }
      />

      {install.bannerVisible && (
        <InstallBanner onInstall={() => void startInstall()} onNotNow={notNow} />
      )}

      {/* tabIndex -1: the focus target when a removed row or the banner leaves (an empty list holds nothing focusable). */}
      <section id="notices-list" aria-label={t("title")} tabIndex={-1} className="focus:outline-none">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex gap-1">
              {FILTERS.map((id) => (
                <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)} className={segment(filter === id)}>
                  {id === "all" ? t("filter.all") : t("filter.unread")}
                </button>
              ))}
            </div>
            {/* aria-disabled, not disabled: the button keeps focus after it empties the count. */}
            <Button
              variant="ghost"
              size="sm"
              aria-disabled={unreadCount === 0}
              onClick={() => void readAll()}
              className="aria-disabled:cursor-default aria-disabled:opacity-50"
            >
              {t("markAllRead")}
            </Button>
          </div>

          {current === null || membersPending ? (
            <Card className="overflow-hidden">
              <SkeletonRows rows={5} inset />
            </Card>
          ) : current.items === null ? (
            <Card>
              <EmptyState title={t("loadError")} icon="↻" />
            </Card>
          ) : visible.length === 0 ? (
            <Card className="reveal">
              <div className="flex flex-col items-center gap-4 px-6 py-14 text-center">
                <Stamp tone="credit">{t("allCaughtUp")}</Stamp>
                <p className="text-pretty text-sm text-faint">{filter === "unread" ? t("emptyUnread") : t("emptyAll")}</p>
              </div>
            </Card>
          ) : (
            <Card className="overflow-hidden">
              {groupByDay(visible, current.loadedAt).map((group, g) => (
                <section
                  key={group.key}
                  aria-labelledby={`notices-group-${group.key}`}
                  className={cn(g > 0 && "border-t border-dashed border-rule")}
                >
                  <h2 id={`notices-group-${group.key}`} className="label-mono px-4 pb-1 pt-3">
                    {t(`group.${group.key}`)}
                  </h2>
                  <ul>
                    {group.items.map((notice, i) => (
                      <li
                        key={notice.publicId}
                        className={cn("reveal", i > 0 && "border-t border-dotted border-rule")}
                        style={revealDelay(i)}
                      >
                        <NotificationItem
                          notification={notice}
                          now={current.loadedAt}
                          onOpen={() => openNotice(notice)}
                          onRemove={() => void removeOne(notice)}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              {current.full && (
                <p className="border-t border-dotted border-rule px-4 py-3 text-center text-pretty text-xs text-faint">
                  {t("limitNotice")}
                </p>
              )}
            </Card>
          )}
        </div>
      </section>

      {sheet}
    </div>
  );
}
