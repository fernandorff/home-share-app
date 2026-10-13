// Date rules of recurring expenses (spec 008). Pure and isomorphic: the poster uses them on the server
// with the rule's stored timezone, the rule form uses them in the browser for its preview.
// Dates are `YYYY-MM-DD` strings (a local calendar date, no time) and periods are `YYYY-MM` strings —
// both sort correctly as strings, so comparisons are plain `<`/`>=`.

const MAX_TIME_ZONE_LENGTH = 64

/** A rule as eligibility sees it: its day and the first local date it may post on. */
export interface EligibilityRule {
  dayOfMonth: number
  /** `YYYY-MM-DD` — the creation date, reset on every resume (no back-fill). */
  activeFrom: string
}

/** A rule as the upcoming list sees it. */
export interface UpcomingRule {
  dayOfMonth: number
  paused: boolean
  skippedPeriods: readonly string[]
}

export interface UpcomingPeriod {
  period: string
  dueOn: string
  skipped: boolean
}

/** True for an IANA zone (≤ 64 chars) that `Intl.DateTimeFormat` accepts. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > MAX_TIME_ZONE_LENGTH) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

const PERIOD_FORMAT = /^\d{4}-(0[1-9]|1[0-2])$/

/** True for a `YYYY-MM` period with a real month (01–12). */
export function isValidPeriod(period: unknown): period is string {
  return typeof period === 'string' && PERIOD_FORMAT.test(period)
}

/** `YYYY-MM-DD` of `now` as a calendar date in `tz` (never the server's date). */
export function localToday(tz: string, now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

/** `YYYY-MM` of a `YYYY-MM-DD` date. */
export function periodOf(date: string): string {
  return date.slice(0, 7)
}

function splitPeriod(period: string): [year: number, month: number] {
  return [Number(period.slice(0, 4)), Number(period.slice(5, 7))]
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** `period` shifted by `n` months (negative goes back). */
export function addMonths(period: string, n: number): string {
  const [year, month] = splitPeriod(period)
  const index = year * 12 + (month - 1) + n
  return `${Math.floor(index / 12)}-${pad2((index % 12 + 12) % 12 + 1)}`
}

/** Due date of `period`: `dayOfMonth` clamped to the month's last day (31 → 30 Apr, 28/29 Feb). */
export function dueOn(period: string, dayOfMonth: number): string {
  const [year, month] = splitPeriod(period)
  // Day 0 of the next month is the last day of this one.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${period}-${pad2(Math.min(dayOfMonth, lastDay))}`
}

/**
 * Periods to post, oldest first: from the later of `activeFrom`'s month and the month after
 * `lastClosedPeriod` (the rule's highest ledger period), while the due date is on or before `today`,
 * keeping only due dates on or after `activeFrom`. At most `max` periods.
 */
export function eligiblePeriods(
  rule: EligibilityRule,
  today: string,
  lastClosedPeriod: string | null,
  max = 12
): string[] {
  const first = periodOf(rule.activeFrom)
  const afterClosed = lastClosedPeriod ? addMonths(lastClosedPeriod, 1) : first
  const periods: string[] = []
  for (
    let period = afterClosed > first ? afterClosed : first;
    periods.length < max && dueOn(period, rule.dayOfMonth) <= today;
    period = addMonths(period, 1)
  ) {
    if (dueOn(period, rule.dayOfMonth) >= rule.activeFrom) periods.push(period)
  }
  return periods
}

/**
 * The next `n` periods whose due date is on or after `today` and that have no ledger row yet (after
 * `lastClosedPeriod`), each flagged when it is in `skippedPeriods`. Empty while the rule is paused.
 */
export function upcomingPeriods(
  rule: UpcomingRule,
  today: string,
  lastClosedPeriod: string | null,
  n = 3
): UpcomingPeriod[] {
  if (rule.paused) return []
  const current = periodOf(today)
  const afterClosed = lastClosedPeriod ? addMonths(lastClosedPeriod, 1) : current
  const upcoming: UpcomingPeriod[] = []
  for (let period = afterClosed > current ? afterClosed : current; upcoming.length < n; period = addMonths(period, 1)) {
    const due = dueOn(period, rule.dayOfMonth)
    if (due < today) continue
    upcoming.push({ period, dueOn: due, skipped: rule.skippedPeriods.includes(period) })
  }
  return upcoming
}
