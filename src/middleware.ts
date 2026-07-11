import { NextRequest, NextResponse } from 'next/server'
import { verifySession, SESSION_COOKIE } from '@/lib/auth'

const PUBLIC_PAGE_PREFIXES = ['/auth']
const PUBLIC_API_PREFIXES = ['/api/auth', '/api/health']

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  const isPublicApi = PUBLIC_API_PREFIXES.some(p => pathname.startsWith(p))
  if (isPublicApi) {
    return NextResponse.next()
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value
  const session = token ? await verifySession(token) : null

  const isPublicPage = PUBLIC_PAGE_PREFIXES.some(p => pathname.startsWith(p))
  if (isPublicPage) {
    // Already signed in — /auth/login and /auth/register are dead ends otherwise.
    if (session) {
      return NextResponse.redirect(new URL('/expenses', request.url))
    }
    return NextResponse.next()
  }

  if (!session) {
    if (pathname.startsWith('/api')) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }
    const loginUrl = new URL('/auth/login', request.url)
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|favicon.svg|icons|manifest.json|sw.js|workbox-.*).*)']
}
