import { prisma } from '@/lib/prisma'
import { uuidv7 } from '@/lib/uuid'
import { parseCSVDetailed, ExpenseRow, InvalidRow } from '@/lib/csv-parser'
import { toCents, fromCents, splitCents } from '@/lib/currency'
import { ApiError } from '@/lib/errors'

// A cell starting with =, +, -, @ (or tab/CR) is parsed as a live formula by Excel/Sheets/LibreOffice
// when the exported CSV is later opened — free-text fields here (description, notes, names, tags) are
// fully user-controlled, so without this a housemate could plant a formula (e.g. HYPERLINK to exfiltrate
// data, or on old Excel/DDE, run a command) that fires when someone else opens the file. Prefixing with
// an apostrophe forces spreadsheet apps to render the cell as plain text instead of evaluating it.
const FORMULA_INJECTION_PREFIX = /^[=+\-@\t\r]/

export function escapeCSVField(value: string | null | undefined): string {
  if (!value) return ''
  const safe = FORMULA_INJECTION_PREFIX.test(value) ? `'${value}` : value
  if (safe.includes(',') || safe.includes('"') || safe.includes('\n')) {
    return `"${safe.replace(/"/g, '""')}"`
  }
  return safe
}

// Each of the three tag dimensions is an array of strings: a system-default key OR a custom name.
export interface CreateExpenseInput {
  payerId: number
  platforms?: string[]
  paymentMethods?: string[]
  description: string
  notes?: string | null
  categories?: string[]
  amount: number
  date?: Date
  participants?: { userId: number; amount: number }[]
  splitEqually?: boolean
}

export interface UpdateExpenseInput {
  payerId?: number
  platforms?: string[]
  paymentMethods?: string[]
  description?: string
  notes?: string | null
  categories?: string[]
  amount?: number
  date?: Date
  participants?: { userId: number; amount: number }[]
  splitEqually?: boolean
}

export interface ImportExpenseResult {
  created: ExpenseRow[]
  invalidRows: InvalidRow[]
  totalValue: number
}

export const VALID_SORT_FIELDS = ['date', 'amount', 'description', 'payer', 'createdAt'] as const

export interface PaginationParams {
  page: number
  pageSize: number
  sortField: string
  sortDirection: 'asc' | 'desc'
}

// Equal split in integer cents — parts always sum to the exact total.
function equalSplit(amount: number, memberIds: readonly number[]) {
  const shares = splitCents(toCents(amount), memberIds.length)
  return memberIds.map((userId, i) => ({
    userId,
    amount: fromCents(shares[i])
  }))
}

const expenseInclude = {
  payer: { select: { id: true, publicId: true, name: true, username: true } },
  participants: {
    include: {
      user: { select: { id: true, publicId: true, name: true, username: true } }
    }
  }
}

// The list renders payer + the split (userId + amount); the nested participant.user is never read
// client-side. Omitting it trims one user object per participant off every page load.
const expenseListInclude = {
  payer: { select: { id: true, publicId: true, name: true, username: true } },
  participants: { select: { id: true, expenseId: true, userId: true, amount: true } }
}

// Vestigial legacy columns (kept in the DB as a safety net, superseded by the array columns).
// Never read client-side — omit them from responses to trim the payload without dropping data.
const legacyOmit = { category: true, platformId: true, platformIds: true } as const

