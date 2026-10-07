// View helpers of the Recurring page and rule form (spec 008, tasks 18–19). Pure: the preview reuses the
// same recurrence rules the poster runs on the server (`lib/recurrence`) and the same integer-cents split
// (`splitCents`), so what the form promises is what the poster does.

import { dueOn, eligiblePeriods, isValidPeriod, isValidTimeZone, upcomingPeriods } from "@/lib/recurrence";
import { fromCents, splitCents } from "@/lib/currency";
import { formatDateLocale } from "@/lib/money";
import type { Member, RecurringExpense } from "@/lib/types";

export const DAY_MIN = 1;
export const DAY_MAX = 31;
/** The Upcoming tab lists at most this many periods across all rules (criterion 21). */
export const UPCOMING_TAB_MAX = 6;

/** The day after a − / + press, kept within 1–31. */
export function stepDay(day: number, delta: number): number {
  return Math.min(DAY_MAX, Math.max(DAY_MIN, day + delta));
}

/** A typed day (digits only) when it is 1–31, else null. */
export function parseDayInput(raw: string): number | null {
  if (!/^\d{1,2}$/.test(raw)) return null;
  const day = Number(raw);
  return day >= DAY_MIN && day <= DAY_MAX ? day : null;
}

/** Hint under the day stepper: the last-day clamp above 28, otherwise the weekend rule. */
export function dayHintKey(day: number): "form.dayHintClamp" | "form.dayHintWeekend" {
  return day > 28 ? "form.dayHintClamp" : "form.dayHintWeekend";
}

/** The browser's IANA zone — a new rule's "today" (design › Date rules); UTC when unavailable. */
export function browserTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimeZone(zone) ? zone : "UTC";
  } catch {
    return "UTC";
  }
}

export interface FirstPostingInput {
  dayOfMonth: number;
  /** `YYYY-MM-DD` in the rule's zone. */
  today: string;
  /** An unpaused rule being edited: its own; a new rule (or a paused one, which restarts at resume): today. */
  activeFrom?: string;
  lastClosedPeriod?: string | null;
  skippedPeriods?: readonly string[];
}

/**
 * Date of the first expense the rule will post (form preview, criterion 22). A month already due and not
 * posted yet is posted right after the save (the routes' synchronous run), dated on its due day.
 */
export function previewFirstPosting({
  dayOfMonth,
  today,
  activeFrom = today,
  lastClosedPeriod = null,
  skippedPeriods = [],
}: FirstPostingInput): string {
  const skipped = new Set(skippedPeriods);
  const dueNow = eligiblePeriods({ dayOfMonth, activeFrom }, today, lastClosedPeriod).find((p) => !skipped.has(p));
  if (dueNow) return dueOn(dueNow, dayOfMonth);
  // Among skipped.size + 1 consecutive months at least one is not skipped.
  const next = upcomingPeriods({ dayOfMonth, paused: false, skippedPeriods }, today, lastClosedPeriod, skipped.size + 1);
  return (next.find((u) => !u.skipped) ?? next[0]).dueOn;
}

/** Base per-person share in cents (the split hands the leftover cents to the first people); null if none. */
export function equalShareCents(totalCents: number, count: number): number | null {
  if (totalCents <= 0 || count <= 0) return null;
  return splitCents(totalCents, count)[count - 1];
}

export type RuleStatus =
  | { kind: "memberLeft" }
  | { kind: "paused" }
  | { kind: "skipped"; backIn: string | null }
  | { kind: "next"; dueOn: string }
  | { kind: "none" };

/**
 * The rule card's status line. A MEMBER_LEFT pause stays "memberLeft" (Edit, not Resume) only while the payer
 * or a selected participant is still inactive; once an edit has replaced them, it reads as a plain pause so
 * Resume is offered again (resume re-validates the people on the server).
 */
export function ruleStatus(
  rule: Pick<RecurringExpense, "paused" | "pauseReason" | "upcoming" | "payerId" | "splitMode" | "participantIds">,
  activeIds: ReadonlySet<number>
): RuleStatus {
  if (rule.paused) {
    const people = rule.splitMode === "SELECTED" ? [rule.payerId, ...rule.participantIds] : [rule.payerId];
    // No member list yet (loading, or the fetch failed): offer Resume and let the server re-validate.
    const someoneLeft = activeIds.size > 0 && people.some((id) => !activeIds.has(id));
    return rule.pauseReason === "MEMBER_LEFT" && someoneLeft ? { kind: "memberLeft" } : { kind: "paused" };
  }
  const [next] = rule.upcoming;
  if (!next) return { kind: "none" };
  if (next.skipped) return { kind: "skipped", backIn: rule.upcoming.find((u) => !u.skipped)?.period ?? null };
  return { kind: "next", dueOn: next.dueOn };
}

export interface UpcomingRow {
  rule: RecurringExpense;
  period: string;
  dueOn: string;
  skipped: boolean;
}

/** Upcoming tab: every rule's next periods by due date (ties keep the rules' order), at most `max`. */
export function upcomingAcrossRules(rules: RecurringExpense[], max = UPCOMING_TAB_MAX): UpcomingRow[] {
  return rules
    .flatMap((rule, index) => rule.upcoming.map((u) => ({ row: { rule, ...u }, index })))
    .sort((x, y) => (x.row.dueOn < y.row.dueOn ? -1 : x.row.dueOn > y.row.dueOn ? 1 : x.index - y.index))
    .slice(0, max)
    .map(({ row }) => row);
}

/**
 * Who shares a posting: every active member (ALL), or the rule's people in its order (SELECTED, ex-members
 * included — the poster pauses the rule instead of dropping them). `count` is the divisor the poster uses.
 */
