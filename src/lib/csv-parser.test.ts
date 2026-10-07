import { describe, it, expect, afterEach, vi } from 'vitest'
import { parseCSVDetailed, parseCSV, parseMoneyValue, parseDate, sanitizeDefaultDate, CSV_MAX_LINES, CSV_MAX_BYTES } from './csv-parser'

describe('parseCSVDetailed', () => {
  it('parses comma-separated rows', () => {
    const { expenses, invalidRows } = parseCSVDetailed(
      'description,amount,date\nMercado,150.00,2026-05-15\nGasolina,100,15/05/2026'
    )
    expect(expenses).toHaveLength(2)
    expect(invalidRows).toHaveLength(0)
    expect(expenses[0]).toMatchObject({ description: 'Mercado', amount: 150, date: '2026-05-15' })
    expect(expenses[1]).toMatchObject({ description: 'Gasolina', amount: 100, date: '2026-05-15' })
  })

  it('parses semicolon separator and BR money format', () => {
    const { expenses } = parseCSVDetailed('descricao;valor\nLuz;R$ 1.234,56')
    expect(expenses[0].amount).toBe(1234.56)
  })

  it('respects quoted fields containing the separator', () => {
    const { expenses } = parseCSVDetailed('description,amount\n"Treats, food and litter",42.00')
    expect(expenses[0].description).toBe('Treats, food and litter')
  })

  it('reports invalid rows with 1-based line numbers instead of dropping them', () => {
    const { expenses, invalidRows } = parseCSVDetailed(
      'description,amount,date\nOk,10.00,2026-01-01\n,5.00,2026-01-01\nSem valor,,2026-01-01\nValor ruim,abc,2026-01-01\nData ruim,9.99,31/31/2026'
    )
    expect(expenses).toHaveLength(1)
    expect(invalidRows).toEqual([
      { line: 3, code: 'EMPTY_DESCRIPTION' },
      { line: 4, code: 'EMPTY_AMOUNT' },
      { line: 5, code: 'INVALID_AMOUNT', values: { value: 'abc' } },
      { line: 6, code: 'INVALID_DATE', values: { value: '31/31/2026' } },
    ])
  })

  it('reports a row whose amount exceeds the Decimal(10,2) column instead of letting it hit the DB', () => {
    const { expenses, invalidRows } = parseCSVDetailed(
      'description,amount\nOk,10.00\nToo big,99999999999.99'
    )
    expect(expenses).toHaveLength(1)
    expect(invalidRows).toEqual([{ line: 3, code: 'AMOUNT_TOO_HIGH', values: { value: '99999999999.99' } }])
  })

  // These are user-upload errors — must carry ApiError status 400 so the route returns a helpful
  // 400, not a generic 500 (regression from QA #38/#39).
  it('throws a 400 ApiError when required columns are missing', () => {
    expect(() => parseCSVDetailed('foo,bar\n1,2')).toThrow(/description/)
    expect(() => parseCSVDetailed('foo,bar\n1,2')).toThrow(expect.objectContaining({ status: 400 }))
  })

  // The client translates the error via its `code` (CsvErrors namespace) instead of showing a
  // generic "Error importing CSV" for every failure (B11 — wrong header and empty file were
  // indistinguishable to the user).
  it('throws a 400 ApiError with code CSV_MISSING_COLUMNS when required columns are missing', () => {
    expect(() => parseCSVDetailed('nome,preco\nX,10\n')).toThrow(
      expect.objectContaining({ status: 400, code: 'CSV_MISSING_COLUMNS' })
    )
  })

  it('throws a 400 ApiError with code CSV_EMPTY for an empty file', () => {
    expect(() => parseCSVDetailed('')).toThrow(
      expect.objectContaining({ status: 400, code: 'CSV_EMPTY' })
    )
  })

  it('enforces the line limit with a 400 ApiError', () => {
    const big = 'description,amount\n' + Array.from({ length: CSV_MAX_LINES + 1 }, (_, i) => `Item ${i},1.00`).join('\n')
    expect(() => parseCSVDetailed(big)).toThrow(/too many lines/)
    expect(() => parseCSVDetailed(big)).toThrow(expect.objectContaining({ status: 400, code: 'CSV_TOO_MANY_LINES' }))
  })

  it('enforces the size limit with a 400 ApiError carrying CSV_TOO_LARGE', () => {
    const big = 'description,amount\n' + 'x'.repeat(CSV_MAX_BYTES)
    expect(() => parseCSVDetailed(big)).toThrow(/too large/)
    expect(() => parseCSVDetailed(big)).toThrow(expect.objectContaining({ status: 400, code: 'CSV_TOO_LARGE' }))
  })
})

