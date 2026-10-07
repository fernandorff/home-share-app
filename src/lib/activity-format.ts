// Formats one side (from/to) of a recorded Activity Summary change (src/services/audit.service.ts
// AuditLog.changes) into a display string. Field-type-aware (money/boolean) instead of the raw
// `String(value)` the Summary feed used before (B7: "amount: 100 → 130" with no currency,
// "purchased: true → false" instead of Yes/No).

import { toCents } from './currency'
import { isValidPeriod } from './recurrence'

/** Fields whose stored value is money and should render through the group's currency formatter. */
const MONEY_FIELDS = new Set(['amount'])

/** Fields whose stored value is a boolean and should render as a translated Yes/No. */
const BOOLEAN_FIELDS = new Set(['purchased', 'isPurchased'])

/** Technical/internal fields with no user-facing value — the caller should skip the whole row. */
const HIDDEN_FIELDS = new Set(['linkedExpenseIds'])

/** Spec 008: a recurring rule's edit records raw ids and enum codes — shown as member names / labels. */
const MEMBER_FIELDS = new Set(['payerId'])
const MEMBER_LIST_FIELDS = new Set(['participantIds'])
const ENUM_FIELDS = new Set(['splitMode', 'pauseReason'])

/**
 * Formats one field's value for the Activity Summary feed.
 * Returns null to mean "hide this field entirely" (e.g. technical keys like `linkedExpenseIds`).
 * An empty/missing value (null/undefined/"") renders as an em dash rather than a blank string.
 */
export function formatChangeValue(
  field: string,
  value: unknown,
  fmt: {
    money: (value: string | number) => string
    yes: string
    no: string
    /** Name of a member id (payerId, participantIds); without it the raw id shows. */
    member?: (id: number) => string
    /** Label of an enum code (splitMode, pauseReason); without it the raw code shows. */
    enumValue?: (field: string, value: string) => string
  }
): string | null {
  if (HIDDEN_FIELDS.has(field)) return null
  if (value === null || value === undefined || value === '') return '—'
  if (MONEY_FIELDS.has(field)) return fmt.money(value as string | number)
  if (BOOLEAN_FIELDS.has(field) && typeof value === 'boolean') return value ? fmt.yes : fmt.no
  const { member, enumValue } = fmt
  if (MEMBER_FIELDS.has(field) && typeof value === 'number' && member) return member(value)
  if (MEMBER_LIST_FIELDS.has(field) && Array.isArray(value)) {
    if (value.length === 0) return '—'
    if (member) return value.map((id) => member(Number(id))).join(', ')
  }
  if (ENUM_FIELDS.has(field) && typeof value === 'string' && enumValue) return enumValue(field, value)
  return String(value)
}

/**
 * A `YYYY-MM` period as "November 2026" in the viewer's language ("novembro de 2026", "noviembre de 2026",
 * "novembre 2026"), for the middle of a sentence. UTC on both sides, so the month never drifts with the
 * viewer's timezone. A malformed period is returned as it came.
 */
export function periodLabel(period: string, locale: string): string {
  if (!isValidPeriod(period)) return period
  const [year, month] = period.split('-').map(Number)
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(year, month - 1, 1))
  )
}

/** A rule's skipped months ("2026-11", "2027-01") as "November 2026, January 2027" (Activity › Detailed). */
export function periodListLabel(periods: readonly unknown[], locale: string): string {
  if (periods.length === 0) return '—'
  return periods.map((p) => periodLabel(String(p), locale)).join(', ')
}

/**
 * Summary-feed phrase for an AuditLog entry that the generic `act.<ACTION>_<TYPE>` can't describe
 * (R2-03 links, R3-19 join-code regeneration). A shopping item's expense-link change is recorded as
 * UPDATE with only `linkedExpenseIds` (the resulting set), which B7 hides as a technical field — it
 * used to render as a bare "updated a shopping item". Returns the message key + ICU values, or null for the
 * generic phrase.
 */
export function summaryPhrase(
  entry: {
    action: string
    entityType: string
    changes: Record<string, unknown> | null
  },
  locale = 'en'
): { key: string; values?: Record<string, number | string> } | null {
  // R3-19: a join-code regeneration logs only a marker — never the code (admin-only, while the feed
  // is readable by every member).
  if (entry.entityType === 'GROUP' && entry.action === 'UPDATE' && entry.changes?.joinCodeChanged === true) {
    return { key: 'act.REGENERATE_CODE' }
  }
  // Spec 008: a skip (or its undo) records the period it concerns; name that month for the viewer.
  if (entry.entityType === 'RECURRING_EXPENSE' && (entry.action === 'SKIP' || entry.action === 'UNSKIP')) {
    const period = entry.changes?.period
    if (!isValidPeriod(period)) return null
    return { key: `act.${entry.action}_RECURRING_EXPENSE_MONTH`, values: { month: periodLabel(period, locale) } }
  }
  if (entry.entityType !== 'SHOPPING_ITEM' || entry.action !== 'UPDATE' || !entry.changes) return null
  const ids = entry.changes.linkedExpenseIds
  if (!Array.isArray(ids) || Object.keys(entry.changes).length !== 1) return null
  return { key: 'act.LINK_SHOPPING_ITEM', values: { count: ids.length } }
}

