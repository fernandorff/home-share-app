import { LIMITS } from '@/lib/constants'
import { toCents } from '@/lib/currency'
import { ApiError } from '@/lib/errors'

// Same ceiling the JSON expense API enforces (validateExpenseInput) — the Decimal(10,2) column
// tops out at 8 integer digits. Without this, an oversized CSV row reaches the DB write and
// crashes the whole (all-or-nothing) import transaction instead of being reported per-row.
const MAX_AMOUNT_CENTS = 9_999_999_999

export interface ExpenseRow {
  description: string
  notes?: string
  amount: number
  date: string
  platform?: string
}

// Per-row failures are structured (code + interpolation values), not prose — the client renders
// them localized via the CsvErrors i18n namespace, so the parser stays language-neutral.
export type InvalidRowCode =
  | 'EMPTY_DESCRIPTION'
  | 'DESCRIPTION_TOO_LONG'
  | 'NOTES_TOO_LONG'
  | 'EMPTY_AMOUNT'
  | 'INVALID_AMOUNT'
  | 'AMOUNT_TOO_HIGH'
  | 'INVALID_DATE'

export interface InvalidRow {
  line: number
  code: InvalidRowCode
  /** ICU interpolation values for the code's message (offending value, limit, …). */
  values?: { value?: string; max?: number }
}

export interface ParsedCSV {
  expenses: ExpenseRow[]
  invalidRows: InvalidRow[]
}

export const CSV_MAX_LINES = 1000
export const CSV_MAX_BYTES = 1024 * 1024 // 1MB

/**
 * Full parse with per-line error reporting — invalid lines are never silently
 * dropped; each one comes back with its 1-based line number and a reason code.
 */
