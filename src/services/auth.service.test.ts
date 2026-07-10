import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    user: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
  },
}))
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

import { authService } from './auth.service'
import { hashPassword } from '@/lib/auth'

beforeEach(() => {
  // resetAllMocks (not clearAllMocks): also drops any *persistent* mockResolvedValue set by a
  // previous test, not just call history. Without this, a leftover default return value can leak
  // into the NEXT test's unconfigured calls (e.g. uniqueUsernameFromEmail's internal uniqueness
  // loop) and turn a `while (await find(...))` into a genuine infinite loop.
  vi.resetAllMocks()
})

function baseUser(overrides: Partial<{ id: number; password: string | null; email: string | null; username: string; googleId: string | null; emailVerified: boolean; sessionVersion: number }> = {}) {
  return {
    id: 1,
    publicId: 'pub-1',
    name: 'Fernando',
    username: 'fernando',
    email: 'old@x.com',
    password: 'hash-of-something',
    googleId: null,
    emailVerified: false,
    sessionVersion: 0,
    ...overrides,
  }
}

describe('validatePassword', () => {
  it('accepts a reasonable password', () => {
    expect(authService.validatePassword('correcthorse9')).toBeNull()
  })

  it('rejects short passwords', () => {
    expect(authService.validatePassword('abc123')?.code).toBe('INVALID_PASSWORD')
  })

  it('rejects overly long passwords (bcrypt truncates past 72)', () => {
    expect(authService.validatePassword('a1'.repeat(40))?.code).toBe('INVALID_PASSWORD')
  })

  it('rejects common/breached passwords regardless of case', () => {
    expect(authService.validatePassword('password')?.code).toBe('PASSWORD_TOO_COMMON')
    expect(authService.validatePassword('PASSWORD')?.code).toBe('PASSWORD_TOO_COMMON')
    expect(authService.validatePassword('12345678')?.code).toBe('PASSWORD_TOO_COMMON')
    expect(authService.validatePassword('qwerty123')?.code).toBe('PASSWORD_TOO_COMMON')
  })

  it('rejects passwords with a single repeated/sequential character class (no letter+digit mix)', () => {
    expect(authService.validatePassword('aaaaaaaa')?.code).toBe('PASSWORD_NO_COMPLEXITY')
    expect(authService.validatePassword('abcdefgh')?.code).toBe('PASSWORD_NO_COMPLEXITY')
  })
})

describe('validateEmail', () => {
  it('accepts a well-formed address', () => {
    expect(authService.validateEmail('a@b.com')).toBeNull()
  })

  it('rejects malformed addresses', () => {
    expect(authService.validateEmail('not-an-email')).not.toBeNull()
    expect(authService.validateEmail('a@b')).not.toBeNull()
    expect(authService.validateEmail('@b.com')).not.toBeNull()
  })

  it('rejects overly long addresses', () => {
    const long = 'a'.repeat(250) + '@b.com'
    expect(authService.validateEmail(long)).not.toBeNull()
  })
})

