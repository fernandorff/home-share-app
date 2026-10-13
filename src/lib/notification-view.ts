// View helpers of the bell and the Notices page (spec 009, tasks 18–19). Pure — no React, no fetch — so the page's
// rules (texts per type, names, time labels, optimistic list updates, install banner) are unit-tested.

import { formatDateLocale } from "@/lib/money";
import { NOTIFICATION_LIST_LIMIT } from "@/lib/notifications";
import type { AppNotification, Member } from "@/lib/types";

/** The server list is at its bound (older notices exist): the page shows the limit notice. */
export function isFullList(list: readonly AppNotification[]): boolean {
  return list.length >= NOTIFICATION_LIST_LIMIT;
}

const BADGE_MAX = 99;

/** The badge's text: the count, capped at "99+" so the badge keeps its size. */
export function badgeText(count: number): string {
  return count > BADGE_MAX ? `${BADGE_MAX}+` : String(count);
}

export type NoticeFilter = "all" | "unread";

/**
 * The server answered for another house than the one on screen: the active-house cookie moved (a switch in another
 * tab, ADR 0002). The caller drops the answer and re-reads the session, so the screen follows the cookie.
 */
export function answeredForOtherHouse(answerGroupId: number | undefined, activeGroupId: number | null | undefined): boolean {
  // An answer without a house (an older API after a rollback) is not a mismatch: no refresh on every focus.
  return typeof answerGroupId === "number" && activeGroupId != null && answerGroupId !== activeGroupId;
}

/** The list route for a filter (the API filters unread ones itself: All only holds the 50 newest). */
export function noticesPath(filter: NoticeFilter): string {
  return filter === "unread" ? "/api/notifications?filter=unread" : "/api/notifications";
}

export interface NameLabels {
  /** No actor: the notice comes from the app itself (cron, recurring rule). */
  automatic: string;
  deleted: string;
  exMember: (name: string) => string;
  /** An id the member list does not hold (yet). */
  unknown: string;
}

/**
 * A person's current display name, resolved like Activity (BL-16/BL-23, criterion 16): a deleted account always
 * shows the translated label, an ex-member keeps the name tagged, null is the app itself.
 */
export function memberDisplayName(id: number | null, members: readonly Member[], labels: NameLabels): string {
  if (id === null) return labels.automatic;
  const member = members.find((m) => m.id === id);
  if (!member) return labels.unknown;
  if (member.deleted) return labels.deleted;
  if (!member.active) return labels.exMember(member.name);
  return member.name;
}

/** Whose avatar a notice shows: the payer of a payment (its text names them), the actor otherwise; null = automatic. */
export function noticePersonId(notice: AppNotification): number | null {
  if (notice.type === "PAYMENT_RECEIVED") {
    const payer = (notice.params as { fromUserId?: unknown }).fromUserId;
    return typeof payer === "number" ? payer : notice.actorId;
  }
  return notice.actorId;
}

export type NoticeTextKey =
  | "text.EXPENSE_NEW"
  | "text.EXPENSE_NEW_RECURRING"
  | "text.PAYMENT_RECEIVED"
  | "text.DEBT_REMINDER"
  | "text.RECURRING_DUE";

export interface NoticeMessage {
  /** Under the `Notifications` namespace. */
  key: NoticeTextKey;
  values: Record<string, string>;
}

/**
 * The message a notice renders (design › i18n keys): amounts through `money` (the house currency formatter), people
 * through `name`. A recurring posting has its own text with no actor (criterion 16: "posted automatically").
 */
export function noticeMessage(
  notice: AppNotification,
  fmt: { money: (amount: string) => string; name: (id: number | null) => string }
): NoticeMessage {
  switch (notice.type) {
    case "EXPENSE_NEW": {
      const { description, amount, recurring } = notice.params;
      return recurring
        ? { key: "text.EXPENSE_NEW_RECURRING", values: { description, amount: fmt.money(amount) } }
        : { key: "text.EXPENSE_NEW", values: { actor: fmt.name(notice.actorId), description, amount: fmt.money(amount) } };
    }
    case "PAYMENT_RECEIVED":
      return { key: "text.PAYMENT_RECEIVED", values: { payer: fmt.name(noticePersonId(notice)), amount: fmt.money(notice.params.amount) } };
    case "DEBT_REMINDER":
      return { key: "text.DEBT_REMINDER", values: { amount: fmt.money(notice.params.amount) } };
    case "RECURRING_DUE":
      return { key: "text.RECURRING_DUE", values: { description: notice.params.description, amount: fmt.money(notice.params.amount) } };
  }
}

const DAY_MS = 86_400_000;

/** Whole local calendar days from `then` to `now` (DST-proof: compares dates, not 24-hour spans). */
function calendarDaysBetween(then: Date, now: Date): number {
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((day(now) - day(then)) / DAY_MS);
}

/**
 * The notice's time, relative to `now` in the reader's language: "now", "5 min. ago", "3 hr. ago" within today;
 * "yesterday", "2 days ago" by local calendar day (the same days as the Today / Yesterday / Earlier groups);
 * the date (dd/mm/yyyy) from a week back. A notice stamped ahead of `now` (clock skew) reads "now".
 */
