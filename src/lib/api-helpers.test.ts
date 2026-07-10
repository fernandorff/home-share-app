import { describe, it, expect } from 'vitest'
import { validateExpenseInput } from '@/lib/api-helpers'

const base = { description: 'Test', amount: 10, payerId: 1 }

describe('validateExpenseInput — existing guards (locked behavior)', () => {
  it('accepts a valid equal split', () => {
    expect(validateExpenseInput({ ...base, splitEqually: true }).valid).toBe(true)
  })

  it('accepts a valid custom split that sums to the total', () => {
    const r = validateExpenseInput({
      ...base, amount: 0.05, splitEqually: false,
      participants: [{ userId: 1, amount: 0.03 }, { userId: 2, amount: 0.02 }],
    })
    expect(r.valid).toBe(true)
  })

  it('rejects empty description', () => {
    expect(validateExpenseInput({ ...base, description: '   ' }).valid).toBe(false)
  })

  it('rejects amount <= 0', () => {
    expect(validateExpenseInput({ ...base, amount: 0 }).valid).toBe(false)
  })

  it('rejects a custom split whose sum != total', () => {
    const r = validateExpenseInput({
      ...base, amount: 1, splitEqually: false,
      participants: [{ userId: 1, amount: 0.4 }, { userId: 2, amount: 0.4 }],
    })
    expect(r.valid).toBe(false)
  })
})

describe('validateExpenseInput — hardening (Wave 1 bug fixes)', () => {
  it('rejects a negative participant share even when the sum matches', () => {
    const r = validateExpenseInput({
      ...base, amount: 1, splitEqually: false,
      participants: [{ userId: 1, amount: 2 }, { userId: 2, amount: -1 }],
    })
    expect(r.valid).toBe(false)
  })

  it('rejects a custom split with no participants', () => {
    const r = validateExpenseInput({ ...base, amount: 1, splitEqually: false, participants: [] })
    expect(r.valid).toBe(false)
  })

  it('rejects duplicate participants', () => {
    const r = validateExpenseInput({
      ...base, amount: 1, splitEqually: false,
      participants: [{ userId: 1, amount: 0.5 }, { userId: 1, amount: 0.5 }],
    })
    expect(r.valid).toBe(false)
  })

  it('rejects an amount above the Decimal(10,2) maximum', () => {
    expect(validateExpenseInput({ ...base, amount: 100_000_000 }).valid).toBe(false)
  })

  it('accepts an amount at the Decimal(10,2) maximum boundary', () => {
    expect(validateExpenseInput({ ...base, amount: 99_999_999.99 }).valid).toBe(true)
  })
})

describe('validateExpenseInput — cents precision (review fixes)', () => {
  it('rejects a total with more than 2 decimal places', () => {
    expect(validateExpenseInput({ ...base, amount: 26.505 }).valid).toBe(false)
  })

  it('rejects a non-numeric amount', () => {
    expect(validateExpenseInput({ ...base, amount: '10' as unknown as number }).valid).toBe(false)
  })

  it('rejects a participant share with sub-cent precision', () => {
    const r = validateExpenseInput({
      ...base, amount: 1, splitEqually: false,
      participants: [{ userId: 1, amount: 0.333 }, { userId: 2, amount: 0.667 }],
    })
    expect(r.valid).toBe(false)
  })

  it('still accepts clean 2-decimal amounts', () => {
    expect(validateExpenseInput({ ...base, amount: 26.5 }).valid).toBe(true)
    expect(validateExpenseInput({ ...base, amount: 26.55 }).valid).toBe(true)
  })
})

describe('validateExpenseInput — malformed field types return 400, not a 500 crash (BL-10/S9)', () => {
  it('rejects a non-string description instead of throwing on .trim()', () => {
    const r = validateExpenseInput({ ...base, description: 123 as unknown as string })
    expect(r.valid).toBe(false)
  })

  it('rejects a non-string notes instead of throwing on .length', () => {
    const r = validateExpenseInput({ ...base, notes: 456 as unknown as string })
    expect(r.valid).toBe(false)
  })

  it('rejects a non-array participants instead of throwing on .map/.some', () => {
    const r = validateExpenseInput({
      ...base, splitEqually: false, participants: 'not-an-array' as unknown as { userId: number; amount: number }[],
    })
    expect(r.valid).toBe(false)
  })

  it('rejects an unparseable date instead of producing an Invalid Date', () => {
    const r = validateExpenseInput({ ...base, date: 'not-a-date' })
    expect(r.valid).toBe(false)
  })
})
