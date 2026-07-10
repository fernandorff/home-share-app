import { describe, it, expect } from 'vitest'
import { formatMoney, formatMoneySigned, formatDateLocale } from '@/lib/money'
import { maskAmountInput, parseAmountInput } from '@/lib/format'

// ICU inserts NBSP / narrow-NBSP around symbols; normalize so assertions are readable.
const norm = (s: string) => s.replace(/ | /g, ' ')

describe('formatMoney — per-house currency × per-user locale', () => {
  it('BRL in pt', () => expect(norm(formatMoney(1234.56, 'BRL', 'pt'))).toBe('R$ 1.234,56'))
  it('USD in en', () => expect(norm(formatMoney(1234.56, 'USD', 'en'))).toBe('$1,234.56'))
  it('EUR in fr', () => expect(norm(formatMoney(1234.56, 'EUR', 'fr'))).toBe('1 234,56 €'))
  it('USD in pt (foreign currency keeps its code, BR grouping)', () =>
    expect(norm(formatMoney(342.8, 'USD', 'pt'))).toBe('US$ 342,80'))
})

describe('formatMoneySigned — explicit sign, never double-signs zero', () => {
  it('positive gets a +', () => expect(norm(formatMoneySigned(66.67, 'USD', 'en'))).toBe('+$66.67'))
  it('negative gets a U+2212 minus', () => expect(norm(formatMoneySigned(-66.67, 'USD', 'en'))).toBe('−$66.67'))
  it('zero carries no sign', () => {
    const z = formatMoneySigned(0, 'USD', 'en')
    expect(z.startsWith('+') || z.startsWith('−')).toBe(false)
  })
})

describe('amount mask ↔ parse round-trip (no silent corruption of typed amounts)', () => {
  const LOCALES = ['en', 'pt', 'es', 'fr']
  const CENTS = [1, 9, 50, 99, 100, 1234, 12345, 100000, 99999999]
  for (const locale of LOCALES) {
    it(`round-trips every sample in ${locale}`, () => {
      for (const cents of CENTS) {
        const masked = maskAmountInput(String(cents), locale)
        const parsed = parseAmountInput(masked, locale)
        expect(parsed).toBeCloseTo(cents / 100, 2)
      }
    })
  }
})

describe('maskAmountInput — caps input at the server\'s AMOUNT_TOO_HIGH ceiling (F1)', () => {
  it('accepts exactly the maximum (99,999,999.99 — 10 raw digits)', () => {
    expect(parseAmountInput(maskAmountInput('9999999999', 'pt'), 'pt')).toBeCloseTo(99999999.99, 2)
  })

  it('silently truncates extra digits instead of overflowing (18 nines from F1s repro)', () => {
    const masked = maskAmountInput('999999999999999999', 'pt')
    const parsed = parseAmountInput(masked, 'pt')
    expect(parsed).toBeCloseTo(99999999.99, 2)
    expect(parsed).toBeLessThan(Number.MAX_SAFE_INTEGER)
  })
})

describe('formatDateLocale — always DD/MM/YYYY, independent of the UI language (BL-18/B3)', () => {
  it('formats as DD/MM/YYYY (previously flipped to MM/DD under an English UI, diverging from CSV export)', () => {
    expect(formatDateLocale('2026-07-08T12:00:00.000Z')).toBe('08/07/2026')
  })

  it('returns an em dash for an unparseable date', () => {
    expect(formatDateLocale('not-a-date')).toBe('—')
  })
})
