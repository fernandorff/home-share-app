/**
 * Safely convert a value to number.
 * Handles Prisma Decimal fields (objects with valueOf), strings, and numbers.
 */
export function toNumber(value: number | string | { toString(): string }): number {
  if (typeof value === 'number') return value
  return Number(value)
}

/**
 * Format a number as Brazilian currency string (without R$ prefix)
 * Example: 1234.56 → "1.234,56"
 */
export function formatCurrency(value: number): string {
  return value.toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

/**
 * Parse a Brazilian currency string back to number
 * Example: "1.234,56" → 1234.56
 */
export function parseCurrency(str: string): number {
  const cleaned = str.replace(/\./g, '').replace(',', '.')
  return parseFloat(cleaned) || 0
}

/**
 * Convert a monetary value (reais, possibly Prisma Decimal/string) to integer cents.
 * All arithmetic in the app happens in integer cents to avoid float drift.
 */
export function toCents(value: number | string | { toString(): string }): number {
  return Math.round(toNumber(value) * 100)
}

/**
 * Convert integer cents back to a reais number with 2 decimal places.
 */
export function fromCents(cents: number): number {
  return cents / 100
}

/**
 * Split an amount in cents across n parts so the parts ALWAYS sum to the total.
 * The remainder is distributed one cent at a time starting from the first part.
 * Example: splitCents(10000, 3) → [3334, 3333, 3333]
 */
export function splitCents(totalCents: number, parts: number): number[] {
  if (parts <= 0) throw new Error('splitCents: parts must be > 0')
  const base = Math.floor(totalCents / parts)
  const remainder = totalCents - base * parts
  return Array.from({ length: parts }, (_, i) => base + (i < remainder ? 1 : 0))
}

/**
 * Currency input mask — takes raw input and returns formatted string
 * Works with cents: user types digits, mask formats automatically
 * Example: "1" → "0,01", "123" → "1,23", "123456" → "1.234,56"
 */
export function maskCurrency(value: string): string {
  const digits = value.replace(/\D/g, '')
  if (!digits) return '0,00'

  const cents = parseInt(digits, 10)
  const reais = cents / 100

  return reais.toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}