export function shareMembers(
  rule: Pick<RecurringExpense, "splitMode" | "participantIds">,
  members: Member[]
): { people: Member[]; count: number } {
  if (rule.splitMode === "ALL") {
    const people = members.filter((m) => m.active);
    return { people, count: people.length };
  }
  const byId = new Map(members.map((m) => [m.id, m]));
  const people = rule.participantIds.flatMap((id) => byId.get(id) ?? []);
  return { people, count: rule.participantIds.length };
}

/** A `YYYY-MM-DD` due date as DD/MM/YYYY, read at local noon so it never shifts a day with the zone. */
export function dueDateLabel(date: string): string {
  return formatDateLocale(`${date}T12:00:00`);
}

/** A `YYYY-MM` period's month name in the viewer's language ("November", "nov."). UTC on both sides. */
export function monthName(period: string, locale: string, style: "long" | "short" = "long"): string {
  if (!isValidPeriod(period)) return period;
  const [year, month] = period.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { month: style, timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1)));
}

export type RecurringFormField = "description" | "amount" | "day" | "payer" | "split";

const FIELD_BY_CODE: Record<string, RecurringFormField> = {
  DESCRIPTION_REQUIRED: "description",
  DESCRIPTION_TOO_LONG: "description",
  DESCRIPTION_INVALID: "description",
  AMOUNT_INVALID: "amount",
  AMOUNT_PRECISION: "amount",
  AMOUNT_TOO_HIGH: "amount",
  RECURRING_DAY_INVALID: "day",
  PAYER_REQUIRED: "payer",
  RECURRING_SPLIT_INVALID: "split",
};

/** The form field a 400 code is about (shown under it, U11); null for form-level errors (footer). */
export function fieldForErrorCode(code: string | undefined): RecurringFormField | null {
  return (code && FIELD_BY_CODE[code]) || null;
}

/** Errors after which the rule is gone (404) or no longer the viewer's to manage (403): retrying cannot work,
 *  so the dialog closes and the list reloads. */
const CLOSING_CODES = new Set(["RECURRING_NOT_FOUND", "NOT_RECURRING_OWNER"]);

export function closesOnError(code: string | undefined): boolean {
  return code !== undefined && CLOSING_CODES.has(code);
}

type SplitMode = RecurringExpense["splitMode"];

/** What the rule form holds; the masked amount is parsed with the viewer's locale before a save. */
export interface RuleFormValues {
  description: string;
  amountMasked: string;
  day: number;
  /** What the day box shows while typing; `day` only takes valid values (1–31). */
  dayText: string;
  payerId: string;
  splitMode: SplitMode;
  /** SELECTED people, in the order sent — the split hands the leftover cents to the first ones. */
  picked: number[];
}

/**
 * The unsaved-changes guard: whether the form differs from what it opened with (or what Load latest last
 * reseeded it with). The people only count while choosing people — with ALL the hidden list is not sent.
 * Same people in another order is a change: the order decides who gets the leftover cents.
 */
export function ruleFormDirty(initial: RuleFormValues, current: RuleFormValues): boolean {
  return (
    current.description !== initial.description ||
    current.amountMasked !== initial.amountMasked ||
    current.day !== initial.day ||
    current.payerId !== initial.payerId ||
    current.splitMode !== initial.splitMode ||
    (current.splitMode === "SELECTED" && current.picked.join(",") !== initial.picked.join(","))
  );
}

export interface RuleBodyValues {
  description: string;
  amountCents: number;
  day: number;
  payerId: string;
  splitMode: SplitMode;
  picked: number[];
}

export interface RuleBody {
  description: string;
  amount: number;
  dayOfMonth: number;
  payerId: number;
  splitMode: SplitMode;
  participantIds?: number[];
  /** Sanity guard, not the source of the house (that is the cookie): a house switched in another tab → 409. */
  expectedGroupId: number | undefined;
  /** Create only: the rule's "today" zone (criterion 22). Never changed afterwards (out of scope). */
  timezone?: string;
  /** Edit only: the optimistic-lock token (ADR 0006). */
  expectedUpdatedAt?: string;
}

/**
 * The body of `POST /api/recurring-expenses` (create) or `PATCH …/{publicId}` (edit). An edit never carries
 * `paused` (that would make it a pause request, RECURRING_PATCH_INVALID) nor `timezone` (create only);
 * `participantIds` only for SELECTED, in the order picked.
 */
export function buildRuleBody(
  values: RuleBodyValues,
  options:
    | { mode: "create"; groupId: number | undefined; timezone: string }
    | { mode: "edit"; groupId: number | undefined; lockToken: string | undefined }
): RuleBody {
  const body: RuleBody = {
    description: values.description.trim(),
    amount: fromCents(values.amountCents),
    dayOfMonth: values.day,
    payerId: Number(values.payerId),
    splitMode: values.splitMode,
    ...(values.splitMode === "SELECTED" && { participantIds: values.picked }),
    expectedGroupId: options.groupId,
  };
  return options.mode === "create"
    ? { ...body, timezone: options.timezone }
    : { ...body, expectedUpdatedAt: options.lockToken };
}

/**
 * The posting line under the form preview: a new rule's first posting, an edited rule's next one, or none
 * while the rule is paused (by a member or because someone left) — nothing posts until it is resumed.
 */
export function previewPostingKey(rule: Pick<RecurringExpense, "paused"> | null): "form.firstPosting" | "form.nextPosting" | null {
  if (!rule) return "form.firstPosting";
  return rule.paused ? null : "form.nextPosting";
}
