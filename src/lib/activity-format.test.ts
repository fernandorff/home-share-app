import { describe, it, expect } from 'vitest'
import {
  actorLabelKey,
  changedFields,
  formatChangeValue,
  isJoinCodeRegeneration,
  keepLastWordTogether,
  keepTogether,
  membershipPhraseKey,
  periodLabel,
  periodListLabel,
  revisionFields,
  settlementLine,
  summaryActKey,
  summaryPhrase,
  withSplitField,
} from './activity-format'
const fmt = { money: (v: string | number) => `R$${Number(v).toFixed(2)}`, yes: 'Yes', no: 'No' }
describe('formatChangeValue', () => {
  it('formats money fields', () => expect(formatChangeValue('amount', '130', fmt)).toBe('R$130.00'))
  it('formats booleans', () => expect(formatChangeValue('purchased', false, fmt)).toBe('No'))
  it('hides technical fields', () => expect(formatChangeValue('linkedExpenseIds', ['x'], fmt)).toBeNull())
  it('shows empty values as an em dash', () => expect(formatChangeValue('currency', null, fmt)).toBe('—'))
})

describe('summaryPhrase (R2-03)', () => {
  const link = (ids: string[], extra: Record<string, unknown> = {}) =>
    ({ action: 'UPDATE', entityType: 'SHOPPING_ITEM', changes: { linkedExpenseIds: ids, ...extra } })
  it('names a link change with the resulting count', () =>
    expect(summaryPhrase(link(['a', 'b']))).toEqual({ key: 'act.LINK_SHOPPING_ITEM', values: { count: 2 } }))
  it('counts 0 when every link was removed', () =>
    expect(summaryPhrase(link([]))).toEqual({ key: 'act.LINK_SHOPPING_ITEM', values: { count: 0 } }))
  it('leaves other updates to the generic phrase', () => {
    expect(summaryPhrase({ action: 'UPDATE', entityType: 'SHOPPING_ITEM', changes: { name: { from: 'a', to: 'b' } } })).toBeNull()
    expect(summaryPhrase(link(['a'], { name: { from: 'a', to: 'b' } }))).toBeNull()
    expect(summaryPhrase({ action: 'UPDATE', entityType: 'GROUP', changes: null })).toBeNull()
  })
})

describe('membershipPhraseKey (R2-27)', () => {
  const rev = (action: string, actorId: number | null, userId: number) =>
    ({ entityType: 'GroupMember', action, actorId, before: null, after: action === 'DELETE' ? null : { userId, role: 'MEMBER' } })
  it('a member created by themselves joined the house', () =>
    expect(membershipPhraseKey(rev('CREATE', 7, 7))).toBe('phrase.joinedHouse'))
  it('a member created by someone else was added', () => {
    expect(membershipPhraseKey(rev('CREATE', 1, 7))).toBe('phrase.addedMember')
    expect(membershipPhraseKey(rev('CREATE', null, 7))).toBe('phrase.addedMember')
  })
  it('a deleted membership removed a member', () =>
    expect(membershipPhraseKey(rev('DELETE', 1, 7))).toBe('phrase.removedMember'))
  it('role-only updates and other entities keep the generic phrase', () => {
    expect(membershipPhraseKey(rev('UPDATE', 1, 7))).toBeNull()
    expect(membershipPhraseKey({ entityType: 'Expense', action: 'CREATE', actorId: 1, before: null, after: {} })).toBeNull()
  })
})

