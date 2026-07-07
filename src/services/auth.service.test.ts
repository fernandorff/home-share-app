import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
  },
}))
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

import { authService } from './auth.service'
import { hashPassword } from '@/lib/auth'

beforeEach(() => {
  vi.clearAllMocks()
})

function baseUser(overrides: Partial<{ password: string | null; email: string | null }> = {}) {
  return {
    id: 1,
    publicId: 'pub-1',
    name: 'Fernando',
    username: 'fernando',
    email: 'old@x.com',
    password: 'hash-of-something',
    googleId: null,
    ...overrides,
  }
}

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
    expect(data).toEqual({ email: 'new@x.com' })
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
  it('requires the current password when one is already set', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseUser())

    const result = await authService.changePassword(1, undefined, 'new-password-123')

    expect(result).toMatchObject({ code: 'CURRENT_PASSWORD_REQUIRED' })
    expect(mockPrisma.user.update).not.toHaveBeenCalled()
  })

  it('rejects a wrong current password', async () => {
    const hash = await hashPassword('correct-pw')
    mockPrisma.user.findUnique.mockResolvedValue(baseUser({ password: hash }))

    const result = await authService.changePassword(1, 'wrong-pw', 'new-password-123')

    expect(result).toMatchObject({ code: 'CURRENT_PASSWORD_INVALID' })
    expect(mockPrisma.user.update).not.toHaveBeenCalled()
  })

  it('changes the password when the current one is correct', async () => {
    const hash = await hashPassword('correct-pw')
    mockPrisma.user.findUnique.mockResolvedValue(baseUser({ password: hash }))
    mockPrisma.user.update.mockResolvedValue(baseUser())

    const result = await authService.changePassword(1, 'correct-pw', 'new-password-123')

    expect(result).toEqual({ ok: true })
    const data = mockPrisma.user.update.mock.calls.at(-1)![0].data
    expect(data.password).not.toBe(hash)
    expect(typeof data.password).toBe('string')
  })

  it('lets a Google-only account define a password with no current-password check', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseUser({ password: null }))
    mockPrisma.user.update.mockResolvedValue(baseUser())

    const result = await authService.changePassword(1, undefined, 'new-password-123')

    expect(result).toEqual({ ok: true })
    expect(mockPrisma.user.update).toHaveBeenCalled()
  })
})
