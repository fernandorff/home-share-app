// Pure helpers of the notification center (spec 009), shared by the server (scheduled producers), the
// Notices page and — in spec 010 — push. Framework-agnostic: no Prisma, no React.

/** The schema's `NotificationType` enum values, in enum order (type + runtime tests keep the two in sync). */
export const NOTIFICATION_TYPES = ["EXPENSE_NEW", "PAYMENT_RECEIVED", "DEBT_REMINDER", "RECURRING_DUE"] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Notices one list returns, newest first (criterion 11) — the service's bound and the page's limit notice. */
export const NOTIFICATION_LIST_LIMIT = 50;

const HREF: Record<NotificationType, string> = {
  EXPENSE_NEW: "/expenses",
  PAYMENT_RECEIVED: "/balances",
  DEBT_REMINDER: "/balances",
  RECURRING_DUE: "/recurring",
};

/** The in-app screen a notice opens (a list screen, never a detail that may have been deleted). */
export function notificationHref(type: NotificationType): string {
  return HREF[type];
}

export type DayGroupKey = "today" | "yesterday" | "earlier";

export interface DayGroup<T> {
  key: DayGroupKey;
  items: T[];
}

/** Local calendar date as a sortable number (YYYYMMDD). */
function localDay(date: Date): number {
  return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
}

/**
 * Today / Yesterday / Earlier by the runtime's local calendar date (the browser's, on the Notices page).
 * Keeps the input order inside each group, returns the groups in that order and omits empty ones.
 * A notice stamped after `now` (server/browser clock skew) counts as today.
 */
export function groupByDay<T extends { createdAt: string }>(items: readonly T[], now: Date): DayGroup<T>[] {
  const today = localDay(now);
  // Calendar arithmetic, not now − 24 h: a DST change makes a day 23 or 25 hours long.
  const yesterday = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const groups: Record<DayGroupKey, T[]> = { today: [], yesterday: [], earlier: [] };
  for (const item of items) {
    const day = localDay(new Date(item.createdAt));
    groups[day >= today ? "today" : day === yesterday ? "yesterday" : "earlier"].push(item);
  }
  return (["today", "yesterday", "earlier"] as const)
    .filter((key) => groups[key].length > 0)
    .map((key) => ({ key, items: groups[key] }));
}

/** ISO-8601 week of `date`'s UTC calendar date, e.g. `2026-W41` (the debt reminder's dedupe period). */
export function isoWeek(date: Date): string {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // The week's Thursday decides its year: Monday = 1 … Sunday = 7.
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const year = day.getUTCFullYear();
  const week = Math.ceil(((day.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}
