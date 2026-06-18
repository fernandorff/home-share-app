// Join codes avoid ambiguous characters (0/O, 1/I/L) so they survive being
// read aloud or typed from a phone screen.
const JOIN_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const JOIN_CODE_LENGTH = 6

export function generateJoinCode(): string {
  let code = ''
  for (let i = 0; i < JOIN_CODE_LENGTH; i++) {
    code += JOIN_CODE_ALPHABET[Math.floor(Math.random() * JOIN_CODE_ALPHABET.length)]
  }
  return code
}

export function isValidJoinCodeFormat(code: string): boolean {
  if (code.length !== JOIN_CODE_LENGTH) return false
  return [...code.toUpperCase()].every(c => JOIN_CODE_ALPHABET.includes(c))
}

export function normalizeJoinCode(code: string): string {
  return code.trim().toUpperCase()
}
