import { describe, it, expect } from 'vitest'
import { buildExpenseHistory, RawRevision } from './audit-diff'

function rev(partial: Partial<RawRevision> & Pick<RawRevision, 'id' | 'action' | 'createdAt'>): RawRevision {
  return { actorId: null, actorName: null, before: null, after: null, ...partial }
}

describe('buildExpenseHistory', () => {
  it('returns entries newest-first', () => {
    const history = buildExpenseHistory([
      rev({ id: 1, action: 'CREATE', createdAt: '2026-01-01T10:00:00Z', after: { description: 'A', amount: '10.00' } }),
      rev({ id: 2, action: 'UPDATE', createdAt: '2026-01-02T10:00:00Z', after: { description: 'B', amount: '10.00' } }),
    ])
    expect(history.map((e) => e.id)).toEqual([2, 1])
  })

  it('CREATE has no field changes', () => {
    const [entry] = buildExpenseHistory([
      rev({ id: 1, action: 'CREATE', createdAt: '2026-01-01T10:00:00Z', after: { description: 'A', amount: '10.00' } }),
    ])
    expect(entry.action).toBe('CREATE')
    expect(entry.changes).toEqual([])
  })

  it('UPDATE diffs only changed fields against the previous revision', () => {
    const [entry] = buildExpenseHistory([
      rev({ id: 1, action: 'CREATE', createdAt: '2026-01-01T10:00:00Z', after: { description: 'A', amount: '10.00', notes: 'x' } }),
      rev({ id: 2, action: 'UPDATE', createdAt: '2026-01-02T10:00:00Z', after: { description: 'A', amount: '25.50', notes: 'x' } }),
    ])
    expect(entry.changes).toEqual([{ field: 'amount', from: '10.00', to: '25.50' }])
  })

  it('treats array fields (categories) by value, not reference', () => {
    const history = buildExpenseHistory([
      rev({ id: 1, action: 'CREATE', createdAt: '2026-01-01T10:00:00Z', after: { categories: ['food'] } }),
      rev({ id: 2, action: 'UPDATE', createdAt: '2026-01-02T10:00:00Z', after: { categories: ['food'] } }), // unchanged
      rev({ id: 3, action: 'UPDATE', createdAt: '2026-01-03T10:00:00Z', after: { categories: ['food', 'home'] } }),
    ])
    // newest-first: [3, 2, 1]
    expect(history[0].changes).toEqual([{ field: 'categories', from: ['food'], to: ['food', 'home'] }])
    expect(history[1].changes).toEqual([]) // no real change
  })

  it('DELETE carries no field diff', () => {
    const [entry] = buildExpenseHistory([
      rev({ id: 1, action: 'CREATE', createdAt: '2026-01-01T10:00:00Z', after: { description: 'A' } }),
      rev({ id: 2, action: 'DELETE', createdAt: '2026-01-02T10:00:00Z', before: { description: 'A' } }),
    ]).filter((e) => e.action === 'DELETE')
    expect(entry.action).toBe('DELETE')
    expect(entry.changes).toEqual([])
  })

  it('first-seen UPDATE without a prior CREATE diffs against an empty base', () => {
    // Bulk-imported expenses have no per-row CREATE revision.
    const [entry] = buildExpenseHistory([
      rev({ id: 5, action: 'UPDATE', createdAt: '2026-02-01T10:00:00Z', after: { description: 'Imported', amount: '99.00' } }),
    ])
    expect(entry.changes).toEqual([
      { field: 'description', from: null, to: 'Imported' },
      { field: 'amount', from: null, to: '99.00' },
    ])
  })

  it('treats null / undefined / "" / [] as equal-empty (no spurious change)', () => {
    const [entry] = buildExpenseHistory([
      rev({ id: 1, action: 'CREATE', createdAt: '2026-01-01T10:00:00Z', after: { notes: '', categories: [] } }),
      rev({ id: 2, action: 'UPDATE', createdAt: '2026-01-02T10:00:00Z', after: { notes: null, amount: '5.00' } }),
    ])
    // notes '' -> null is not a change; categories [] -> absent is not a change; only amount is new.
    expect(entry.changes).toEqual([{ field: 'amount', from: null, to: '5.00' }])
  })

  it('sorts by createdAt then id regardless of input order', () => {
    const history = buildExpenseHistory([
      rev({ id: 2, action: 'UPDATE', createdAt: '2026-01-02T10:00:00Z', after: { amount: '2.00' } }),
      rev({ id: 1, action: 'CREATE', createdAt: '2026-01-01T10:00:00Z', after: { amount: '1.00' } }),
    ])
    expect(history.map((e) => e.id)).toEqual([2, 1])
    expect(history[0].changes).toEqual([{ field: 'amount', from: '1.00', to: '2.00' }])
  })

  it('records a split change between two revisions', () => {
    const base = { description: 'Dinner', amount: '100', categories: [], platforms: [], paymentMethods: [], date: '2026-09-21', notes: null, payerId: 1 }
    const p = (a: string, b: string) => [
      { userId: 2, amount: b, user: { id: 2, name: 'Bruno' } },
      { userId: 1, amount: a, user: { id: 1, name: 'Ana' } },
    ]
    const history = buildExpenseHistory([
      rev({ id: 1, action: 'CREATE', actorName: 'Ana', createdAt: '2026-09-27T10:00:00Z', after: { ...base, participants: p('70', '30') } }),
      rev({ id: 2, action: 'UPDATE', actorName: 'Ana', createdAt: '2026-09-27T10:05:00Z', after: { ...base, participants: p('50', '50') } }),
    ])
    expect(history[0].changes).toEqual([{
      field: 'participants',
      from: [{ userId: 1, name: 'Ana', amount: '70' }, { userId: 2, name: 'Bruno', amount: '30' }],
      to: [{ userId: 1, name: 'Ana', amount: '50' }, { userId: 2, name: 'Bruno', amount: '50' }],
    }])
  })

  it('does not report a split change when only participant row ids changed', () => {
    const row = (id: number) => ({ id, userId: 1, amount: '100', user: { id: 1, name: 'Ana' } })
    const history = buildExpenseHistory([
      rev({ id: 1, action: 'CREATE', actorName: 'Ana', createdAt: '2026-09-27T10:00:00Z', after: { amount: '100', participants: [row(10)] } }),
      rev({ id: 2, action: 'UPDATE', actorName: 'Ana', createdAt: '2026-09-27T10:05:00Z', after: { amount: '100', participants: [row(11)] } }),
    ])
    expect(history[0].changes).toEqual([])
  })

  it('does not report a split change when the later revision has no participants captured', () => {
    const p = (a: string, b: string) => [
      { userId: 1, amount: a, user: { id: 1, name: 'Ana' } },
      { userId: 2, amount: b, user: { id: 2, name: 'Bruno' } },
    ]
    const history = buildExpenseHistory([
      rev({ id: 1, action: 'CREATE', actorName: 'Ana', createdAt: '2026-09-27T10:00:00Z', after: { amount: '100', participants: p('70', '30') } }),
      // No `participants` key at all on this revision (e.g. an audit path that doesn't capture it).
      rev({ id: 2, action: 'UPDATE', actorName: 'Ana', createdAt: '2026-09-27T10:05:00Z', after: { amount: '150' } }),
    ])
    expect(history[0].changes).toEqual([{ field: 'amount', from: '100', to: '150' }])
  })

  it('does not report a split change when the earlier revision has no participants captured', () => {
    const p = (a: string, b: string) => [
      { userId: 1, amount: a, user: { id: 1, name: 'Ana' } },
      { userId: 2, amount: b, user: { id: 2, name: 'Bruno' } },
    ]
    const history = buildExpenseHistory([
      // No `participants` key at all on this revision (e.g. a bulk-imported expense's CREATE).
      rev({ id: 1, action: 'CREATE', actorName: 'Ana', createdAt: '2026-09-27T10:00:00Z', after: { amount: '100' } }),
      rev({ id: 2, action: 'UPDATE', actorName: 'Ana', createdAt: '2026-09-27T10:05:00Z', after: { amount: '100', participants: p('70', '30') } }),
    ])
    expect(history[0].changes).toEqual([])
  })
})