// I1: a membership is never deleted — leaving/being removed sets `leftAt`, rejoining clears it —
// so those events are GroupMember UPDATEs that the phrase must read off the leftAt transition.
describe('membershipPhraseKey — leave / kick / rejoin transitions (I1)', () => {
  const LEFT = '2026-10-03T12:00:00.000Z'
  const upd = (
    actorId: number | null,
    userId: number,
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null
  ) => ({ entityType: 'GroupMember', action: 'UPDATE', actorId, before, after: after && { userId, role: 'MEMBER', ...after } })

  it('leaving by their own hand reads "left the house"', () =>
    expect(membershipPhraseKey(upd(7, 7, { leftAt: null }, { leftAt: LEFT }))).toBe('phrase.leftHouse'))
  it('being removed by someone else reads "removed a member"', () => {
    expect(membershipPhraseKey(upd(1, 7, { leftAt: null }, { leftAt: LEFT }))).toBe('phrase.removedMember')
    expect(membershipPhraseKey(upd(null, 7, { leftAt: null }, { leftAt: LEFT }))).toBe('phrase.removedMember')
  })
  it('a leave with no previous revision to borrow from still reads as a leave', () =>
    expect(membershipPhraseKey(upd(7, 7, null, { leftAt: LEFT }))).toBe('phrase.leftHouse'))
  it('rejoining (leftAt cleared) reads "joined the house"', () =>
    expect(membershipPhraseKey(upd(7, 7, { leftAt: LEFT, role: 'ADMIN' }, { leftAt: null }))).toBe('phrase.joinedHouse'))
  it('an update that does not move leftAt keeps the generic phrase', () => {
    expect(membershipPhraseKey(upd(1, 7, { leftAt: null, role: 'MEMBER' }, { leftAt: null, role: 'ADMIN' }))).toBeNull()
    expect(membershipPhraseKey(upd(1, 7, { leftAt: LEFT }, { leftAt: LEFT }))).toBeNull()
  })
  it('a snapshot without a leftAt key (legacy revisions) is not read as a transition', () => {
    expect(membershipPhraseKey(upd(1, 7, { role: 'MEMBER' }, { role: 'ADMIN' }))).toBeNull()
    expect(membershipPhraseKey(upd(1, 7, null, null))).toBeNull()
  })
})

describe('revisionFields / changedFields (R2-09: cleared fields stay visible)', () => {
  const preset = ['description', 'notes', 'amount']
  const hidden = new Set(['id', 'secretThing'])
  const upd = (before: Record<string, unknown> | null, after: Record<string, unknown>) =>
    ({ action: 'UPDATE', before, after })

  it('keeps a cleared field in the shown set and flags it as changed', () => {
    const r = upd({ description: 'Tea', notes: 'a' }, { description: 'Tea', notes: '' })
    const fields = revisionFields(r, preset, hidden)
    expect(fields).toEqual(['description', 'notes'])
    expect(changedFields(r.before!, r.after, fields)).toEqual(['notes'])
  })
  it('a null value counts as cleared too (the key exists in a full-row snapshot)', () => {
    const r = upd({ description: 'Tea', notes: 'a' }, { description: 'Tea', notes: null })
    expect(changedFields(r.before!, r.after, revisionFields(r, preset, hidden))).toEqual(['notes'])
  })
  it('a key missing from the new snapshot is not cleared — it is just not tracked there', () => {
    const r = upd({ description: 'Tea', notes: 'a' }, { description: 'Tea' })
    const fields = revisionFields(r, preset, hidden)
    expect(fields).toEqual(['description'])
    expect(changedFields(r.before!, r.after, fields)).toEqual([])
  })
  it('renaming a linked item does not report its links as cleared (link revisions carry linkedExpenses, extension ones do not)', () => {
    const r = upd({ name: 'A', linkedExpenses: 2 }, { name: 'B' })
    const fields = revisionFields(r, ['name', 'isPurchased', 'linkedExpenses'], hidden)
    expect(fields).toEqual(['name'])
    expect(changedFields(r.before!, r.after, fields)).toEqual(['name'])
  })
  it('changedFields ignores a field absent from the new snapshot', () => {
    expect(changedFields({ name: 'A', linkedExpenses: 2 }, { name: 'B' }, ['name', 'linkedExpenses'])).toEqual(['name'])
  })
  it('an identical update has no changed fields', () => {
    const r = upd({ description: 'Tea', amount: '5.00' }, { description: 'Tea', amount: '5.00' })
    const fields = revisionFields(r, preset, hidden)
    expect(fields).toEqual(['description', 'amount'])
    expect(changedFields(r.before!, r.after, fields)).toEqual([])
  })
  it('does not add a field that was already empty before', () => {
    const r = upd({ description: 'Tea', notes: '' }, { description: 'Tea', notes: null })
    expect(revisionFields(r, preset, hidden)).toEqual(['description'])
  })
  it('two empty values (null, "", [], missing) are not a change', () => {
    expect(changedFields({ notes: null, tags: [] }, { notes: '', tags: undefined }, ['notes', 'tags'])).toEqual([])
  })
  it('without a before, or for CREATE/DELETE, only the current (or removed) snapshot is listed', () => {
    expect(revisionFields(upd(null, { description: 'Tea', notes: '' }), preset, hidden)).toEqual(['description'])
    expect(revisionFields({ action: 'CREATE', before: { notes: 'x' }, after: { description: 'Tea' } }, preset, hidden)).toEqual(['description'])
    expect(revisionFields({ action: 'DELETE', before: { description: 'Tea', notes: 'x' }, after: null }, preset, hidden)).toEqual(['description', 'notes'])
  })
  it('without a preset, takes the current snapshot keys minus the hidden ones (a cleared key stays)', () => {
    const r = upd({ id: 1, label: 'a', note: 'x', secretThing: 'y' }, { id: 1, label: '', other: 'b', secretThing: 'z' })
    expect(revisionFields(r, undefined, hidden)).toEqual(['label', 'other'])
  })
})

