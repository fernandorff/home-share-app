// Turns an entity's chronological EntityRevision rows into a newest-first change history.
// The audit extension stores only the post-state (`after`) on updates, so the "before" of each
// change is simply the previous revision's `after` (CREATE seeds the chain; DELETE ends it).

export interface RawRevision {
  id: number
  action: string // CREATE | UPDATE | DELETE (Prisma extension writes these)
  actorId: number | null
  actorName: string | null
  createdAt: string // ISO
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
}

export interface FieldChange {
  field: string
  from: unknown
  to: unknown
}

export interface RevisionEntry {
  id: number
  action: 'CREATE' | 'UPDATE' | 'DELETE'
  actorName: string | null
  createdAt: string
  changes: FieldChange[] // only for UPDATE (fields that actually changed)
}

/** Expense fields worth showing in the history (skips internals: id/publicId/groupId/timestamps
 *  and the vestigial legacy columns). `payerId` renders as a member name in the UI. */
export const EXPENSE_HISTORY_FIELDS = [
  'description', 'amount', 'categories', 'platforms', 'paymentMethods', 'date', 'notes', 'payerId',
] as const

// null / undefined / "" / [] all mean "no value" — treat them as equal so an absent field
// (e.g. not captured in an older revision) doesn't show up as a spurious "— → —" change.
function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (isEmpty(a) && isEmpty(b)) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => x === b[i])
  }
  return a === b
}

/**
 * Build the display history for one expense from its raw revisions.
 * UPDATE rows diff against the previous revision's `after`; when there is no prior revision
 * (e.g. bulk-imported expenses have no per-row CREATE), the change is shown against an empty base.
 */
export function buildExpenseHistory(revisions: RawRevision[]): RevisionEntry[] {
  const chrono = [...revisions].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id
  )
  const entries: RevisionEntry[] = []
  let prevAfter: Record<string, unknown> | null = null

  for (const r of chrono) {
    const action = r.action as RevisionEntry['action']
    let changes: FieldChange[] = []
    if (action === 'UPDATE' && r.after) {
      const base = prevAfter ?? {}
      changes = EXPENSE_HISTORY_FIELDS
        .filter((f) => !valuesEqual(base[f], r.after![f]))
        .map((f) => ({ field: f, from: base[f] ?? null, to: r.after![f] ?? null }))
    }
    entries.push({ id: r.id, action, actorName: r.actorName, createdAt: r.createdAt, changes })
    if (r.after) prevAfter = r.after
  }

  return entries.reverse() // newest first for display
}
