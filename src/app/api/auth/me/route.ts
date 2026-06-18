import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { authService } from '@/services/auth.service'
import { handleApiError, requireSession } from '@/lib/api-helpers'

export async function GET() {
  try {
    const check = await requireSession()
    if (!check.ok) return check.response

    const user = await authService.getUserWithGroups(check.session.userId)
    if (!user) {
      return NextResponse.json({ error: 'Usuário não encontrado' }, { status: 404 })
    }

    const h = await headers()
    const preferredGroupId = Number(h.get('x-group-id')) || null
    const activeGroup =
      user.groups.find(g => g.id === preferredGroupId) ?? user.groups[0] ?? null

    return NextResponse.json({ user, activeGroupId: activeGroup?.id ?? null })
  } catch (error) {
    return handleApiError(error, 'Erro ao carregar sessão')
  }
}
