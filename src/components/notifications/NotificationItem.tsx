"use client";

import { useId } from "react";
import { useLocale, useTranslations } from "next-intl";
import { MemberDot } from "@/components/ui/Member";
import { cn } from "@/components/ui/cn";
import { useSession } from "@/lib/session";
import { formatDateTimeLocale, formatMoney } from "@/lib/money";
import { DEFAULT_CURRENCY } from "@/lib/currencies";
import { keepLastWordTogether } from "@/lib/activity-format";
import { memberDisplayName, noticeMessage, noticePersonId, noticeTimeLabel } from "@/lib/notification-view";
import type { AppNotification } from "@/lib/types";

/**
 * One notice (spec 009, task 19; criteria 15–16): the person it is about (the actor, the payer of a payment, or the
 * ↻ glyph of an automatic notice), its text in the reader's language with amounts in the house currency,
 * "{relative time} · {type}", an unread dot. The row opens the related screen; ✕ removes it.
 */
export function NotificationItem({
  notification,
  now,
  onOpen,
  onRemove,
}: {
  notification: AppNotification;
  /** The moment the list loaded: relative times and day groups read from the same clock. */
  now: Date;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const t = useTranslations("Notifications");
  const tacc = useTranslations("Account");
  const thh = useTranslations("Household");
  const locale = useLocale();
  const { members, activeGroup } = useSession();
  const currency = activeGroup?.currency ?? DEFAULT_CURRENCY;
  // Every ✕ reads "Remove notice": each one is described by its own notice's text.
  const textId = useId();

  const labels = {
    automatic: t("automatic"),
    deleted: tacc("deletedUserLabel"),
    exMember: (name: string) => thh("exMemberLabel", { name }),
    unknown: "—",
  };
  const message = noticeMessage(notification, {
    money: (amount) => formatMoney(amount, currency, locale),
    // A surname never splits from the first name at a line break (R3-23, as in Activity).
    name: (id) => keepLastWordTogether(memberDisplayName(id, members, labels)),
  });
  const personId = noticePersonId(notification);
  const person = personId === null ? undefined : members.find((m) => m.id === personId);

  return (
    <div className="flex items-stretch">
      <button
        id={`notice-${notification.publicId}`}
        type="button"
        onClick={onOpen}
        className="flex min-h-11 min-w-0 flex-1 items-start gap-3 py-3 pl-4 pr-2 text-left transition-colors hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink"
      >
        {/* Decorative: the text names the same person. */}
        <span aria-hidden className="shrink-0">
          <MemberDot
            colorIndex={person?.colorIndex ?? 0}
            name={memberDisplayName(personId, members, labels)}
            glyph={personId === null ? "↻" : undefined}
            size={30}
          />
        </span>
        <span className="min-w-0 flex-1">
          <span id={textId} className={cn("block break-words text-pretty text-sm text-ink", !notification.read && "font-bold")}>
            {t(message.key, message.values)}
          </span>
          <span className="mt-0.5 block text-xs text-faint">
            <time dateTime={notification.createdAt} title={formatDateTimeLocale(notification.createdAt)} className="tnum">
              {noticeTimeLabel(notification.createdAt, now, locale)}
            </time>
            {" · "}
            {t(`types.${notification.type}.label`)}
          </span>
        </span>
        {!notification.read && (
          <>
            <span aria-hidden className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-stamp" />
            <span className="sr-only">{t("unreadDot")}</span>
          </>
        )}
      </button>
      <button
        type="button"
        aria-label={t("remove")}
        aria-describedby={textId}
        onClick={onRemove}
        // 44px touch floor below md (the row's full height), compact from md.
        className="inline-flex min-h-11 w-11 shrink-0 items-center justify-center text-base leading-none text-faint transition-colors hover:bg-panel hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink md:w-10"
      >
        <span aria-hidden>✕</span>
      </button>
    </div>
  );
}
