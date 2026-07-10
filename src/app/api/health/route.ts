import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET(request: Request) {
  // ?db=1 also round-trips the database (SELECT 1) — used by the keep-warm cron (BL-15) so the
  // ping wakes BOTH the serverless function and the Neon compute, not just the function.
  const withDb = new URL(request.url).searchParams.get('db') === '1'
  if (!withDb) return NextResponse.json({ ok: true, service: 'home-share' })
  try {
    await prisma.$queryRaw`SELECT 1`
    return NextResponse.json({ ok: true, service: 'home-share', db: true })
  } catch {
    return NextResponse.json({ ok: false, service: 'home-share', db: false }, { status: 503 })
  }
}
