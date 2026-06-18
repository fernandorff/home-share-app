import { NextResponse } from 'next/server'
import { SESSION_COOKIE, GROUP_COOKIE } from '@/lib/auth'

export async function POST() {
  const response = NextResponse.json({ ok: true })
  response.cookies.delete(SESSION_COOKIE)
  response.cookies.delete(GROUP_COOKIE)
  return response
}
