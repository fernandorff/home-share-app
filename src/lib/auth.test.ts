import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword, signSession, verifySession } from './auth'
import { generateJoinCode, isValidJoinCodeFormat, normalizeJoinCode, JOIN_CODE_LENGTH } from './join-code'

describe('password hashing', () => {
  it('hashes and verifies a password', async () => {
    const hash = await hashPassword('senha-segura-123')
    expect(hash).not.toBe('senha-segura-123')
    expect(await verifyPassword('senha-segura-123', hash)).toBe(true)
    expect(await verifyPassword('senha-errada', hash)).toBe(false)
  })

  it('produces unique salts per hash', async () => {
    const a = await hashPassword('mesma-senha')
    const b = await hashPassword('mesma-senha')
    expect(a).not.toBe(b)
  })
})

describe('session JWT', () => {
  const payload = { userId: 1, publicId: 'abc-123', name: 'Fernando' }

  it('signs and verifies round-trip', async () => {
    const token = await signSession(payload)
    const session = await verifySession(token)
    expect(session).toEqual(payload)
  })

  it('rejects tampered tokens', async () => {
    const token = await signSession(payload)
    const tampered = token.slice(0, -2) + 'xx'
    expect(await verifySession(tampered)).toBeNull()
  })

  it('rejects garbage', async () => {
    expect(await verifySession('not-a-jwt')).toBeNull()
  })
})

describe('join codes', () => {
  it('generates codes with expected length and alphabet', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateJoinCode()
      expect(code).toHaveLength(JOIN_CODE_LENGTH)
      expect(isValidJoinCodeFormat(code)).toBe(true)
    }
  })

  it('rejects ambiguous characters and wrong lengths', () => {
    expect(isValidJoinCodeFormat('ABC')).toBe(false)
    expect(isValidJoinCodeFormat('ABCDE0')).toBe(false) // 0 is ambiguous
    expect(isValidJoinCodeFormat('ABCDEI')).toBe(false) // I is ambiguous
  })

  it('normalizes lowercase input', () => {
    expect(normalizeJoinCode(' ebvvm3 ')).toBe('EBVVM3')
    expect(isValidJoinCodeFormat(normalizeJoinCode('ebvvm3'))).toBe(true)
  })
})
