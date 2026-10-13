"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { cn } from "@/components/ui/cn";
import { useNotifications } from "@/lib/notifications-context";
import { badgeText } from "@/lib/notification-view";

function BellIcon() {
  return (
    <svg aria-hidden className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 8 2.5 8h-17S6 15 6 9Z" />
      <path d="M10.2 20.5a2 2 0 0 0 3.6 0" />
    </svg>
  );
}

/**
 * Header bell (spec 009, task 18; criterion 14): the active house's unread count, linking to /notifications. One
 * element on every breakpoint — before the drawer button on mobile, before the user menu on desktop. The badge sits
 * over the icon (absolute), so it appears and disappears without moving anything.
 */
export function NotificationBell() {
  const t = useTranslations("Notifications");
  const { unreadCount } = useNotifications();
  const active = usePathname() === "/notifications";

  return (
    <Link
      href="/notifications"
      aria-label={t("bellCount", { count: unreadCount })}
      aria-current={active ? "page" : undefined}
      className={cn(
        // 44px target below md; from md the header's compact 34px row (house selector / user menu), so the
        // desktop header keeps its height (the sidebar's sticky offset depends on it).
        "relative inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md border text-ink transition-colors md:h-[2.125rem] md:w-[2.125rem]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-paper",
        active ? "border-ink bg-panel" : "border-transparent hover:bg-panel"
      )}
    >
      <BellIcon />
      {unreadCount > 0 && (
        <span
          aria-hidden
          className="absolute -right-1 -top-1 h-[1.125rem] min-w-[1.125rem] rounded-full bg-stamp-text px-1 text-center font-display text-xs font-bold leading-[1.125rem] text-paper tnum"
        >
          {badgeText(unreadCount)}
        </span>
      )}
    </Link>
  );
}
