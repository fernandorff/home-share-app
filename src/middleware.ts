import { NextRequest, NextResponse } from 'next/server'
import { verifySession, renewedSessionToken, sessionCookieOptions, groupCookieOptions, SESSION_COOKIE, GROUP_COOKIE } from '@/lib/auth'
import { stampRequestContext } from '@/lib/observability/request-context'

const PUBLIC_PAGE_PREFIXES = ['/auth']
// /api/cron/: scheduled jobs (spec 008) carry no cookie — each route authenticates itself with the
// CRON_SECRET bearer (requireCron). The trailing slash keeps a future /api/cron-admin gated.
const PUBLIC_API_PREFIXES = ['/api/auth', '/api/health', '/api/cron/']

// Pass-through carrying request-scoped observability headers (spec 007). The middleware overwrites any
// client-sent copy of them on every request it handles, and nothing uses them for authorization:
// handleApiError only reads them for the log line and the Sentry tags.
function pass(request: NextRequest): NextResponse {
  return NextResponse.next({
    request: { headers: stampRequestContext(request.headers, request.nextUrl.pathname) },
  })
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  const isPublicApi = PUBLIC_API_PREFIXES.some(p => pathname.startsWith(p))
  if (isPublicApi) {
    return pass(request)
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value
  const session = token ? await verifySession(token) : null

  const isPublicPage = PUBLIC_PAGE_PREFIXES.some(p => pathname.startsWith(p))
  if (isPublicPage) {
    // Already signed in — /auth/login and /auth/register are dead ends otherwise.
    if (session) {
      return NextResponse.redirect(new URL('/expenses', request.url))
    }
    return pass(request)
  }

  if (!session) {
    if (pathname.startsWith('/api')) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }
    const loginUrl = new URL('/auth/login', request.url)
    return NextResponse.redirect(loginUrl)
  }

  // Sliding session (ADR 0013): at most once a day, a PAGE request re-signs the cookie for another 30 days (the
  // active-house preference goes with it). Never on /api: requireSession answers a revoked token with a cookie
  // delete, which a renewal on the same response would race. No DB read here — a revoked token renews too, and
  // the page's first API call still clears it.
  const response = pass(request)
  if (pathname.startsWith('/api')) return response
  const renewed = await renewedSessionToken(session)
  if (renewed) {
    response.cookies.set(SESSION_COOKIE, renewed, sessionCookieOptions())
    const group = request.cookies.get(GROUP_COOKIE)?.value
    if (group) response.cookies.set(GROUP_COOKIE, group, groupCookieOptions())
  }
  return response
}

export const config = {
  // monitoring = Sentry's same-origin tunnel (spec 007): it must reach its rewrite without the auth
  // gate, so pages viewed while logged out (login, register) can report too. Anchored (`monitoring/?$`)
  // so ONLY the tunnel path itself skips the gate, not every path that merely starts with "monitoring".
  // api/health = keep-warm health check (cron-pinged): already public in middleware body, exclude here
  // so Sentry SDK's request span is not generated.
  // icon.svg / icons/ / manifest.json = the favicon and the PWA files (spec 009): browsers fetch them without
  // the session cookie. Anchored, so look-alike paths stay gated.
  // sw.js = the push service worker (spec 010): the browser fetches it and its update checks without the cookie.
  // Anchored too (`sw\.js$`): /sw.jsx, /sw.js/x and /swXjs stay gated.
  // favicon.* anchored as well (they used to match any path starting with them); no workbox is used.
  matcher: ['/((?!monitoring/?$|api/health/?$|_next/static|_next/image|favicon\\.ico$|favicon\\.svg$|icon\\.svg$|icons/|manifest\\.json$|sw\\.js$).*)']
}
