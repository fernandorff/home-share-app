import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { toCents, fromCents } from '@/lib/currency'
import { verifySession, SessionPayload, SESSION_COOKIE, GROUP_COOKIE } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { ApiError } from '@/lib/errors'

export function handleApiError(error: unknown, defaultMsg: string): NextResponse {
  // Expected, typed failures (not-found, invalid input) carry their own status/code.
  if (error instanceof ApiError) {
    return NextResponse.json(
      error.code ? { error: error.message, code: error.code } : { error: error.message },
      { status: error.status }
    )
  }
  // Anything else is unexpected: log the full detail server-side, but return a
  // generic message so we never leak stack traces, file paths, or DB internals.
  console.error(defaultMsg, error)
  return NextResponse.json({ error: defaultMsg }, { status: 500 })
}

export type SessionCheck =
  | { ok: true; session: SessionPayload }
  | { ok: false; response: NextResponse }

export async function requireSession(): Promise<SessionCheck> {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE)?.value
  const session = token ? await verifySession(token) : null
  if (!session) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Não autenticado', code: 'NOT_AUTHENTICATED' }, { status: 401 }),
    }
  }
  return { ok: true, session }
}

export type GroupCheck =
  | { ok: true; session: SessionPayload; groupId: number; role: 'ADMIN' | 'MEMBER' }
  | { ok: false; response: NextResponse }

/**
 * Resolves the active group for the request: the group cookie is a preference,
 * membership in the database is the authority. Falls back to the user's first group.
 */
export async function requireActiveGroup(): Promise<GroupCheck> {
  const check = await requireSession()
  if (!check.ok) return check

  const cookieStore = await cookies()
  const preferredGroupId = Number(cookieStore.get(GROUP_COOKIE)?.value) || null

  const memberships = await prisma.groupMember.findMany({
    where: { userId: check.session.userId },
    orderBy: { createdAt: 'asc' },
    select: { groupId: true, role: true },
  })

  if (memberships.length === 0) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Você ainda não participa de nenhuma casa', code: 'NO_GROUP' },
        { status: 403 }
      ),
    }
  }

  const active =
    memberships.find(m => m.groupId === preferredGroupId) ?? memberships[0]

  return { ok: true, session: check.session, groupId: active.groupId, role: active.role }
}

/** Validates that the given users are all members of the group (payer/participants). */
export async function allGroupMembers(groupId: number, userIds: number[]): Promise<boolean> {
  if (userIds.length === 0) return true
  const count = await prisma.groupMember.count({
    where: { groupId, userId: { in: userIds } },
  })
  return count === new Set(userIds).size
}

interface ExpenseInputRaw {
  description?: string
  notes?: string
  amount?: number
  date?: string
  payerId?: number
  platformId?: number
  splitEqually?: boolean
  participants?: { userId: number; amount: number }[]
}

export interface ValidatedExpenseInput {
  description: string
  notes?: string
  amount: number
  date?: Date
  payerId: number
  platformId?: number | null
  splitEqually: boolean
  participants: { userId: number; amount: number }[]
}

export function validateExpenseInput(
  body: ExpenseInputRaw,
  options: { payerRequired?: boolean } = {}
): { valid: true; data: ValidatedExpenseInput } | { valid: false; response: NextResponse } {
  const { description, notes, amount, date, payerId, platformId, splitEqually = true, participants = [] } = body
  const { payerRequired = true } = options

  if (!description || description.trim() === '') {
    return { valid: false, response: NextResponse.json({ error: 'Descrição é obrigatória' }, { status: 400 }) }
  }

  if (description.length > 200) {
    return { valid: false, response: NextResponse.json({ error: 'Descrição muito longa (máx. 200 caracteres)' }, { status: 400 }) }
  }

  if (notes && notes.length > 1000) {
    return { valid: false, response: NextResponse.json({ error: 'Observação muito longa (máx. 1000 caracteres)' }, { status: 400 }) }
  }

  if (!amount || amount <= 0) {
    return { valid: false, response: NextResponse.json({ error: 'Valor deve ser maior que zero' }, { status: 400 }) }
  }

  // amount is stored as Decimal(10,2) — reject values that would overflow the column (max 99.999.999,99)
  if (toCents(amount) > 9_999_999_999) {
    return { valid: false, response: NextResponse.json({ error: 'Valor muito alto (máx. 99.999.999,99)' }, { status: 400 }) }
  }

  // Membership of payer/participants in the active group is validated by the route
  // via allGroupMembers() — here we only check presence.
  if (payerRequired && !payerId) {
    return { valid: false, response: NextResponse.json({ error: 'Pagador é obrigatório' }, { status: 400 }) }
  }

  // Custom split: every share must be a real, non-negative number, with no duplicate
  // participants, and the parts must sum exactly to the total (integer-cents comparison).
  if (!splitEqually) {
    if (participants.length === 0) {
      return { valid: false, response: NextResponse.json({ error: 'Divisão personalizada precisa de ao menos um participante' }, { status: 400 }) }
    }
    const ids = participants.map(p => p.userId)
    if (new Set(ids).size !== ids.length) {
      return { valid: false, response: NextResponse.json({ error: 'Há um participante repetido na divisão' }, { status: 400 }) }
    }
    if (participants.some(p => !Number.isFinite(p.amount) || p.amount < 0)) {
      return { valid: false, response: NextResponse.json({ error: 'Valor de um participante não pode ser negativo' }, { status: 400 }) }
    }
    const totalCents = participants.reduce((sum, p) => sum + toCents(p.amount), 0)
    const totalParticipants = fromCents(totalCents)
    if (totalCents !== toCents(amount)) {
      return {
        valid: false,
        response: NextResponse.json({
          error: `Soma dos valores dos participantes (${totalParticipants.toFixed(2)}) difere do valor total (${amount.toFixed(2)})`
        }, { status: 400 })
      }
    }
  }

  return {
    valid: true,
    data: {
      description,
      notes,
      amount,
      date: date ? new Date(date + (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? 'T12:00:00' : '')) : undefined,
      payerId: payerId!,
      platformId: platformId ?? null,
      splitEqually,
      participants,
    }
  }
}