export class ExpenseService {
  async list(groupId: number, params: PaginationParams) {
    const { page, pageSize, sortField, sortDirection } = params

    let orderBy: Record<string, 'asc' | 'desc'> | { payer: { name: 'asc' | 'desc' } }
    if (sortField === 'payer') {
      orderBy = { payer: { name: sortDirection } }
    } else {
      orderBy = { [sortField]: sortDirection }
    }

    const [expenses, total] = await Promise.all([
      prisma.expense.findMany({
        where: { groupId },
        omit: legacyOmit,
        include: expenseListInclude,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize
      }),
      prisma.expense.count({ where: { groupId } })
    ])

    return {
      expenses,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize)
      }
    }
  }

  /** Group-scoped lookup — never returns another house's expense. */
  async findByPublicId(groupId: number, publicId: string) {
    return prisma.expense.findFirst({
      where: { publicId, groupId },
      omit: legacyOmit,
      include: expenseInclude
    })
  }

  async create(groupId: number, memberIds: number[], input: CreateExpenseInput) {
    const { payerId, platforms, paymentMethods, description, notes, categories, amount, date, participants, splitEqually } = input

    let participantData: { userId: number; amount: number }[]
    if (splitEqually || !participants || participants.length === 0) {
      participantData = equalSplit(amount, memberIds)
    } else {
      participantData = participants
    }

    return prisma.expense.create({
      data: {
        publicId: uuidv7(),
        groupId,
        payerId,
        platforms: platforms ?? [],
        paymentMethods: paymentMethods ?? [],
        description: description.trim(),
        notes: notes?.trim() || null,
        categories: categories ?? [],
        amount,
        date: date ?? new Date(),
        participants: { create: participantData }
      },
      omit: legacyOmit,
      include: expenseInclude
    })
  }

  /**
   * `actingUserId`/`isAdmin` enforce that only the expense's payer or a house admin can edit it —
   * a plain member never gets to rewrite an expense they didn't pay for (money-critical: that
   * would let anyone shift the shared balance in their own favor).
   *
   * `expectedUpdatedAt` is an optimistic-lock guard against the lost-update race: two housemates
   * editing the same expense around the same time used to silently last-write-wins, discarding
   * whichever save landed first with zero warning. When provided (the client always sends the
   * `updatedAt` it had when the edit form opened), a mismatch means someone else saved in the
   * meantime — reject with 409 instead of overwriting their change. Omitted → check skipped
   * (backward compatible with any caller that doesn't track it).
   */
  async update(groupId: number, expenseId: number, actingUserId: number, isAdmin: boolean, memberIds: number[], input: UpdateExpenseInput, expectedUpdatedAt?: string) {
    const { payerId, platforms, paymentMethods, description, notes, categories, amount, date, participants, splitEqually } = input

    let participantData: { userId: number; amount: number }[] | undefined
    if (amount !== undefined) {
      if (splitEqually || !participants || participants.length === 0) {
        participantData = equalSplit(amount, memberIds)
      } else {
        participantData = participants
      }
    }

    return prisma.$transaction(async (tx) => {
      const existing = await tx.expense.findFirst({
        where: { id: expenseId, groupId },
        select: { id: true, payerId: true, updatedAt: true }
      })
      if (!existing) {
        throw new ApiError('Despesa não encontrada nesta casa', 404)
      }
      if (!isAdmin && existing.payerId !== actingUserId) {
        throw new ApiError('Você só pode editar despesas que você pagou (ou ser admin da casa)', 403, 'NOT_EXPENSE_OWNER')
      }
      if (expectedUpdatedAt && existing.updatedAt.toISOString() !== expectedUpdatedAt) {
        throw new ApiError('Esta despesa foi alterada por outra pessoa. Recarregue para ver a versão mais recente.', 409, 'STALE_EXPENSE')
      }

      if (participantData) {
        await tx.expenseParticipant.deleteMany({ where: { expenseId } })
      }

      return tx.expense.update({
        where: { id: expenseId },
        data: {
          ...(payerId !== undefined && { payerId }),
          ...(platforms !== undefined && { platforms }),
          ...(paymentMethods !== undefined && { paymentMethods }),
          ...(description && { description: description.trim() }),
          ...(notes !== undefined && { notes: notes?.trim() || null }),
          ...(categories !== undefined && { categories }),
          ...(amount !== undefined && { amount }),
          ...(date && { date }),
          ...(participantData && { participants: { create: participantData } })
        },
        omit: legacyOmit,
        include: expenseInclude
      })
    })
  }

  /**
   * Same ownership rule as update() (payer or admin only). Uses a single-row `delete` (not
   * `deleteMany`) so the audit extension records a proper per-entity DELETE revision — a
   * `deleteMany` is indistinguishable from a bulk operation and gets excluded from the
   * per-expense/detailed history views, which would make a single delete invisible there.
   */
  async delete(groupId: number, expenseId: number, actingUserId: number, isAdmin: boolean) {
    return prisma.$transaction(async (tx) => {
      const existing = await tx.expense.findFirst({
        where: { id: expenseId, groupId },
        select: { id: true, payerId: true }
      })
      if (!existing) {
        throw new ApiError('Despesa não encontrada nesta casa', 404)
      }
      if (!isAdmin && existing.payerId !== actingUserId) {
        throw new ApiError('Você só pode excluir despesas que você pagou (ou ser admin da casa)', 403, 'NOT_EXPENSE_OWNER')
      }
      return tx.expense.delete({ where: { id: expenseId } })
    })
  }

  async bulkDelete(groupId: number, expenseIds: number[]) {
    const result = await prisma.expense.deleteMany({ where: { id: { in: expenseIds }, groupId } })
    return result.count
  }

  async importFromCSV(
    groupId: number,
    memberIds: number[],
    csvText: string,
    payerId: number,
    platform: string | null,
    splitEqually: boolean
  ): Promise<ImportExpenseResult> {
    // Invalid lines are reported (with line numbers) BEFORE anything is written.
    const { expenses, invalidRows } = parseCSVDetailed(csvText)

    if (expenses.length === 0) {
      const detail = invalidRows.length > 0
        ? ` Linhas com erro: ${invalidRows.map(r => `${r.line} (${r.reason})`).join(', ')}`
        : ''
      throw new ApiError(`Nenhuma despesa válida encontrada no CSV.${detail}`, 400)
    }

    const platforms = platform ? [platform] : []
    const expenseRows = expenses.map(expense => ({
      publicId: uuidv7(),
      groupId,
      payerId,
      platforms,
      description: expense.descricao,
      notes: expense.observacao || null,
      amount: expense.valor,
      // Same convention as validateExpenseInput: noon local avoids UTC off-by-one
      date: new Date(expense.data + 'T12:00:00'),
    }))

    // All-or-nothing: one failure rolls back the entire import (safe to retry). Three bulk writes.
    await prisma.$transaction(async (tx) => {
      await tx.expense.createMany({ data: expenseRows })

      const created = await tx.expense.findMany({
        where: { publicId: { in: expenseRows.map(r => r.publicId) } },
        select: { id: true, publicId: true }
      })
      const idByPublicId = new Map(created.map(c => [c.publicId, c.id]))

      const participantRows = expenses.flatMap((expense, i) => {
        const expenseId = idByPublicId.get(expenseRows[i].publicId)!
        const participantData = splitEqually
          ? equalSplit(expense.valor, memberIds)
          : memberIds.map(userId => ({ userId, amount: userId === payerId ? expense.valor : 0 }))
        return participantData.map(p => ({ ...p, expenseId }))
      })
      await tx.expenseParticipant.createMany({ data: participantRows })
    })

    return {
      created: expenses,
      invalidRows,
      totalValue: expenses.reduce((sum, e) => sum + e.valor, 0)
    }
  }

  async exportToCSV(groupId: number): Promise<string> {
    const expenses = await prisma.expense.findMany({
      where: { groupId },
      include: {
        payer: { select: { name: true } },
        participants: { include: { user: { select: { name: true } } } }
      },
      orderBy: { date: 'desc' }
    })

    const BOM = String.fromCharCode(0xfeff)
    const header = 'Date,Description,Notes,Amount,Paid by,Platforms,Payment,Categories,Participants'

    const rows = expenses.map(e => {
      const dateStr = new Date(e.date).toLocaleDateString('pt-BR', { timeZone: 'UTC' })
      // Dot decimal (not comma): a comma would be read as a column break in this
      // comma-separated file, corrupting the amount on re-import. parseMoneyValue accepts dot.
      const amountStr = Number(e.amount).toFixed(2)
      const participantNames = e.participants.map(p => p.user.name).join('; ')

      return [
        dateStr,
        escapeCSVField(e.description),
        escapeCSVField(e.notes),
        amountStr,
        escapeCSVField(e.payer.name),
        escapeCSVField(e.platforms.join('; ')),
        escapeCSVField(e.paymentMethods.join('; ')),
        escapeCSVField(e.categories.join('; ')),
        escapeCSVField(participantNames)
      ].join(',')
    })

    return BOM + [header, ...rows].join('\n')
  }
}

export const expenseService = new ExpenseService()
