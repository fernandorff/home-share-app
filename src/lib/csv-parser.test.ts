import { describe, it, expect } from 'vitest'
import { parseCSVDetailed, parseCSV, parseMoneyValue, parseDate, CSV_MAX_LINES } from './csv-parser'

describe('parseCSVDetailed', () => {
  it('parses comma-separated rows', () => {
    const { expenses, invalidRows } = parseCSVDetailed(
      'description,amount,date\nMercado,150.00,2026-05-15\nGasolina,100,15/05/2026'
    )
    expect(expenses).toHaveLength(2)
    expect(invalidRows).toHaveLength(0)
    expect(expenses[0]).toMatchObject({ descricao: 'Mercado', valor: 150, data: '2026-05-15' })
    expect(expenses[1]).toMatchObject({ descricao: 'Gasolina', valor: 100, data: '2026-05-15' })
  })

  it('parses semicolon separator and BR money format', () => {
    const { expenses } = parseCSVDetailed('descricao;valor\nLuz;R$ 1.234,56')
    expect(expenses[0].valor).toBe(1234.56)
  })

  it('respects quoted fields containing the separator', () => {
    const { expenses } = parseCSVDetailed('description,amount\n"Petisco, ração e areia",42.00')
    expect(expenses[0].descricao).toBe('Petisco, ração e areia')
  })

  it('reports invalid rows with 1-based line numbers instead of dropping them', () => {
    const { expenses, invalidRows } = parseCSVDetailed(
      'description,amount,date\nOk,10.00,2026-01-01\n,5.00,2026-01-01\nSem valor,,2026-01-01\nValor ruim,abc,2026-01-01\nData ruim,9.99,31/31/2026'
    )
    expect(expenses).toHaveLength(1)
    expect(invalidRows).toEqual([
      { line: 3, reason: 'descrição vazia' },
      { line: 4, reason: 'valor vazio' },
      { line: 5, reason: expect.stringContaining('valor inválido') },
      { line: 6, reason: expect.stringContaining('data inválida') },
    ])
  })

  it('throws when required columns are missing', () => {
    expect(() => parseCSVDetailed('foo,bar\n1,2')).toThrow(/descricao/)
  })

  it('enforces the line limit', () => {
    const big = 'description,amount\n' + Array.from({ length: CSV_MAX_LINES + 1 }, (_, i) => `Item ${i},1.00`).join('\n')
    expect(() => parseCSVDetailed(big)).toThrow(/linhas demais/)
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
    expect(parseDate('amanhã')).toBeNull()
  })
})
