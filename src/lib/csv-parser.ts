import { LIMITS } from '@/lib/constants'
import { toCents } from '@/lib/currency'

// Same ceiling the JSON expense API enforces (validateExpenseInput) — the Decimal(10,2) column
// tops out at 8 integer digits. Without this, an oversized CSV row reaches the DB write and
// crashes the whole (all-or-nothing) import transaction instead of being reported per-row.
const MAX_AMOUNT_CENTS = 9_999_999_999

export interface ExpenseRow {
  descricao: string
  observacao?: string
  valor: number
  data: string
  plataforma?: string
}

export interface InvalidRow {
  line: number
  reason: string
}

export interface ParsedCSV {
  expenses: ExpenseRow[]
  invalidRows: InvalidRow[]
}

export const CSV_MAX_LINES = 1000
export const CSV_MAX_BYTES = 1024 * 1024 // 1MB

/**
 * Full parse with per-line error reporting — invalid lines are never silently
 * dropped; each one comes back with its 1-based line number and a reason.
 */
export function parseCSVDetailed(csvText: string): ParsedCSV {
  if (new TextEncoder().encode(csvText).length > CSV_MAX_BYTES) {
    throw new Error('Arquivo muito grande (máx. 1MB)')
  }

  const lines = csvText.trim().split('\n')
  if (lines.length < 2) return { expenses: [], invalidRows: [] }
  if (lines.length - 1 > CSV_MAX_LINES) {
    throw new Error(`CSV com linhas demais (máx. ${CSV_MAX_LINES})`)
  }

  // Detectar separador (vírgula ou ponto-e-vírgula)
  const firstLine = lines[0]
  const separator = firstLine.includes(';') ? ';' : ','

  const headers = lines[0].split(separator).map(h => h.trim().toLowerCase().replace(/"/g, ''))

  const descricaoIndex = headers.findIndex(h => h === 'descricao' || h === 'descrição' || h === 'description')
  const observacaoIndex = headers.findIndex(h => h === 'observacao' || h === 'observação' || h === 'obs' || h === 'notes')
  const valorIndex = headers.findIndex(h => h === 'valor' || h === 'value' || h === 'amount')
  const dataIndex = headers.findIndex(h => h === 'data' || h === 'date')
  const plataformaIndex = headers.findIndex(h => h === 'plataforma' || h === 'platform')

  if (descricaoIndex === -1 || valorIndex === -1) {
    throw new Error('CSV deve conter colunas "descricao" e "valor"')
  }

  const expenses: ExpenseRow[] = []
  const invalidRows: InvalidRow[] = []

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    // Parse respeitando aspas
    const values = parseCSVLine(line, separator)

    const descricao = values[descricaoIndex]?.replace(/"/g, '').trim()
    const observacao = observacaoIndex !== -1 ? values[observacaoIndex]?.replace(/"/g, '').trim() : undefined
    const valorStr = values[valorIndex]?.replace(/"/g, '').trim()
    const dataStr = dataIndex !== -1 ? values[dataIndex]?.replace(/"/g, '').trim() : ''
    const plataforma = plataformaIndex !== -1 ? values[plataformaIndex]?.replace(/"/g, '').trim() : undefined

    if (!descricao) {
      invalidRows.push({ line: i + 1, reason: 'descrição vazia' })
      continue
    }
    if (descricao.length > LIMITS.DESCRIPTION) {
      invalidRows.push({ line: i + 1, reason: `descrição muito longa (máx. ${LIMITS.DESCRIPTION} caracteres)` })
      continue
    }
    if (observacao && observacao.length > LIMITS.NOTES) {
      invalidRows.push({ line: i + 1, reason: `observação muito longa (máx. ${LIMITS.NOTES} caracteres)` })
      continue
    }
    if (!valorStr) {
      invalidRows.push({ line: i + 1, reason: 'valor vazio' })
      continue
    }

    const valor = parseMoneyValue(valorStr)
    if (valor === null || valor <= 0) {
      invalidRows.push({ line: i + 1, reason: `valor inválido: "${valorStr}"` })
      continue
    }
    if (toCents(valor) > MAX_AMOUNT_CENTS) {
      invalidRows.push({ line: i + 1, reason: `valor muito alto (máx. 99.999.999,99): "${valorStr}"` })
      continue
    }

    // Parse data
    let data = new Date().toISOString().split('T')[0] // Default: hoje
    if (dataStr) {
      const parsed = parseDate(dataStr)
      if (parsed) {
        data = parsed
      } else {
        invalidRows.push({ line: i + 1, reason: `data inválida: "${dataStr}"` })
        continue
      }
    }

    expenses.push({ descricao, observacao: observacao || undefined, valor, data, plataforma: plataforma || undefined })
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
 * Parse valor monetário aceitando formatos:
 * - Brasileiro: R$ 1.234,56 ou 26,00
 * - Internacional: 1,234.56 ou 26.00
 */
export function parseMoneyValue(valorStr: string): number | null {
  const cleanValue = valorStr
    .replace('R$', '')
    .replace(/\s/g, '')
    .trim()

  // Detectar formato:
  // - Se tem vírgula seguida de 1-2 dígitos no final = vírgula é decimal (BR: 1.234,56 ou 26,00)
  // - Se tem ponto seguido de 1-2 dígitos no final e não tem vírgula = ponto é decimal (INT: 1234.56 ou 26.00)

  const hasCommaDecimal = /,\d{1,2}$/.test(cleanValue)
  // "1,234.56": the trailing dot+decimals win; commas are thousands separators
  const hasDotDecimal = /\.\d{1,2}$/.test(cleanValue)

  let valor: number
  if (hasCommaDecimal) {
    // Formato brasileiro: 1.234,56 -> remove pontos de milhar, troca vírgula por ponto
    valor = parseFloat(cleanValue.replace(/\./g, '').replace(',', '.'))
  } else if (hasDotDecimal) {
    // Formato internacional: 1,234.56 ou 26.00 -> remove vírgulas de milhar
    valor = parseFloat(cleanValue.replace(/,/g, ''))
  } else {
    // Sem decimal explícito, tenta parse direto
    valor = parseFloat(cleanValue.replace(/[,\.]/g, ''))
  }

  return isNaN(valor) ? null : valor
}

/**
 * Parse data aceitando formatos:
 * - DD/MM/YYYY ou DD-MM-YYYY (brasileiro)
 * - YYYY-MM-DD (ISO)
 */
export function parseDate(dateStr: string): string | null {
  let year: string, month: string, day: string

  // Formato DD/MM/YYYY ou DD-MM-YYYY
  const brMatch = dateStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/)
  // Formato YYYY-MM-DD
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
