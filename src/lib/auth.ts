import bcrypt from 'bcryptjs'
import { SignJWT, jwtVerify } from 'jose'

export const SESSION_COOKIE = 'homeshare_session'
export const GROUP_COOKIE = 'homeshare_group'
// Sliding session (ADR 0013): the cookie lives 30 days after the LAST use, not after the login — the
// middleware re-signs it at most once per SESSION_RENEW_AFTER_SECONDS. "Log out of all devices" and a
// password change revoke every token immediately via sessionVersion, below.
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30 // 30 days
export const SESSION_RENEW_AFTER_SECONDS = 60 * 60 * 24 // 1 day

export interface SessionPayload {
  userId: number
  publicId: string
  name: string
  // The User.sessionVersion this token was signed with. requireSession() compares it against the
  // CURRENT DB value — a mismatch means the token was revoked (logout / password change bump the
  // column), which a plain stateless JWT could otherwise never express before it expires on its own.
  sessionVersion: number
}

// verifySession's return also carries two unix-second times: `iat`, when THIS token was signed (renewals
// move it), and `authAt`, when the member actually logged in (renewals keep it). Step-up-sensitive actions
// (e.g. defining a password on a passwordless account) gate on authAt — a renewed cookie is not a recent login.
export interface VerifiedSession extends SessionPayload {
  iat: number
  authAt: number
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

/** `authAt` defaults to now (a login); a renewal passes the session's own authAt to keep it. */
export async function signSession(payload: SessionPayload, authAt = Math.floor(Date.now() / 1000)): Promise<string> {
  return new SignJWT({ ...payload, authAt })
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
    const iat = typeof payload.iat === 'number' ? payload.iat : 0
    return {
      userId: payload.userId,
      publicId: payload.publicId,
      name: typeof payload.name === 'string' ? payload.name : '',
      sessionVersion: typeof payload.sessionVersion === 'number' ? payload.sessionVersion : 0,
      iat,
      // Tokens signed before ADR 0013 carry no authAt: their iat WAS the login time.
      authAt: typeof payload.authAt === 'number' ? payload.authAt : iat,
    }
  } catch {
    return null
  }
}

/** A fresh token for the same session (same claims and login time), or null when it is not due yet. */
export async function renewedSessionToken(session: VerifiedSession, now = Math.floor(Date.now() / 1000)): Promise<string | null> {
  if (now - session.iat < SESSION_RENEW_AFTER_SECONDS) return null
  const { userId, publicId, name, sessionVersion, authAt } = session
  return signSession({ userId, publicId, name, sessionVersion }, authAt)
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
