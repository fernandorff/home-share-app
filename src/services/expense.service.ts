import { prisma } from '@/lib/prisma'
import { uuidv7 } from '@/lib/uuid'
import { parseCSVDetailed, ExpenseRow, InvalidRow } from '@/lib/csv-parser'
import { toCents, fromCents, splitCents } from '@/lib/currency'
import { ApiError } from '@/lib/errors'

export interface CreateExpenseInput {
  payerId: number
  platformId?: number | null
  description: string
  notes?: string | null
  category?: string | null
  amount: number
  date?: Date
  participants?: { userId: number; amount: number }[]
  splitEqually?: boolean
}

export interface UpdateExpenseInput {
  payerId?: number
  platformId?: number | null
  description?: string
  notes?: string | null
  category?: string | null
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

export const VALID_SORT_FIELDS = ['date', 'amount', 'description', 'payer', 'platformId', 'createdAt'] as const

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
  platform: { select: { id: true, publicId: true, name: true } },
  participants: {
    include: {
      user: { select: { id: true, publicId: true, name: true, username: true } }
    }
  }
}

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
        include: expenseInclude,
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
      include: expenseInclude
    })
  }

  async create(groupId: number, memberIds: number[], input: CreateExpenseInput) {
    const { payerId, platformId, description, notes, category, amount, date, participants, splitEqually } = input

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
        platformId,
        description: description.trim(),
        notes: notes?.trim() || null,
        category: category ?? null,
        amount,
        date: date ?? new Date(),
        participants: { create: participantData }
      },
      include: expenseInclude
    })
  }

  async update(groupId: number, expenseId: number, memberIds: number[], input: UpdateExpenseInput) {
    const { payerId, platformId, description, notes, category, amount, date, participants, splitEqually } = input

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
        select: { id: true }
      })
      if (!existing) {
        throw new ApiError('Despesa não encontrada nesta casa', 404)
      }

      if (participantData) {
        await tx.expenseParticipant.deleteMany({
          where: { expenseId }
        })
      }

      return tx.expense.update({
        where: { id: expenseId },
        data: {
          ...(payerId !== undefined && { payerId }),
          ...(platformId !== undefined && { platformId }),
          ...(description && { description: description.trim() }),
          ...(notes !== undefined && { notes: notes?.trim() || null }),
          ...(category !== undefined && { category }),
          ...(amount !== undefined && { amount }),
          ...(date && { date }),
          ...(participantData && {
            participants: { create: participantData }
          })
        },
        include: expenseInclude
      })
    })
  }

  async delete(groupId: number, expenseId: number) {
    const result = await prisma.expense.deleteMany({
      where: { id: expenseId, groupId }
    })
    return result.count
  }

  async bulkDelete(groupId: number, expenseIds: number[]) {
    const result = await prisma.expense.deleteMany({
      where: { id: { in: expenseIds }, groupId }
    })
    return result.count
  }

  async importFromCSV(
    groupId: number,
    memberIds: number[],
    csvText: string,
    payerId: number,
    platformId: number | null,
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

    // All-or-nothing: one failure rolls back the entire import (safe to retry).
    await prisma.$transaction(async (tx) => {
      for (const expense of expenses) {
        const participantData = splitEqually
          ? equalSplit(expense.valor, memberIds)
          : memberIds.map(userId => ({
              userId,
              amount: userId === payerId ? expense.valor : 0
            }))

        await tx.expense.create({
          data: {
            publicId: uuidv7(),
            groupId,
            payerId,
            platformId,
            description: expense.descricao,
            notes: expense.observacao || null,
            amount: expense.valor,
            // Same convention as validateExpenseInput: noon local avoids UTC off-by-one
            date: new Date(expense.data + 'T12:00:00'),
            participants: { create: participantData }
          }
        })
      }
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
        platform: { select: { name: true } },
        participants: {
          include: { user: { select: { name: true } } }
        }
      },
      orderBy: { date: 'desc' }
    })

    const escapeCSV = (value: string | null | undefined): string => {
      if (!value) return ''
      if (value.includes(',') || value.includes('"') || value.includes('\n')) {
        return `"${value.replace(/"/g, '""')}"`
      }
      return value
    }

    const BOM = String.fromCharCode(0xfeff)
    const header = 'Date,Description,Notes,Amount,Paid by,Platform,Participants'

    const rows = expenses.map(e => {
      // Dates are stored at UTC midnight; format in UTC to avoid off-by-one in UTC-3
      const dateStr = new Date(e.date).toLocaleDateString('pt-BR', { timeZone: 'UTC' })
      const amountStr = Number(e.amount).toFixed(2).replace('.', ',')
      const participantNames = e.participants.map(p => p.user.name).join('; ')

      return [
        dateStr,
        escapeCSV(e.description),
        escapeCSV(e.notes),
        amountStr,
        escapeCSV(e.payer.name),
        escapeCSV(e.platform?.name),
        escapeCSV(participantNames)
      ].join(',')
    })

    return BOM + [header, ...rows].join('\n')
  }
}

export const expenseService = new ExpenseService()
