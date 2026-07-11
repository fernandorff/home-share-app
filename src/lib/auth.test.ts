import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword, signSession, verifySession } from './auth'
import { generateJoinCode, isValidJoinCodeFormat, normalizeJoinCode, JOIN_CODE_LENGTH } from './join-code'

describe('password hashing', () => {
  it('hashes and verifies a password', async () => {
    const hash = await hashPassword('secure-password-123')
    expect(hash).not.toBe('secure-password-123')
    expect(await verifyPassword('secure-password-123', hash)).toBe(true)
    expect(await verifyPassword('wrong-password', hash)).toBe(false)
  })

  it('produces unique salts per hash', async () => {
    const a = await hashPassword('same-password')
    const b = await hashPassword('same-password')
    expect(a).not.toBe(b)
  })
})

describe('session JWT', () => {
  const payload = { userId: 1, publicId: 'abc-123', name: 'Fernando', sessionVersion: 0 }

  it('signs and verifies round-trip', async () => {
    const token = await signSession(payload)
    const session = await verifySession(token)
    // verifySession also returns the JWT's issued-at time (iat), used to gate step-up-sensitive
    // actions — not part of the signed payload, so check it separately from the rest.
    expect(session).toMatchObject(payload)
    expect(typeof session?.iat).toBe('number')
  })

  it('round-trips a non-zero sessionVersion (bumped by logout/password-change)', async () => {
    const token = await signSession({ ...payload, sessionVersion: 3 })
    const session = await verifySession(token)
    expect(session?.sessionVersion).toBe(3)
  })

  it('defaults sessionVersion to 0 for a token signed before this field existed', async () => {
    // Simulates an already-issued token from before this deploy — verifySession must not choke on
    // a missing claim, so it falls back to 0 (matching a freshly migrated User.sessionVersion default).
    const legacyToken = await new (await import('jose')).SignJWT({ userId: 1, publicId: 'abc-123', name: 'Fernando' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET || 'dev-only-insecure-secret'))
    const session = await verifySession(legacyToken)
    expect(session?.sessionVersion).toBe(0)
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