// I4: an Expense snapshot carries `participants` (userId + Decimal-string amount) but the preset
// leaves them out, so an edit that only moved money between members read "No visible field changed".
// `split` is a pseudo-field built from them, compared by userId + cents.
describe('withSplitField / split pseudo-field (I4)', () => {
  const preset = ['description', 'amount', 'split']
  const hidden = new Set<string>()
  const expense = (shares: Array<[number, string | number]>) => ({
    description: 'Rent',
    amount: '100.00',
    participants: shares.map(([userId, amount], i) => ({ id: i + 1, userId, amount })),
  })
  const edit = (before: Record<string, unknown> | null, after: Record<string, unknown>) =>
    withSplitField({ action: 'UPDATE', before, after })
  const changed = (r: { action: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }) => {
    const fields = revisionFields(r, preset, hidden)
    return { fields, changed: changedFields(r.before!, r.after!, fields) }
  }

  it('builds split from participants, one share per member sorted by userId, money in 2 decimals', () => {
    const r = withSplitField<{ before: null; after: Record<string, unknown> }>({ before: null, after: expense([[2, '30'], [1, '70.5']]) })
    expect(r.after.split).toEqual([{ userId: 1, amount: '70.50' }, { userId: 2, amount: '30.00' }])
  })
  it('50/50 → 70/30 is a change, and a split-only edit lists the split as the changed field', () => {
    const r = edit(expense([[1, '50.00'], [2, '50.00']]), expense([[1, '70.00'], [2, '30.00']]))
    expect(changed(r)).toEqual({ fields: ['description', 'amount', 'split'], changed: ['split'] })
  })
  it('the same shares in another order are not a change', () => {
    const r = edit(expense([[1, '50.00'], [2, '50.00']]), expense([[2, '50.00'], [1, '50.00']]))
    expect(changed(r).changed).toEqual([])
  })
  it('"10" and "10.00" (Decimal.toString vs a fixed-scale amount) are not a change', () => {
    const r = edit(expense([[1, '10'], [2, '10']]), expense([[1, '10.00'], [2, 10]]))
    expect(changed(r).changed).toEqual([])
  })
  it('a member added to or dropped from the split is a change', () => {
    expect(changed(edit(expense([[1, '50.00'], [2, '50.00']]), expense([[1, '100.00']]))).changed).toEqual(['split'])
  })
  it('a snapshot without participants (legacy revision) gets no split key and never counts as a change', () => {
    const legacy = { description: 'Rent', amount: '100.00' }
    expect(withSplitField({ before: legacy, after: null }).before).not.toHaveProperty('split')
    // legacy before → the first edit with participants is not a "— → shares" change (it was not captured, not empty)
    expect(changed(edit(legacy, expense([[1, '50.00'], [2, '50.00']]))).changed).toEqual([])
    // participants before → a new snapshot without them: not tracked there, so not a clear
    expect(changed(edit(expense([[1, '50.00'], [2, '50.00']]), legacy))).toEqual({ fields: ['description', 'amount'], changed: [] })
  })
  it('a before-less legacy snapshot is not mutated when it takes the new split', () => {
    const legacy = { description: 'Rent', amount: '100.00' }
    edit(legacy, expense([[1, '50.00']]))
    expect(legacy).toEqual({ description: 'Rent', amount: '100.00' })
  })
  it('leaves snapshots of other entities untouched and null snapshots null', () => {
    const member = { userId: 7, role: 'MEMBER' }
    expect(withSplitField({ before: null, after: member }).after).toEqual(member)
    expect(withSplitField({ before: null, after: null })).toEqual({ before: null, after: null })
  })
})