export function noticeTimeLabel(createdAt: string, now: Date, locale: string): string {
  const then = new Date(createdAt);
  if (Number.isNaN(then.getTime())) return "—";
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  const days = calendarDaysBetween(then, now);
  if (days <= 0) {
    const minutes = Math.floor((now.getTime() - then.getTime()) / 60_000);
    if (minutes < 1) return relative.format(0, "second");
    if (minutes < 60) return relative.format(-minutes, "minute");
    return relative.format(-Math.floor(minutes / 60), "hour");
  }
  if (days < 7) return relative.format(-days, "day");
  return formatDateLocale(createdAt);
}

// ---- Optimistic list updates (each returns a new array; the input is never mutated) ----

export function setNoticeRead(list: readonly AppNotification[], publicId: string, read: boolean): AppNotification[] {
  return list.map((n) => (n.publicId === publicId ? { ...n, read } : n));
}

export function markAllNoticesRead(list: readonly AppNotification[]): AppNotification[] {
  return list.map((n) => (n.read ? n : { ...n, read: true }));
}

/** The notices still unread — what "Mark all read" puts back if the request fails. */
export function unreadIds(list: readonly AppNotification[]): Set<string> {
  return new Set(list.filter((n) => !n.read).map((n) => n.publicId));
}

export function restoreUnread(list: readonly AppNotification[], ids: ReadonlySet<string>): AppNotification[] {
  return list.map((n) => (ids.has(n.publicId) ? { ...n, read: false } : n));
}

/** The list without one notice (not in the list = the same list back). */
export function removeNotice(list: AppNotification[], publicId: string): AppNotification[] {
  const index = list.findIndex((n) => n.publicId === publicId);
  if (index === -1) return list;
  return list.filter((_, i) => i !== index);
}

/** Puts a removed notice back where it was (a failed remove); never twice. */
export function restoreNotice(list: AppNotification[], notice: AppNotification, index: number): AppNotification[] {
  if (list.some((n) => n.publicId === notice.publicId)) return list;
  const at = Math.min(Math.max(index, 0), list.length);
  return [...list.slice(0, at), notice, ...list.slice(at)];
}

/** What the filter shows: Unread drops a notice as soon as it is (optimistically) read. */
export function visibleNotices(list: AppNotification[], filter: NoticeFilter): AppNotification[] {
  return filter === "unread" ? list.filter((n) => !n.read) : list;
}

/** Where focus goes after removing a row: the next visible row, else the previous one, else nowhere. */
export function focusAfterRemove(visible: readonly AppNotification[], publicId: string): string | null {
  const index = visible.findIndex((n) => n.publicId === publicId);
  if (index === -1) return null;
  return visible[index + 1]?.publicId ?? visible[index - 1]?.publicId ?? null;
}

// ---- Install banner and "App on home screen" card (criteria 2 and 3) ----

export interface InstallEnv {
  /** Running as the installed app (display-mode standalone / iOS home-screen app). */
  standalone: boolean;
  /** `appinstalled` fired during this page's life. */
  installed: boolean;
  /** The browser handed over a deferred `beforeinstallprompt`. */
  canPrompt: boolean;
  /** iPhone/iPad: no prompt event, manual Share → Add to Home Screen steps. */
  ios: boolean;
  /** "Not now" within the last 30 days on this device. */
  dismissed: boolean;
  /** The one-time prompt was used (or came back unavailable) and no new one arrived: installable, just not from here now. */
  promptUsed: boolean;
}

export function installBannerVisible(env: InstallEnv): boolean {
  if (env.standalone || env.installed || env.dismissed) return false;
  return env.canPrompt || env.ios;
}

/**
 * A browser that cannot install from here at all — no prompt now, none used before, not iPhone/iPad (Firefox
 * desktop, Safari macOS). The only case that reads "This browser can't install apps".
 */
export function installUnsupported(env: Pick<InstallEnv, "canPrompt" | "ios" | "promptUsed">): boolean {
  return !env.canPrompt && !env.ios && !env.promptUsed;
}

export type InstallCardState = "installed" | "prompt" | "manual" | "promptUsed" | "unsupported";

/**
 * The Preferences card: Installed, the native prompt, the iOS steps, the prompt already used (its body, no button),
 * or "this browser can't install apps".
 */
export function installCardState(env: Omit<InstallEnv, "dismissed">): InstallCardState {
  if (env.standalone || env.installed) return "installed";
  if (env.canPrompt) return "prompt";
  if (env.ios) return "manual";
  return installUnsupported(env) ? "unsupported" : "promptUsed";
}

export type InstallSheetAndroid = "prompt" | "menu" | "unsupported";

/**
 * The install sheet's Android tab: the native prompt while the browser offers one, else the manual step through the
 * browser menu (also what an iPhone reading the Android tab sees); "can't install" only where it never can.
 */
export function installSheetAndroid(env: Pick<InstallEnv, "canPrompt" | "ios" | "promptUsed">): InstallSheetAndroid {
  if (env.canPrompt) return "prompt";
  return installUnsupported(env) ? "unsupported" : "menu";
}
