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
})