describe('updateProfile', () => {
  it('updates name only, without touching email/username or requiring a password', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseUser())
    mockPrisma.user.update.mockResolvedValue({ ...baseUser(), name: 'New Name' })

    const result = await authService.updateProfile(1, { name: 'New Name' })

    expect('user' in result).toBe(true)
    const data = mockPrisma.user.update.mock.calls.at(-1)![0].data
    expect(data).toEqual({ name: 'New Name' })
  })

  it('requires the current password when email is changing and the user has one', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseUser())

    const result = await authService.updateProfile(1, { email: 'new@x.com' })

    expect(result).toMatchObject({ code: 'CURRENT_PASSWORD_REQUIRED' })
    expect(mockPrisma.user.update).not.toHaveBeenCalled()
  })

  it('rejects a wrong current password', async () => {
    const hash = await hashPassword('correct-pw')
    mockPrisma.user.findUnique.mockResolvedValue(baseUser({ password: hash }))

    const result = await authService.updateProfile(1, { email: 'new@x.com', currentPassword: 'wrong-pw' })

    expect(result).toMatchObject({ code: 'CURRENT_PASSWORD_INVALID' })
    expect(mockPrisma.user.update).not.toHaveBeenCalled()
  })

  it('accepts the right current password and persists the email change', async () => {
    const hash = await hashPassword('correct-pw')
    mockPrisma.user.findUnique
      .mockResolvedValueOnce(baseUser({ password: hash })) // the user being updated
      .mockResolvedValueOnce(null) // email-conflict precheck: no one else has it
    mockPrisma.user.update.mockResolvedValue(baseUser({ password: hash, email: 'new@x.com' }))

    const result = await authService.updateProfile(1, { email: 'new@x.com', currentPassword: 'correct-pw' })

    expect('user' in result).toBe(true)
    const data = mockPrisma.user.update.mock.calls.at(-1)![0].data
    // A self-service email change always demotes emailVerified back to false — a fresh, unverified
    // claim must never be trusted for Google auto-linking (see findOrCreateGoogleUser below).
    expect(data).toEqual({ email: 'new@x.com', emailVerified: false })
  })

  it('does not ask for a password when email is resubmitted unchanged', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseUser())
    mockPrisma.user.update.mockResolvedValue(baseUser())

    // Same value as already stored — a client that always submits the full form
    // must not be asked to confirm a field it didn't actually change.
    const result = await authService.updateProfile(1, { name: 'Fernando', email: 'old@x.com' })

    expect('user' in result).toBe(true)
    const data = mockPrisma.user.update.mock.calls.at(-1)![0].data
    expect(data).toEqual({ name: 'Fernando' })
  })

  it('rejects an e-mail already used by another account', async () => {
    const hash = await hashPassword('correct-pw')
    mockPrisma.user.findUnique
      .mockResolvedValueOnce(baseUser({ password: hash }))
      .mockResolvedValueOnce({ id: 2 }) // someone else already has this email

    const result = await authService.updateProfile(1, { email: 'taken@x.com', currentPassword: 'correct-pw' })

    expect(result).toMatchObject({ code: 'EMAIL_TAKEN' })
    expect(mockPrisma.user.update).not.toHaveBeenCalled()
  })

  it('skips the current-password check for a Google-only account (no password set)', async () => {
    mockPrisma.user.findUnique
      .mockResolvedValueOnce(baseUser({ password: null }))
      .mockResolvedValueOnce(null)
    mockPrisma.user.update.mockResolvedValue(baseUser({ password: null, username: 'newname' }))

    const result = await authService.updateProfile(1, { username: 'newname' })

    expect('user' in result).toBe(true)
    expect(mockPrisma.user.update).toHaveBeenCalled()
  })
})

describe('changePassword', () => {
  const now = () => Math.floor(Date.now() / 1000)

  it('requires the current password when one is already set', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseUser())

    const result = await authService.changePassword(1, undefined, 'new-password-123', now())

    expect(result).toMatchObject({ code: 'CURRENT_PASSWORD_REQUIRED' })
    expect(mockPrisma.user.update).not.toHaveBeenCalled()
  })

  it('rejects a wrong current password', async () => {
    const hash = await hashPassword('correct-pw')
    mockPrisma.user.findUnique.mockResolvedValue(baseUser({ password: hash }))

    const result = await authService.changePassword(1, 'wrong-pw', 'new-password-123', now())

    expect(result).toMatchObject({ code: 'CURRENT_PASSWORD_INVALID' })
    expect(mockPrisma.user.update).not.toHaveBeenCalled()
  })

  it('changes the password when the current one is correct, bumping sessionVersion to revoke other devices', async () => {
    const hash = await hashPassword('correct-pw')
    mockPrisma.user.findUnique.mockResolvedValue(baseUser({ password: hash }))
    mockPrisma.user.update.mockResolvedValue({ sessionVersion: 1 })

    const result = await authService.changePassword(1, 'correct-pw', 'new-password-123', now())

    expect(result).toEqual({ ok: true, sessionVersion: 1 })
    const data = mockPrisma.user.update.mock.calls.at(-1)![0].data
    expect(data.password).not.toBe(hash)
    expect(typeof data.password).toBe('string')
    expect(data.sessionVersion).toEqual({ increment: 1 })
  })

  it('lets a Google-only account define a password with no current-password check, given a fresh session', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseUser({ password: null }))
    mockPrisma.user.update.mockResolvedValue({ sessionVersion: 1 })

    const result = await authService.changePassword(1, undefined, 'new-password-123', now() - 60) // logged in 1 min ago

    expect(result).toEqual({ ok: true, sessionVersion: 1 })
    expect(mockPrisma.user.update).toHaveBeenCalled()
  })

  it('refuses to define a first password from a STALE session (narrows the stolen-cookie window)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseUser({ password: null }))

    // Session was issued 1 hour ago — well past the reauth window — even though the cookie
    // itself is still validly signed and not expired.
    const result = await authService.changePassword(1, undefined, 'new-password-123', now() - 3600)

    expect(result).toMatchObject({ code: 'REAUTH_REQUIRED' })
    expect(mockPrisma.user.update).not.toHaveBeenCalled()
  })
})

describe('login — carries sessionVersion into the caller-signed JWT (BL-13)', () => {
  it('returns the user\'s current sessionVersion on success', async () => {
    const hash = await hashPassword('correct-pw')
    mockPrisma.user.findUnique.mockResolvedValue(baseUser({ password: hash, sessionVersion: 4 }))

    const result = await authService.login('fernando', 'correct-pw')

    expect(result).toMatchObject({ status: 'ok', user: { sessionVersion: 4 } })
  })
})