// The import parses on the server (UTC on Vercel), so a dateless row must take the importer's LOCAL
// day from the browser (`defaultDate`) — otherwise it lands on tomorrow in the evening (UTC-3).
describe('parseCSVDetailed — default date for rows without a date', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses options.defaultDate for a row without a date value', () => {
    const { expenses } = parseCSVDetailed('description,amount,date\nPadaria,12.50,', { defaultDate: '2031-03-09' })
    expect(expenses[0].date).toBe('2031-03-09')
  })

  it('uses options.defaultDate when the CSV has no date column at all', () => {
    const { expenses } = parseCSVDetailed('description,amount\nPadaria,12.50', { defaultDate: '2031-03-09' })
    expect(expenses[0].date).toBe('2031-03-09')
  })

  it("falls back to the server's UTC date when no option is given", () => {
    // 22:30 in Brazil (UTC-3) on Oct 4 is already Oct 5 in UTC — the pre-existing behavior.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-05T01:30:00Z'))
    const { expenses } = parseCSVDetailed('description,amount\nPadaria,12.50')
    expect(expenses[0].date).toBe('2026-10-05')
  })

  it('ignores defaultDate for a row that has its own date', () => {
    const { expenses } = parseCSVDetailed('description,amount,date\nMercado,150.00,2026-05-15', { defaultDate: '2026-10-04' })
    expect(expenses[0].date).toBe('2026-05-15')
  })

  it('still reports an invalid row date instead of substituting defaultDate', () => {
    const { expenses, invalidRows } = parseCSVDetailed('description,amount,date\nRuim,9.99,31/31/2026', { defaultDate: '2026-10-04' })
    expect(expenses).toHaveLength(0)
    expect(invalidRows).toEqual([{ line: 2, code: 'INVALID_DATE', values: { value: '31/31/2026' } }])
  })
})

// The browser's date is untrusted input: the import must never fail because of this field, so
// anything unusable is dropped (undefined) and the parser keeps its UTC default.
describe('sanitizeDefaultDate', () => {
  // Server clock: Oct 5 01:30 UTC — Oct 4 22:30 in Brazil.
  const now = new Date('2026-10-05T01:30:00Z')

  it("accepts the importer's local day when it is the server's UTC day or one day off", () => {
    expect(sanitizeDefaultDate('2026-10-05', now)).toBe('2026-10-05')
    expect(sanitizeDefaultDate('2026-10-04', now)).toBe('2026-10-04')
    expect(sanitizeDefaultDate('2026-10-06', now)).toBe('2026-10-06')
  })

  it('rejects dates more than one day away from the server UTC date', () => {
    expect(sanitizeDefaultDate('2026-10-03', now)).toBeUndefined()
    expect(sanitizeDefaultDate('2026-10-07', now)).toBeUndefined()
    expect(sanitizeDefaultDate('2020-01-01', now)).toBeUndefined()
    expect(sanitizeDefaultDate('2099-12-31', now)).toBeUndefined()
  })

  it('measures the window across month and year boundaries', () => {
    const newYear = new Date('2027-01-01T02:00:00Z')
    expect(sanitizeDefaultDate('2026-12-31', newYear)).toBe('2026-12-31')
    expect(sanitizeDefaultDate('2027-01-02', newYear)).toBe('2027-01-02')
    expect(sanitizeDefaultDate('2026-12-30', newYear)).toBeUndefined()
  })

  it('rejects anything that is not a strict YYYY-MM-DD string', () => {
    for (const raw of ['04/10/2026', '2026-10-4', '2026-10-04T12:00:00', ' 2026-10-04', '2026-10-04\n', 'tomorrow', '']) {
      expect(sanitizeDefaultDate(raw, now)).toBeUndefined()
    }
  })

  it('rejects impossible calendar dates', () => {
    expect(sanitizeDefaultDate('2026-10-32', now)).toBeUndefined()
    expect(sanitizeDefaultDate('2026-13-04', now)).toBeUndefined()
    expect(sanitizeDefaultDate('2026-00-04', now)).toBeUndefined()
    const feb = new Date('2026-03-01T01:00:00Z')
    expect(sanitizeDefaultDate('2026-02-29', feb)).toBeUndefined() // 2026 is not a leap year
    expect(sanitizeDefaultDate('2026-02-28', feb)).toBe('2026-02-28')
    expect(sanitizeDefaultDate('2028-02-29', new Date('2028-02-29T10:00:00Z'))).toBe('2028-02-29') // leap year
  })

  it('ignores values that are not strings (missing field, File entry, JSON number)', () => {
    expect(sanitizeDefaultDate(undefined, now)).toBeUndefined()
    expect(sanitizeDefaultDate(null, now)).toBeUndefined()
    expect(sanitizeDefaultDate(20261004, now)).toBeUndefined()
    expect(sanitizeDefaultDate({}, now)).toBeUndefined()
    expect(sanitizeDefaultDate(new File(['x'], 'd.txt'), now)).toBeUndefined()
  })

  it('defaults the reference clock to the current server time', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-05T01:30:00Z'))
    try {
      expect(sanitizeDefaultDate('2026-10-04')).toBe('2026-10-04')
      expect(sanitizeDefaultDate('2026-10-02')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('parseCSV (compat wrapper)', () => {
  it('returns only the valid expenses', () => {
    const rows = parseCSV('description,amount\nOk,10.00\n,5.00')
    expect(rows).toHaveLength(1)
  })
})

describe('parseMoneyValue', () => {
  it('handles BR and international formats', () => {
    expect(parseMoneyValue('R$ 1.234,56')).toBe(1234.56)
    expect(parseMoneyValue('26,00')).toBe(26)
    expect(parseMoneyValue('1,234.56')).toBe(1234.56)
    expect(parseMoneyValue('26.00')).toBe(26)
  })

  it('returns null for garbage', () => {
    expect(parseMoneyValue('abc')).toBeNull()
  })
})

describe('parseDate', () => {
  it('accepts BR and ISO formats', () => {
    expect(parseDate('15/08/2026')).toBe('2026-08-15')
    expect(parseDate('2026-08-15')).toBe('2026-08-15')
  })

  it('rejects invalid strings', () => {
    expect(parseDate('tomorrow')).toBeNull()
  })
})
