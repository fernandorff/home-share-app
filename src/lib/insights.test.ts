import { describe, it, expect } from 'vitest'
import { aggregateSpend } from '@/lib/insights'

const exp = (amount: number, category: string | null, date: string | Date) => ({ amount, categories: category ? [category] : [], date })

describe('aggregateSpend', () => {
  it('sums per category, newest-biggest first, uncategorized as ""', () => {
    const r = aggregateSpend([
      exp(10, 'pets', '2026-06-10T12:00:00.000Z'),
      exp(20, 'pets', '2026-06-11T12:00:00.000Z'),
      exp(5, null, '2026-05-01T12:00:00.000Z'),
    ])
    expect(r.byCategory).toEqual([
      { category: 'pets', total: 30 },
      { category: '', total: 5 },
    ])
  })

  it('sums per month, newest first', () => {
    const r = aggregateSpend([
      exp(10, 'a', '2026-06-10T12:00:00.000Z'),
      exp(20, 'b', '2026-05-11T12:00:00.000Z'),
      exp(7, 'c', '2026-06-20T12:00:00.000Z'),
    ])
    expect(r.byMonth).toEqual([
      { month: '2026-06', total: 17 },
      { month: '2026-05', total: 20 },
    ])
  })

  it('keeps integer-cents exactness (no float drift)', () => {
    const r = aggregateSpend([exp(0.1, 'a', '2026-06-01T12:00:00.000Z'), exp(0.2, 'a', '2026-06-02T12:00:00.000Z')])
    expect(r.byCategory[0].total).toBeCloseTo(0.3, 10)
  })

  it('accepts Date objects as well as ISO strings', () => {
    const r = aggregateSpend([exp(10, 'a', new Date('2026-06-10T12:00:00.000Z'))])
    expect(r.byMonth[0].month).toBe('2026-06')
  })

  it('splits a multi-category expense across its tags so the breakdown sums back to 100% (BL-28)', () => {
    const multi = { amount: 10, categories: ['a', 'b'], date: '2026-06-10T12:00:00.000Z' }
    const r = aggregateSpend([multi])
    const total = r.byCategory.reduce((sum, c) => sum + c.total, 0)
    expect(total).toBeCloseTo(10, 10)
    expect(r.byCategory).toEqual(
      expect.arrayContaining([
        { category: 'a', total: 5 },
        { category: 'b', total: 5 },
      ])
    )
  })

  it('splits an odd multi-category amount without losing a cent (remainder goes to the first tags)', () => {
    const multi = { amount: 0.1, categories: ['a', 'b', 'c'], date: '2026-06-10T12:00:00.000Z' }
    const r = aggregateSpend([multi])
    const total = r.byCategory.reduce((sum, c) => sum + c.total, 0)
    expect(total).toBeCloseTo(0.1, 10)
  })
})