export function parseCSVDetailed(csvText: string): ParsedCSV {
  // These are user-input errors (the caller uploaded a malformed file), so they carry a 400 —
  // a plain Error would bubble up as a generic 500 (found in QA: header/size/line-count issues
  // returned 500 instead of a helpful 400).
  if (new TextEncoder().encode(csvText).length > CSV_MAX_BYTES) {
    throw new ApiError('File too large (max. 1MB)', 400)
  }

  const lines = csvText.trim().split('\n')
  if (lines.length < 2) return { expenses: [], invalidRows: [] }
  if (lines.length - 1 > CSV_MAX_LINES) {
    throw new ApiError(`CSV has too many lines (max. ${CSV_MAX_LINES})`, 400)
  }

  // Detect the separator (comma or semicolon)
  const firstLine = lines[0]
  const separator = firstLine.includes(';') ? ';' : ','

  const headers = lines[0].split(separator).map(h => h.trim().toLowerCase().replace(/"/g, ''))

  // Both English and Portuguese header names are accepted — pt-BR spreadsheets predate the
  // English-only codebase and keep working.
  const descriptionIndex = headers.findIndex(h => h === 'descricao' || h === 'descrição' || h === 'description')
  const notesIndex = headers.findIndex(h => h === 'observacao' || h === 'observação' || h === 'obs' || h === 'notes')
  const amountIndex = headers.findIndex(h => h === 'valor' || h === 'value' || h === 'amount')
  const dateIndex = headers.findIndex(h => h === 'data' || h === 'date')
  const platformIndex = headers.findIndex(h => h === 'plataforma' || h === 'platform')

  if (descriptionIndex === -1 || amountIndex === -1) {
    throw new ApiError('CSV must contain "description" and "amount" columns', 400)
  }

  const expenses: ExpenseRow[] = []
  const invalidRows: InvalidRow[] = []

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    // Parse respecting quoted fields
    const values = parseCSVLine(line, separator)

    const description = values[descriptionIndex]?.replace(/"/g, '').trim()
    const notes = notesIndex !== -1 ? values[notesIndex]?.replace(/"/g, '').trim() : undefined
    const amountStr = values[amountIndex]?.replace(/"/g, '').trim()
    const dateStr = dateIndex !== -1 ? values[dateIndex]?.replace(/"/g, '').trim() : ''
    const platform = platformIndex !== -1 ? values[platformIndex]?.replace(/"/g, '').trim() : undefined

    if (!description) {
      invalidRows.push({ line: i + 1, code: 'EMPTY_DESCRIPTION' })
      continue
    }
    if (description.length > LIMITS.DESCRIPTION) {
      invalidRows.push({ line: i + 1, code: 'DESCRIPTION_TOO_LONG', values: { max: LIMITS.DESCRIPTION } })
      continue
    }
    if (notes && notes.length > LIMITS.NOTES) {
      invalidRows.push({ line: i + 1, code: 'NOTES_TOO_LONG', values: { max: LIMITS.NOTES } })
      continue
    }
    if (!amountStr) {
      invalidRows.push({ line: i + 1, code: 'EMPTY_AMOUNT' })
      continue
    }

    const amount = parseMoneyValue(amountStr)
    if (amount === null || amount <= 0) {
      invalidRows.push({ line: i + 1, code: 'INVALID_AMOUNT', values: { value: amountStr } })
      continue
    }
    if (toCents(amount) > MAX_AMOUNT_CENTS) {
      invalidRows.push({ line: i + 1, code: 'AMOUNT_TOO_HIGH', values: { value: amountStr } })
      continue
    }

    // Parse the date
    let date = new Date().toISOString().split('T')[0] // Default: today
    if (dateStr) {
      const parsed = parseDate(dateStr)
      if (parsed) {
        date = parsed
      } else {
        invalidRows.push({ line: i + 1, code: 'INVALID_DATE', values: { value: dateStr } })
        continue
      }
    }

    expenses.push({ description, notes: notes || undefined, amount, date, platform: platform || undefined })
  }

  return { expenses, invalidRows }
}

export function parseCSV(csvText: string): ExpenseRow[] {
  return parseCSVDetailed(csvText).expenses
}

function parseCSVLine(line: string, separator: string): string[] {
  const values: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]

    if (char === '"') {
      inQuotes = !inQuotes
    } else if (char === separator && !inQuotes) {
      values.push(current)
      current = ''
    } else {
      current += char
    }
  }
  values.push(current)

  return values
}

/**
 * Parse a monetary value accepting the formats:
 * - Brazilian: R$ 1.234,56 or 26,00
 * - International: 1,234.56 or 26.00
 */
export function parseMoneyValue(amountStr: string): number | null {
  const cleanValue = amountStr
    .replace('R$', '')
    .replace(/\s/g, '')
    .trim()

  // Detect the format:
  // - Comma followed by 1-2 trailing digits = comma is the decimal (BR: 1.234,56 or 26,00)
  // - Dot followed by 1-2 trailing digits and no comma = dot is the decimal (INT: 1234.56 or 26.00)

  const hasCommaDecimal = /,\d{1,2}$/.test(cleanValue)
  // "1,234.56": the trailing dot+decimals win; commas are thousands separators
  const hasDotDecimal = /\.\d{1,2}$/.test(cleanValue)

  let amount: number
  if (hasCommaDecimal) {
    // Brazilian format: 1.234,56 -> strip thousands dots, swap comma for dot
    amount = parseFloat(cleanValue.replace(/\./g, '').replace(',', '.'))
  } else if (hasDotDecimal) {
    // International format: 1,234.56 or 26.00 -> strip thousands commas
    amount = parseFloat(cleanValue.replace(/,/g, ''))
  } else {
    // No explicit decimal, try a direct parse
    amount = parseFloat(cleanValue.replace(/[,\.]/g, ''))
  }

  return isNaN(amount) ? null : amount
}

/**
 * Parse a date accepting the formats:
 * - DD/MM/YYYY or DD-MM-YYYY (Brazilian)
 * - YYYY-MM-DD (ISO)
 */
export function parseDate(dateStr: string): string | null {
  let year: string, month: string, day: string

  // DD/MM/YYYY or DD-MM-YYYY format
  const brMatch = dateStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/)
  // YYYY-MM-DD format
  const isoMatch = dateStr.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/)

  if (brMatch) {
    ;[, day, month, year] = brMatch
  } else if (isoMatch) {
    ;[, year, month, day] = isoMatch
  } else {
    return null
  }

  // Range check: rejects impossible dates like 31/31/2026 or 30/02/2026
  const m = parseInt(month, 10)
  const d = parseInt(day, 10)
  const y = parseInt(year, 10)
  const candidate = new Date(Date.UTC(y, m - 1, d))
  if (
    candidate.getUTCFullYear() !== y ||
    candidate.getUTCMonth() !== m - 1 ||
    candidate.getUTCDate() !== d
  ) {
    return null
  }

  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
}
