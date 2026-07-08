import bcrypt from 'bcryptjs'
import { SignJWT, jwtVerify } from 'jose'

export const SESSION_COOKIE = 'bolitas_session'
export const GROUP_COOKIE = 'bolitas_group'
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30 // 30 days

export interface SessionPayload {
  userId: number
  publicId: string
  name: string
}

// verifySession's return also carries the JWT's issued-at time (unix seconds) so callers can
// gate step-up-sensitive actions (e.g. defining a password on a passwordless account) on how
// recently the session was actually established, not just whether the cookie is still valid.
export interface VerifiedSession extends SessionPayload {
  iat: number
}

function getSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET is required in production')
    }
    return new TextEncoder().encode('dev-only-insecure-secret')
  }
  return new TextEncoder().encode(secret)
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10)
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash)
}

export async function signSession(payload: SessionPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(getSecret())
}

export async function verifySession(token: string): Promise<VerifiedSession | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret())
    if (typeof payload.userId !== 'number' || typeof payload.publicId !== 'string') {
      return null
    }
    return {
      userId: payload.userId,
      publicId: payload.publicId,
      name: typeof payload.name === 'string' ? payload.name : '',
      iat: typeof payload.iat === 'number' ? payload.iat : 0,
    }
  } catch {
    return null
  }
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  }
}

// Group cookie is a UI preference only — every request re-validates membership.
export function groupCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  }
}
