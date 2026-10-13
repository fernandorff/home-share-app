import { NextResponse } from 'next/server'
import { SESSION_COOKIE, GROUP_COOKIE } from '@/lib/auth'

/**
 * Logs out THIS browser only (ADR 0013): its cookies go, other devices stay signed in. The client deletes this
 * device's push subscription first (lib/logout). Revoking every session is POST /api/auth/logout-all.
 */
export async function POST() {
  const response = NextResponse.json({ ok: true })
  response.cookies.delete(SESSION_COOKIE)
  response.cookies.delete(GROUP_COOKIE)
  return response
}
