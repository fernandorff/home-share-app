import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockCookies, mockPrisma, mockVerifySession } = vi.hoisted(() => ({
  mockCookies: vi.fn(),
  mockPrisma: { user: { findUnique: vi.fn() } },
  mockVerifySession: vi.fn(),
}))
vi.mock('next/headers', () => ({ cookies: mockCookies }))
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>()
  return { ...actual, verifySession: mockVerifySession }
})

import { requireSession } from './api-helpers'

beforeEach(() => {
  vi.resetAllMocks()
})

function mockCookieStore(token: string | undefined) {
  mockCookies.mockResolvedValue({
    get: (name: string) => (name === 'bolitas_session' && token ? { value: token } : undefined),
  })
}

describe('requireSession — sessionVersion revocation (BL-13)', () => {
  it('rejects when there is no session cookie', async () => {
    mockCookieStore(undefined)
    const result = await requireSession()
    expect(result.ok).toBe(false)
  })

  it('rejects when the JWT itself is invalid/expired', async () => {
    mockCookieStore('bad-token')
    mockVerifySession.mockResolvedValue(null)
    const result = await requireSession()
    expect(result.ok).toBe(false)
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled()
  })

  it('accepts when the token sessionVersion matches the current DB value', async () => {
    mockCookieStore('good-token')
    mockVerifySession.mockResolvedValue({ userId: 1, publicId: 'p1', name: 'Fernando', sessionVersion: 2, iat: 0 })
    mockPrisma.user.findUnique.mockResolvedValue({ sessionVersion: 2 })

    const result = await requireSession()

    expect(result.ok).toBe(true)
  })

  it('rejects a stale token — revoked by a logout or password change on another device', async () => {
    mockCookieStore('old-token')
    mockVerifySession.mockResolvedValue({ userId: 1, publicId: 'p1', name: 'Fernando', sessionVersion: 1, iat: 0 })
    mockPrisma.user.findUnique.mockResolvedValue({ sessionVersion: 2 }) // bumped since this token was signed

    const result = await requireSession()

    expect(result.ok).toBe(false)
    if (!result.ok) {
      const body = await result.response.json()
      expect(result.response.status).toBe(401)
      expect(body.code).toBe('SESSION_REVOKED')
    }
  })

  it('clears the dead cookie on a revoked session — otherwise middleware (JWT-only, no DB check) ' +
     'still sees a "valid" token and bounces the browser straight back out of /auth/login, an ' +
     'infinite redirect loop instead of ever reaching the sign-in form', async () => {
    mockCookieStore('old-token')
    mockVerifySession.mockResolvedValue({ userId: 1, publicId: 'p1', name: 'Fernando', sessionVersion: 1, iat: 0 })
    mockPrisma.user.findUnique.mockResolvedValue({ sessionVersion: 2 })

    const result = await requireSession()

    expect(result.ok).toBe(false)
    if (!result.ok) {
      const setCookie = result.response.headers.get('set-cookie')
      expect(setCookie).toMatch(/bolitas_session=;/)
    }
  })

  it('rejects when the user row backing the token no longer exists', async () => {
    mockCookieStore('token')
    mockVerifySession.mockResolvedValue({ userId: 999, publicId: 'p1', name: 'Ghost', sessionVersion: 0, iat: 0 })
    mockPrisma.user.findUnique.mockResolvedValue(null)

    const result = await requireSession()

    expect(result.ok).toBe(false)
  })
})
