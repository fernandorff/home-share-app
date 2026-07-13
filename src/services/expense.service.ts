import { prisma } from '@/lib/prisma'
import { uuidv7 } from '@/lib/uuid'
import { parseCSVDetailed, ExpenseRow, InvalidRow } from '@/lib/csv-parser'
import { toCents, fromCents, splitCents } from '@/lib/currency'
import { ApiError } from '@/lib/errors'
import type { Prisma } from '@/generated/prisma/client'

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

// Server-side counterpart of the expense list's filter bar (BL-20/P3) — lets the List view do
// real infinite scroll instead of loading every expense up front, since filtering can no longer
// happen client-side once rows are fetched a page at a time.
export interface ExpenseFilterParams {
  query?: string
  payerIds?: number[]
  platforms?: string[]
  categories?: string[]
  paymentMethods?: string[]
  fromDate?: Date
  toDate?: Date
}

export interface PaginationParams {
  page: number
  pageSize: number
  sortField: string
  sortDirection: 'asc' | 'desc'
  filters?: ExpenseFilterParams
  includePayerTotals?: boolean
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
    const { page, pageSize, sortField, sortDirection, filters, includePayerTotals = false } = params

    const where: Prisma.ExpenseWhereInput = { groupId }
    if (filters?.payerIds?.length) where.payerId = { in: filters.payerIds }
    if (filters?.platforms?.length) where.platforms = { hasSome: filters.platforms }
    if (filters?.categories?.length) where.categories = { hasSome: filters.categories }
    if (filters?.paymentMethods?.length) where.paymentMethods = { hasSome: filters.paymentMethods }
    if (filters?.fromDate || filters?.toDate) {
      where.date = {
        ...(filters.fromDate && { gte: filters.fromDate }),
        ...(filters.toDate && { lte: filters.toDate })
      }
    }
    if (filters?.query) {
      // Tag filters (platform/category/payment) are exact-value chips from the filter modal —
      // only the free-text search box needs a substring match, over the two free-text fields
      // plus the payer's name (matches the old client-side search's most common use).
      where.OR = [
        { description: { contains: filters.query, mode: 'insensitive' } },
        { notes: { contains: filters.query, mode: 'insensitive' } },
        { payer: { name: { contains: filters.query, mode: 'insensitive' } } }
      ]
    }

    // Tiebreak on `id` (unique, monotonic) so rows that tie on the sorted field (e.g. same date
    // or same amount) still land in a stable order — without it, offset pagination could show a
    // row twice or skip it entirely across two page fetches.
    const orderBy: Prisma.ExpenseOrderByWithRelationInput[] = sortField === 'payer'
      ? [{ payer: { name: sortDirection } }, { id: sortDirection }]
      : [{ [sortField]: sortDirection }, { id: sortDirection }]

    const [expenses, total, totalSum, payerTotals] = await Promise.all([
      prisma.expense.findMany({
        where,
        omit: legacyOmit,
        include: expenseListInclude,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize
      }),
      prisma.expense.count({ where }),
      prisma.expense.aggregate({ where, _sum: { amount: true } }),
      includePayerTotals
        ? prisma.expense.groupBy({ by: ['payerId'], where, _sum: { amount: true } })
        : Promise.resolve([])
    ])

    return {
      expenses,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
        // Sum across EVERY row matching the current filters, not just this page — lets the UI
        // show a correct running total for the filtered set while only some pages are loaded.
        totalAmount: (totalSum._sum.amount ?? 0).toString(),
        ...(includePayerTotals && {
          payerTotals: payerTotals.map(row => ({
            payerId: row.payerId,
            totalAmount: (row._sum.amount ?? 0).toString()
          }))
        })
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

    try {
      return await prisma.$transaction(async (tx) => {
        const existing = await tx.expense.findFirst({
          where: { id: expenseId, groupId },
          select: { id: true, payerId: true, updatedAt: true }
        })
        if (!existing) {
          throw new ApiError('Expense not found in this house', 404)
        }
        if (!isAdmin && existing.payerId !== actingUserId) {
          throw new ApiError('You can only edit expenses you paid (or be a house admin)', 403, 'NOT_EXPENSE_OWNER')
        }
        if (expectedUpdatedAt && existing.updatedAt.toISOString() !== expectedUpdatedAt) {
          throw new ApiError('This expense was changed by someone else. Reload to see the latest version.', 409, 'STALE_EXPENSE')
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
    } catch (e) {
      // The `expectedUpdatedAt` check catches the SLOW race (form opened, someone else saved, you
      // save later). It can't catch the SIMULTANEOUS race: two saves that both read the same
      // `updatedAt` pass the check, then both deleteMany+recreate participants and the second
      // collides on ExpenseParticipant's @@unique([expenseId, userId]) → Prisma P2002 (or P2034 on
      // a write-conflict/deadlock). Same user-facing meaning as a stale write, so surface the same
      // 409 instead of a raw 500 — the client already knows how to prompt "reload".
      const code = e && typeof e === 'object' && 'code' in e ? (e as { code?: string }).code : undefined
      if (code === 'P2002' || code === 'P2034') {
        throw new ApiError('This expense was changed by someone else. Reload to see the latest version.', 409, 'STALE_EXPENSE')
      }
      throw e
    }
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
        throw new ApiError('Expense not found in this house', 404)
      }
      if (!isAdmin && existing.payerId !== actingUserId) {
        throw new ApiError('You can only delete expenses you paid (or be a house admin)', 403, 'NOT_EXPENSE_OWNER')
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
        ? ` Rows with errors: ${invalidRows.map(r => `${r.line} (${r.code})`).join(', ')}`
        : ''
      throw new ApiError(`No valid expenses found in the CSV.${detail}`, 400)
    }

    const platforms = platform ? [platform] : []
    const expenseRows = expenses.map(expense => ({
      publicId: uuidv7(),
      groupId,
      payerId,
      platforms,
      description: expense.description,
      notes: expense.notes || null,
      amount: expense.amount,
      // Same convention as validateExpenseInput: noon local avoids UTC off-by-one
      date: new Date(expense.date + 'T12:00:00'),
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
          ? equalSplit(expense.amount, memberIds)
          : memberIds.map(userId => ({ userId, amount: userId === payerId ? expense.amount : 0 }))
        return participantData.map(p => ({ ...p, expenseId }))
      })
      await tx.expenseParticipant.createMany({ data: participantRows })
    })

    return {
      created: expenses,
      invalidRows,
      totalValue: expenses.reduce((sum, e) => sum + e.amount, 0)
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
