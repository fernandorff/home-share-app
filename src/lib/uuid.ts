import { v7 as uuidv7, validate as uuidValidate } from 'uuid'

export { uuidv7 }

/**
 * Generates a new UUID v7
 */
export function generateUUID(): string {
  return uuidv7()
}

/**
 * Validates if a string is a valid UUID format
 */
export function isValidUUID(uuid: string): boolean {
  return uuidValidate(uuid)
}
