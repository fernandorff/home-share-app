import { NextResponse } from 'next/server'

export async function GET() {
  return NextResponse.json({ ok: true, service: 'la-casa-das-bolitas-api' })
}