describe('summaryPhrase — join-code regeneration (R3-19)', () => {
  it('names the event from its marker', () =>
    expect(summaryPhrase({ action: 'UPDATE', entityType: 'GROUP', changes: { joinCodeChanged: true } }))
      .toEqual({ key: 'act.REGENERATE_CODE' }))
  it('a currency change keeps the generic phrase', () =>
    expect(summaryPhrase({ action: 'UPDATE', entityType: 'GROUP', changes: { currency: { from: 'BRL', to: 'USD' } } })).toBeNull())
})

describe('isJoinCodeRegeneration (R3-19)', () => {
  it('is a Group UPDATE carrying the marker', () => {
    expect(isJoinCodeRegeneration({ entityType: 'Group', action: 'UPDATE', after: { name: 'H', joinCodeChanged: true } })).toBe(true)
    expect(isJoinCodeRegeneration({ entityType: 'Group', action: 'UPDATE', after: { name: 'H', currency: 'USD' } })).toBe(false)
    expect(isJoinCodeRegeneration({ entityType: 'User', action: 'UPDATE', after: { passwordChanged: true } })).toBe(false)
  })
})

describe('summaryActKey (R3-20)', () => {
  it('maps a Prisma model name to the Summary key', () => {
    expect(summaryActKey('UPDATE', 'ShoppingItem')).toBe('act.UPDATE_SHOPPING_ITEM')
    expect(summaryActKey('CREATE', 'PaymentMethod')).toBe('act.CREATE_PAYMENT_METHOD')
    expect(summaryActKey('DELETE', 'Expense')).toBe('act.DELETE_EXPENSE')
    expect(summaryActKey('CREATE', 'Group')).toBe('act.CREATE_GROUP')
  })
})

describe('keepLastWordTogether (R3-23)', () => {
  it('glues a two-word name with one non-breaking space', () =>
    expect(keepLastWordTogether('Ana QA')).toBe('Ana QA'))
  it('glues only the last space of a longer name, so it can still wrap', () =>
    expect(keepLastWordTogether('Maria Aparecida dos Santos Oliveira')).toBe('Maria Aparecida dos Santos Oliveira'))
  it('leaves a single word unchanged', () => expect(keepLastWordTogether('Ana')).toBe('Ana'))
  it('trims the ends and collapses repeated spaces', () => {
    expect(keepLastWordTogether('  Ana   QA  ')).toBe('Ana QA')
    expect(keepLastWordTogether('Maria  Aparecida   Oliveira')).toBe('Maria Aparecida Oliveira')
  })
  it('returns an empty string for blank input', () => {
    expect(keepLastWordTogether('')).toBe('')
    expect(keepLastWordTogether('   ')).toBe('')
  })
})

describe('keepTogether / settlementLine (R3-22, R3-23)', () => {
  it('glues a name with non-breaking spaces', () =>
    expect(keepTogether('Júlia Caminho Feliz')).toBe('Júlia\u00a0Caminho\u00a0Feliz'))
  it('names a payment with unbreakable names, the arrow stuck to the payer and the amount', () =>
    expect(settlementLine('Bruno QA', 'Ana QA', 'R$100.00')).toBe('Bruno\u00a0QA\u00a0→ Ana\u00a0QA\u00a0· R$100.00'))
  it('lets a long name wrap, gluing only its last word', () =>
    expect(settlementLine('Maria Aparecida Oliveira', 'Ana QA', null)).toBe('Maria Aparecida Oliveira → Ana QA'))
  it('leaves the amount out when the entry has none (legacy rows)', () =>
    expect(settlementLine('Bruno QA', 'Ana QA', null)).toBe('Bruno\u00a0QA\u00a0→ Ana\u00a0QA'))
})

