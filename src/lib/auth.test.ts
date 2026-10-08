import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword, signSession, verifySession, renewedSessionToken, SESSION_MAX_AGE_SECONDS, SESSION_RENEW_AFTER_SECONDS } from './auth'
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

  it('carries the login time (authAt): now by default, or the one passed by a renewal', async () => {
    const now = Math.floor(Date.now() / 1000)
    const fresh = await verifySession(await signSession(payload))
    expect(fresh!.authAt).toBeGreaterThanOrEqual(now - 5)
    const kept = await verifySession(await signSession(payload, now - 1000))
    expect(kept!.authAt).toBe(now - 1000)
  })

  it('a token signed before ADR 0013 (no authAt) uses its iat as the login time', async () => {
    const legacyToken = await new (await import('jose')).SignJWT({ ...payload })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET || 'dev-only-insecure-secret'))
    const session = await verifySession(legacyToken)
    expect(session!.authAt).toBe(session!.iat)
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

describe('sliding session (ADR 0013)', () => {
  const payload = { userId: 1, publicId: 'abc-123', name: 'Fernando', sessionVersion: 4 }

  it('lives 30 days, renewed at most once a day', () => {
    expect(SESSION_MAX_AGE_SECONDS).toBe(30 * 24 * 60 * 60)
    expect(SESSION_RENEW_AFTER_SECONDS).toBe(24 * 60 * 60)
  })

  it('renewedSessionToken: null while the token is under a day old', async () => {
    const session = (await verifySession(await signSession(payload)))!
    expect(await renewedSessionToken(session, session.iat + SESSION_RENEW_AFTER_SECONDS - 1)).toBeNull()
  })

  it('renewedSessionToken: after a day, the same claims and login time in a new token', async () => {
    const session = (await verifySession(await signSession(payload, 1_700_000_000)))!
    const token = await renewedSessionToken(session, session.iat + SESSION_RENEW_AFTER_SECONDS)
    const renewed = await verifySession(token!)
    expect(renewed).toMatchObject({ ...payload, authAt: 1_700_000_000 })
  })
})