// Spec 008: the expense detail's history names the system actor of a recurring posting "Automatic".
describe('buildExpenseHistory — actor label (spec 008)', () => {
  const created = (partial: Partial<RawRevision>) =>
    buildExpenseHistory([rev({ id: 1, action: 'CREATE', createdAt: '2026-11-05T11:00:00Z', ...partial })])[0]

  it('a recurring posting (no actor, snapshot with a recurringExpenseId) is automatic', () =>
    expect(created({ after: { description: 'Rent', recurringExpenseId: 4 } }).actorLabel).toBe('automatic'))
  it('any other actor-less revision stays "someone"', () => {
    expect(created({ after: { description: 'Tea', recurringExpenseId: null } }).actorLabel).toBe('system')
    expect(created({ after: { description: 'Tea' } }).actorLabel).toBe('system')
  })
  it('a revision made by a person is never automatic', () =>
    expect(created({ actorId: 3, actorName: 'Ana', after: { recurringExpenseId: 4 } }).actorLabel).toBe('system'))
  it('later edits of the posted expense keep their own actor label', () => {
    const [edit, create] = buildExpenseHistory([
      rev({ id: 1, action: 'CREATE', createdAt: '2026-11-05T11:00:00Z', after: { amount: '10.00', recurringExpenseId: 4 } }),
      rev({ id: 2, action: 'UPDATE', actorId: 3, actorName: 'Ana', createdAt: '2026-11-06T11:00:00Z', after: { amount: '12.00', recurringExpenseId: 4 } }),
    ])
    expect([create.actorLabel, edit.actorLabel]).toEqual(['automatic', 'system'])
  })
})