// Spec 008 criterion 13: a posting made by the system has no actor — Activity names it "Automatic",
// while every other actor-less entry keeps the neutral "Someone".
describe('actorLabelKey (spec 008)', () => {
  const POSTED = { amount: '1800.00', recurring: true, period: '2026-11' }

  it('Summary: a recurring posting (changes.recurring) is automatic', () =>
    expect(actorLabelKey({ actorId: null, entityType: 'EXPENSE', action: 'CREATE', changes: POSTED })).toBe('automatic'))
  it('Detailed: an Expense CREATE revision with a recurringExpenseId is automatic', () =>
    expect(actorLabelKey({ actorId: null, entityType: 'Expense', action: 'CREATE', after: { description: 'Rent', recurringExpenseId: 4 } })).toBe('automatic'))
  it('Detailed: the auto-pause when a member left (the only system write on a rule) is automatic', () =>
    expect(
      actorLabelKey({
        actorId: null,
        entityType: 'RecurringExpense',
        action: 'UPDATE',
        after: { pausedAt: '2026-10-05T11:00:00.000Z', pauseReason: 'MEMBER_LEFT' },
      })
    ).toBe('automatic'))

  // E1: the service writes no other actor-less rule change, and no actor-less Summary entry for a rule — an
  // actor-less rule row is someone whose account is gone (FK SetNull), not the system.
  it('any other actor-less rule entry stays "Someone", in both feeds', () => {
    expect(actorLabelKey({ actorId: null, entityType: 'RecurringExpense', action: 'UPDATE', after: { pausedAt: '2026-10-05T11:00:00.000Z', pauseReason: 'MANUAL' } })).toBe('system')
    expect(actorLabelKey({ actorId: null, entityType: 'RecurringExpense', action: 'UPDATE', after: { description: 'Rent', pauseReason: null } })).toBe('system')
    expect(actorLabelKey({ actorId: null, entityType: 'RecurringExpense', action: 'CREATE', after: { description: 'Rent', pauseReason: null } })).toBe('system')
    expect(actorLabelKey({ actorId: null, entityType: 'RecurringExpense', action: 'DELETE', after: null })).toBe('system')
    expect(actorLabelKey({ actorId: null, entityType: 'RECURRING_EXPENSE', action: 'PAUSE', changes: null })).toBe('system')
    expect(actorLabelKey({ actorId: null, entityType: 'RECURRING_EXPENSE', action: 'CREATE', changes: { amount: '1800.00' } })).toBe('system')
    expect(actorLabelKey({ actorId: null, entityType: 'RECURRING_EXPENSE', action: 'SKIP', changes: { period: '2026-11' } })).toBe('system')
  })

  it('any other actor-less entry stays "Someone"', () => {
    expect(actorLabelKey({ actorId: null, entityType: 'EXPENSE', action: 'CREATE', changes: { amount: '10.00' } })).toBe('system')
    expect(actorLabelKey({ actorId: null, entityType: 'EXPENSE', action: 'CREATE', changes: null })).toBe('system')
    expect(actorLabelKey({ actorId: null, entityType: 'Expense', action: 'CREATE', after: { description: 'Tea', recurringExpenseId: null } })).toBe('system')
    expect(actorLabelKey({ actorId: null, entityType: 'Expense', action: 'CREATE', after: null })).toBe('system')
    expect(actorLabelKey({ actorId: null, entityType: 'GroupMember', action: 'CREATE', after: { userId: 7 } })).toBe('system')
  })
  it('the marker must be exactly true, and an Expense UPDATE that merely carries the id is not a posting', () => {
    expect(actorLabelKey({ actorId: null, entityType: 'EXPENSE', action: 'CREATE', changes: { recurring: 'true' } })).toBe('system')
    expect(actorLabelKey({ actorId: null, entityType: 'EXPENSE', action: 'CREATE', changes: { recurring: false } })).toBe('system')
    expect(actorLabelKey({ actorId: null, entityType: 'Expense', action: 'UPDATE', after: { recurringExpenseId: 4 } })).toBe('system')
  })
  it('an entry with an actor is never automatic (the page shows the person)', () => {
    expect(actorLabelKey({ actorId: 3, entityType: 'EXPENSE', action: 'CREATE', changes: POSTED })).toBe('system')
    expect(actorLabelKey({ actorId: 3, entityType: 'RECURRING_EXPENSE', action: 'PAUSE', changes: null })).toBe('system')
  })
})