/**
 * Detailed-feed phrase for a membership revision (R2-27): "joined the house" / "added a member" /
 * "removed a member" / "left the house" instead of the generic "created a membership". null = keep
 * the generic "<action> <entity>" (a role change reads "updated a membership" + role before → after).
 *
 * A membership row is never deleted: leaving or being removed sets `leftAt` (groupService.removeMember)
 * and rejoining clears it (joinByCode), so those events are UPDATEs read off the `leftAt` transition
 * (I1). Who did it tells a self-leave from a kick. A snapshot without a `leftAt` key (legacy rows) is
 * no transition.
 */
export function membershipPhraseKey(r: {
  entityType: string
  action: string
  actorId: number | null
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
}): string | null {
  if (r.entityType !== 'GroupMember') return null
  if (r.action === 'CREATE') {
    return r.actorId !== null && r.after?.userId === r.actorId ? 'phrase.joinedHouse' : 'phrase.addedMember'
  }
  if (r.action === 'DELETE') return 'phrase.removedMember'
  if (r.action === 'UPDATE' && r.after) {
    const wasAway = r.before?.leftAt != null
    if (r.after.leftAt != null && !wasAway) {
      return r.actorId !== null && r.actorId === r.after.userId ? 'phrase.leftHouse' : 'phrase.removedMember'
    }
    if (r.after.leftAt == null && wasAway) return 'phrase.joinedHouse'
  }
  return null
}

/** One member's share of an expense, as the `split` pseudo-field carries it. */
export interface SplitShareValue {
  userId: number
  amount: string // reais with 2 decimals, so "10" and "10.00" are the same share
}

function isParticipant(v: unknown): v is { userId: number; amount: string | number } {
  return typeof v === 'object' && v !== null && typeof (v as { userId?: unknown }).userId === 'number'
}

/**
 * Adds the `split` pseudo-field (I4) to a snapshot that carries `participants` (an Expense snapshot:
 * userId + a Decimal string/number amount): one share per member, sorted by userId, amount
 * normalized to cents. Comparing it with `changedFields` then ignores a reorder and "10" vs
 * "10.00", yet flags money moving between members — which the curated Expense fields alone miss
 * ("No visible field changed" on a 50/50 → 70/30 edit). A snapshot WITHOUT participants (legacy rows,
 * other entities) gets no `split` key at all, so it is never read as a cleared or changed split.
 */
function addSplit(snapshot: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!snapshot || !Array.isArray(snapshot.participants)) return snapshot
  const split: SplitShareValue[] = snapshot.participants
    .filter(isParticipant)
    .map((p) => ({ userId: p.userId, amount: (toCents(p.amount) / 100).toFixed(2) }))
    .sort((a, b) => a.userId - b.userId)
  return { ...snapshot, split }
}

/**
 * Returns the revision with the `split` pseudo-field added to its `before` and `after` snapshots.
 * A `before` that never captured participants (a legacy revision) is not "an empty split": it takes
 * the new split, so the first edit after it is no false "— → shares" change (same rule as
 * audit-diff's splitsEqual: missing on either side = no change).
 */
export function withSplitField<R extends { before: Record<string, unknown> | null; after: Record<string, unknown> | null }>(
  r: R
): R {
  const before = addSplit(r.before)
  const after = addSplit(r.after)
  const untracked = before !== null && after !== null && 'split' in after && !('split' in before)
  return { ...r, before: untracked ? { ...before, split: after.split } : before, after }
}

const isEmptyValue = (v: unknown): boolean =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)

// Two empty values (null, "", [], missing) read the same in the feed ("—"), so they are no change.
const sameValue = (a: unknown, b: unknown): boolean =>
  (isEmptyValue(a) && isEmptyValue(b)) || JSON.stringify(a) === JSON.stringify(b)

/**
 * Fields the Detailed feed lists for a revision (R2-09). The current snapshot's non-empty fields
 * (the removed state for a DELETE), plus — for an UPDATE with a `before` — every field that WAS
 * filled and is now present but empty (null/""/[]). Without the second part a cleared field (notes
 * emptied) vanished from the row, and an update that only emptied it looked unchanged. A key
 * MISSING from `after` is not a clear: audit-extension snapshots are full rows (a real clear always
 * has the key), while a revision written by hand can carry fields the other lacks (the expense-link
 * revision has `linkedExpenses`, a rename has not). `preset` is the entity's curated field list
 * (undefined = every snapshot key); `hidden` are internal keys never shown when there is no preset.
 */
