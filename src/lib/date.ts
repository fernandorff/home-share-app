/**
 * Parse a date string/Date to a local Date, avoiding timezone offset issues.
 * "2026-03-04" → treated as local noon instead of UTC midnight.
 */
function toLocalDate(date: string | Date): Date {
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return new Date(date + 'T12:00:00')
  }
  return new Date(date)
}

/**
 * Format date as DD/MM/YYYY using pt-BR locale
 */
export function formatDate(date: string | Date): string {
  return toLocalDate(date).toLocaleDateString('pt-BR')
}

/**
 * Format date as DD/MM/YYYY HH:MM using pt-BR locale
 */
export function formatDateTime(date: string | Date): string {
  return toLocalDate(date).toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