// A rule's edit is recorded as { field: { from, to } } with raw ids and enum codes; the Summary must show
// names, not "payer: 3 → 5" / "split: ALL → SELECTED".
describe('formatChangeValue — recurring rule fields (spec 008)', () => {
  const named = {
    ...fmt,
    member: (id: number) => `User ${id}`,
    enumValue: (field: string, value: string) => `${field}=${value}`,
  }
  it('shows the payer as a member name', () => expect(formatChangeValue('payerId', 3, named)).toBe('User 3'))
  it('shows the people as a list of names, and "everyone" (an empty list) as a dash', () => {
    expect(formatChangeValue('participantIds', [1, 2], named)).toBe('User 1, User 2')
    expect(formatChangeValue('participantIds', [], named)).toBe('—')
  })
  it('translates the split mode and the pause reason', () => {
    expect(formatChangeValue('splitMode', 'SELECTED', named)).toBe('splitMode=SELECTED')
    expect(formatChangeValue('pauseReason', 'MEMBER_LEFT', named)).toBe('pauseReason=MEMBER_LEFT')
  })
  it('formats the amount and keeps the day as a plain number', () => {
    expect(formatChangeValue('amount', '1800.00', named)).toBe('R$1800.00')
    expect(formatChangeValue('dayOfMonth', 5, named)).toBe('5')
  })
  it('without resolvers the raw value passes through (older callers)', () => {
    expect(formatChangeValue('payerId', 3, fmt)).toBe('3')
    expect(formatChangeValue('splitMode', 'ALL', fmt)).toBe('ALL')
  })
})

// A skip is recorded as { period: "2026-11" }; the Summary names the month in the viewer's language.
describe('periodLabel (spec 008)', () => {
  it('writes the month and year in the language of the viewer', () => {
    expect(periodLabel('2026-11', 'en')).toBe('November 2026')
    expect(periodLabel('2026-11', 'pt')).toBe('novembro de 2026')
    expect(periodLabel('2026-11', 'es')).toBe('noviembre de 2026')
    expect(periodLabel('2026-11', 'fr')).toBe('novembre 2026')
  })
  it('does not drift across a timezone: the first and last months of a year', () => {
    expect(periodLabel('2027-01', 'en')).toBe('January 2027')
    expect(periodLabel('2026-12', 'en')).toBe('December 2026')
  })
  it('returns a malformed period as it came', () => expect(periodLabel('nope', 'en')).toBe('nope'))
})

describe('summaryPhrase — skipped months (spec 008)', () => {
  const skip = (action: string, changes: Record<string, unknown> | null) =>
    ({ action, entityType: 'RECURRING_EXPENSE', changes })
  it('names the month of a skip and of an undone skip', () => {
    expect(summaryPhrase(skip('SKIP', { period: '2026-11' }), 'en'))
      .toEqual({ key: 'act.SKIP_RECURRING_EXPENSE_MONTH', values: { month: 'November 2026' } })
    expect(summaryPhrase(skip('UNSKIP', { period: '2026-11' }), 'pt'))
      .toEqual({ key: 'act.UNSKIP_RECURRING_EXPENSE_MONTH', values: { month: 'novembro de 2026' } })
  })
  it('keeps the generic phrase without a valid period, and for the other rule actions', () => {
    expect(summaryPhrase(skip('SKIP', null), 'en')).toBeNull()
    expect(summaryPhrase(skip('SKIP', {}), 'en')).toBeNull()
    expect(summaryPhrase(skip('SKIP', { period: '2026-13' }), 'en')).toBeNull()
    expect(summaryPhrase(skip('SKIP', { period: 202611 }), 'en')).toBeNull()
    expect(summaryPhrase(skip('PAUSE', { period: '2026-11' }), 'en')).toBeNull()
    expect(summaryPhrase({ action: 'SKIP', entityType: 'EXPENSE', changes: { period: '2026-11' } }, 'en')).toBeNull()
  })
})

// E3: a rule's skipped months in Activity › Detailed read as months, not "2026-11".
describe('periodListLabel (spec 008)', () => {
  it("names each month in the viewer's language, in the stored order", () => {
    expect(periodListLabel(['2026-11', '2027-01'], 'en')).toBe('November 2026, January 2027')
    expect(periodListLabel(['2026-11'], 'pt')).toBe('novembro de 2026')
  })
  it('keeps a malformed value as it came', () => expect(periodListLabel(['2026-13', 'x'], 'en')).toBe('2026-13, x'))
  it('an empty list is the em dash every empty value shows', () => expect(periodListLabel([], 'en')).toBe('—'))
})
