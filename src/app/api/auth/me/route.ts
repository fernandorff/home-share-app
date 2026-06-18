import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { authService } from '@/services/auth.service'
import { handleApiError, requireSession } from '@/lib/api-helpers'
import { GROUP_COOKIE } from '@/lib/auth'

export async function GET() {
  try {
    const check = await requireSession()
    if (!check.ok) return check.response

    const user = await authService.getUserWithGroups(check.session.userId)
    if (!user) {
      return NextResponse.json({ error: 'Usuário não encontrado' }, { status: 404 })
    }

    const cookieStore = await cookies()
    const preferredGroupId = Number(cookieStore.get(GROUP_COOKIE)?.value) || null
    const activeGroup =
      user.groups.find(g => g.id === preferredGroupId) ?? user.groups[0] ?? null

    return NextResponse.json({ user, activeGroupId: activeGroup?.id ?? null })
  } catch (error) {
    return handleApiError(error, 'Erro ao carregar sessão')
  }
}
