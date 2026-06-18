import { NextRequest, NextResponse } from 'next/server'
import { verifySession, bearerToken } from '@/lib/auth'

// Public endpoints (no Bearer token required).
const PUBLIC_API_PREFIXES = ['/api/auth', '/api/health']

// CORS: Bearer-token API (no cookies) → origin can be wide-open or allowlisted
// via ALLOWED_ORIGINS (comma-separated). Default '*'.
function resolveOrigin(requestOrigin: string | null): string {
  const allow = process.env.ALLOWED_ORIGINS?.split(',').map(s => s.trim()).filter(Boolean)
  if (!allow || allow.length === 0) return '*'
  if (requestOrigin && allow.includes(requestOrigin)) return requestOrigin
  return allow[0]
}

function corsHeaders(requestOrigin: string | null): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': resolveOrigin(requestOrigin),
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Group-Id',
    'Access-Control-Max-Age': '86400',
  }
}

export async function middleware(request: NextRequest) {
  const origin = request.headers.get('origin')
  const cors = corsHeaders(origin)
  const { pathname } = request.nextUrl

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new NextResponse(null, { status: 204, headers: cors })
  }

  const isPublic = PUBLIC_API_PREFIXES.some(p => pathname.startsWith(p))
  if (!isPublic) {
    const token = bearerToken(request.headers.get('authorization'))
    const session = token ? await verifySession(token) : null
    if (!session) {
      return NextResponse.json({ error: 'Não autenticado' }, { status: 401, headers: cors })
    }
  }

  const res = NextResponse.next()
  for (const [k, v] of Object.entries(cors)) res.headers.set(k, v)
  return res
}

export const config = {
  matcher: ['/api/:path*'],
}
