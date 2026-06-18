import { describe, it, expect } from 'vitest'
import { toCents, fromCents, splitCents, parseCurrency, maskCurrency } from './currency'

describe('toCents', () => {
  it('converts reais to integer cents', () => {
    expect(toCents(10)).toBe(1000)
    expect(toCents(851.72)).toBe(85172)
    expect(toCents(0)).toBe(0)
  })

  it('handles float artifacts (0.1 + 0.2)', () => {
    expect(toCents(0.1 + 0.2)).toBe(30)
  })

  it('handles Prisma Decimal-like objects and strings', () => {
    expect(toCents('19.90')).toBe(1990)
    expect(toCents({ toString: () => '67.42' })).toBe(6742)
  })
})

describe('fromCents', () => {
  it('round-trips with toCents', () => {
    expect(fromCents(toCents(1234.56))).toBe(1234.56)
    expect(fromCents(1)).toBe(0.01)
  })
})

describe('splitCents', () => {
  it('splits evenly when exact', () => {
    expect(splitCents(10000, 2)).toEqual([5000, 5000])
  })

  it('distributes remainder from the first part on', () => {
    expect(splitCents(10000, 3)).toEqual([3334, 3333, 3333])
    expect(splitCents(10001, 3)).toEqual([3334, 3334, 3333])
  })

  it('always sums to the total', () => {
    for (const [total, parts] of [
      [10000, 3],
      [9999, 7],
      [1, 2],
      [85172, 2],
      [333, 4],
    ] as const) {
      const split = splitCents(total, parts)
      expect(split.reduce((a, b) => a + b, 0)).toBe(total)
      expect(split).toHaveLength(parts)
    }
  })

  it('handles zero total', () => {
    expect(splitCents(0, 2)).toEqual([0, 0])
  })

  it('throws on zero or negative parts', () => {
    expect(() => splitCents(100, 0)).toThrow()
    expect(() => splitCents(100, -1)).toThrow()
  })
})

describe('parseCurrency', () => {
  it('parses BR format', () => {
    expect(parseCurrency('1.234,56')).toBe(1234.56)
    expect(parseCurrency('19,90')).toBe(19.9)
  })
})

describe('maskCurrency', () => {
  it('formats digit input as BR currency', () => {
    expect(maskCurrency('1')).toBe('0,01')
    expect(maskCurrency('123')).toBe('1,23')
    expect(maskCurrency('123456')).toBe('1.234,56')
  })
})