describe('bumpSessionVersion — revokes every previously issued JWT for a user (BL-13)', () => {
  it('increments and returns the new version', async () => {
    mockPrisma.user.update.mockResolvedValue({ sessionVersion: 5 })

    const result = await authService.bumpSessionVersion(1)

    expect(result).toBe(5)
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { sessionVersion: { increment: 1 } },
      select: { sessionVersion: true },
    })
  })
})

describe('findOrCreateGoogleUser', () => {
  it('matches an existing user by googleId and does not touch email linking at all', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce(baseUser({ googleId: 'g-1' }))

    const result = await authService.findOrCreateGoogleUser({ googleId: 'g-1', email: 'old@x.com', name: 'Fernando' })

    expect(result.id).toBe(1)
    expect(mockPrisma.user.update).not.toHaveBeenCalled()
    expect(mockPrisma.user.create).not.toHaveBeenCalled()
  })

  it('links an existing unclaimed, verified-email account on first Google login', async () => {
    mockPrisma.user.findUnique
      .mockResolvedValueOnce(null) // no match by googleId
      .mockResolvedValueOnce(baseUser({ googleId: null, emailVerified: true, password: 'x' })) // by email
    mockPrisma.user.update.mockResolvedValue(baseUser({ googleId: 'g-new' }))

    const result = await authService.findOrCreateGoogleUser({ googleId: 'g-new', email: 'old@x.com' })

    expect(result.id).toBe(1)
    expect(mockPrisma.user.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { googleId: 'g-new' } })
    expect(mockPrisma.user.create).not.toHaveBeenCalled()
  })

  it('refuses to re-link an account that already has a DIFFERENT googleId (prevents account re-hijack)', async () => {
    mockPrisma.user.findUnique
      .mockResolvedValueOnce(null) // no match by the attacker's googleId
      .mockResolvedValueOnce(baseUser({ googleId: 'victim-google-id', emailVerified: true })) // by email
      .mockResolvedValueOnce(null) // uniqueUsernameFromEmail's uniqueness check — candidate is free
    mockPrisma.user.create.mockResolvedValue(baseUser({ id: 99, googleId: 'attacker-google-id', email: null, emailVerified: false }))

    const result = await authService.findOrCreateGoogleUser({ googleId: 'attacker-google-id', email: 'old@x.com', name: 'Attacker' })

    expect(mockPrisma.user.update).not.toHaveBeenCalled()
    expect(mockPrisma.user.create).toHaveBeenCalled()
    const createData = mockPrisma.user.create.mock.calls.at(-1)![0].data
    // The disputed email must NOT be planted on the new row either — it already belongs to someone else.
    expect(createData.email).toBeNull()
    expect(result.id).toBe(99)
  })

  it('refuses to link by an UNVERIFIED (self-service-claimed) email — closes the pre-hijack chain', async () => {
    mockPrisma.user.findUnique
      .mockResolvedValueOnce(null) // no match by googleId
      .mockResolvedValueOnce(baseUser({ googleId: null, emailVerified: false })) // attacker pre-claimed this email
      .mockResolvedValueOnce(null) // uniqueUsernameFromEmail's uniqueness check — candidate is free
    mockPrisma.user.create.mockResolvedValue(baseUser({ id: 99, email: null, emailVerified: false, googleId: 'victim-google-id' }))

    const result = await authService.findOrCreateGoogleUser({ googleId: 'victim-google-id', email: 'old@x.com', name: 'Victim' })

    expect(mockPrisma.user.update).not.toHaveBeenCalled()
    expect(mockPrisma.user.create).toHaveBeenCalled()
    const createData = mockPrisma.user.create.mock.calls.at(-1)![0].data
    expect(createData.email).toBeNull()
    expect(result.id).toBe(99)
  })

  it('creates a brand-new, verified-email user when nothing matches', async () => {
    mockPrisma.user.findUnique
      .mockResolvedValueOnce(null) // no match by googleId
      .mockResolvedValueOnce(null) // no match by email either
      .mockResolvedValueOnce(null) // uniqueUsernameFromEmail's uniqueness check — candidate is free
    mockPrisma.user.create.mockResolvedValue(baseUser({ id: 42, email: 'brand-new@x.com', emailVerified: true, googleId: 'g-42', password: null }))

    const result = await authService.findOrCreateGoogleUser({ googleId: 'g-42', email: 'brand-new@x.com', name: 'New Person' })

    expect(result.id).toBe(42)
    const createData = mockPrisma.user.create.mock.calls.at(-1)![0].data
    expect(createData.email).toBe('brand-new@x.com')
    expect(createData.emailVerified).toBe(true)
  })
})