export function revisionFields(
  r: { action: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null },
  preset: readonly string[] | undefined,
  hidden: ReadonlySet<string>
): string[] {
  const snap = (r.action === 'DELETE' ? r.before : r.after) ?? {}
  const prev = r.action === 'UPDATE' ? r.before : null
  const keys = preset ?? Object.keys(snap).filter((k) => !hidden.has(k))
  return keys.filter(
    (k) =>
      !isEmptyValue(snap[k]) ||
      (prev !== null && k in snap && !isEmptyValue(prev[k]) && !sameValue(prev[k], snap[k]))
  )
}

/**
 * The subset of `fields` whose value differs between the previous and the current snapshot. A field
 * absent from `after` is not tracked there (see revisionFields), so it is never a difference.
 */
export function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: readonly string[]
): string[] {
  return fields.filter((f) => f in after && !sameValue(before[f], after[f]))
}

/** R3-19: a Group UPDATE whose payload set the join code — the audit extension stores the marker
 *  `joinCodeChanged: true`, never the code. */
export function isJoinCodeRegeneration(r: {
  entityType: string
  action: string
  after: Record<string, unknown> | null
}): boolean {
  return r.entityType === 'Group' && r.action === 'UPDATE' && r.after?.joinCodeChanged === true
}

/** R3-20: the Summary's message key for a Detailed revision (Prisma model "ShoppingItem" →
 *  "act.UPDATE_SHOPPING_ITEM"), so both tabs use one phrase per event whenever the Summary has one. */
export function summaryActKey(action: string, entityType: string): string {
  return `act.${action}_${entityType.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`
}

const NBSP = '\u00a0'

/** Text that never breaks (an amount like "R$ 100,00"): every space becomes a non-breaking one. */
export function keepTogether(text: string): string {
  return text.trim().replace(/\s+/g, NBSP)
}

/** R3-23: a person's name keeps its surname with the word before it ("Ana / QA" never splits) — only
 *  the LAST space is non-breaking, so a long name ("Maria Aparecida dos Santos Oliveira") still wraps
 *  on the others instead of overflowing a narrow line. Ends are trimmed and repeated spaces collapse. */
export function keepLastWordTogether(name: string): string {
  const words = name.trim().split(/\s+/)
  if (words.length < 2) return words[0] ?? ''
  return `${words.slice(0, -1).join(' ')}${NBSP}${words[words.length - 1]}`
}

/** R3-22 / R3-23: the Summary complement of a payment — "Bruno QA → Ana QA · R$100.00". Names keeping
 *  their surname together, the arrow stuck to the payer, the "·" stuck to the name before it (a line never opens
 *  with it), and the amount (stored in AuditLog.changes) telling repeated payments apart. Legacy entries without an
 *  amount get no " · …". */
export function settlementLine(from: string, to: string, amount: string | null): string {
  return `${keepLastWordTogether(from)}${NBSP}→ ${keepLastWordTogether(to)}${amount ? `${NBSP}· ${keepTogether(amount)}` : ''}`
}

/**
 * Spec 008 (criterion 13): which label an Activity entry shows when it has no person to name. Only the
 * writes the recurring service makes as the system (`runWithAuditContext({ system: true })`) read
 * "Automatic": the posting's Summary entry (`changes.recurring === true`), the posting's Expense CREATE
 * revision (its snapshot carries a `recurringExpenseId`) and the rule UPDATE revision of the auto-pause when
 * the payer or a selected participant left (`pauseReason` MEMBER_LEFT). The service writes no other
 * actor-less rule change and no actor-less Summary entry for a rule, so any other actor-less entry — e.g. a
 * person whose account is gone (FK SetNull) — keeps the neutral "Someone". Returns the `Activity.*` message
 * key. Takes the fields both feeds share, so Summary (`changes`) and Detailed (`after`) use the same rule.
 */
export function actorLabelKey(e: {
  actorId: number | null
  entityType: string
  action: string
  changes?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
}): 'automatic' | 'system' {
  if (e.actorId !== null) return 'system'
  if (e.changes?.recurring === true) return 'automatic'
  if (e.entityType === 'Expense' && e.action === 'CREATE' && e.after?.recurringExpenseId != null) return 'automatic'
  if (e.entityType === 'RecurringExpense' && e.action === 'UPDATE' && e.after?.pauseReason === 'MEMBER_LEFT') return 'automatic'
  return 'system'
}
