import { NextResponse } from 'next/server'
import { expenseService } from '@/services/expense.service'
import { groupService } from '@/services/group.service'
import { platformService } from '@/services/platform.service'
import { handleApiError, requireActiveGroup } from '@/lib/api-helpers'

interface ParsedImportBody {
  csvText: string
  splitEqually: boolean
  payerId: number | null
  platformId: number
}

async function parseRequestBody(request: Request): Promise<ParsedImportBody> {
  const contentType = request.headers.get('content-type') || ''

  let csvText: string
  let splitEqually = true
  let payerId: number | null = null
  let platformId: number = 0

  if (contentType.includes('multipart/form-data')) {
    const formData = await request.formData()
    const file = formData.get('file') as File | null

    if (!file) {
      throw new Error('Arquivo CSV não enviado')
    }

    csvText = await file.text()

    const divideParam = formData.get('splitEqually')
    if (divideParam !== null) {
      splitEqually = divideParam === 'true'
    }

    const payerParam = formData.get('payerId')
    if (payerParam) {
      payerId = parseInt(payerParam.toString()) || null
    }

    const platformParam = formData.get('platformId')
    if (platformParam) {
      platformId = parseInt(platformParam.toString())
    }
  } else if (contentType.includes('application/json')) {
    const body = await request.json()
    csvText = body.csv
    if (body.splitEqually !== undefined) {
      splitEqually = body.splitEqually
    }
    if (body.payerId) {
      payerId = parseInt(body.payerId) || null
    }
    if (body.platformId) {
      platformId = parseInt(body.platformId)
    }
  } else {
    csvText = await request.text()
  }

  return { csvText, splitEqually, payerId, platformId }
}

export async function POST(request: Request) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const { csvText, splitEqually, payerId, platformId } = await parseRequestBody(request)

    if (!csvText || csvText.trim().length === 0) {
      return NextResponse.json({ error: 'CSV vazio' }, { status: 400 })
    }

    if (!platformId) {
      return NextResponse.json({ error: 'Plataforma é obrigatória' }, { status: 400 })
    }

    // Defense-in-depth: the platform id must belong to the active house (never trust a raw id).
    if (!(await platformService.findInGroupById(check.groupId, platformId))) {
      return NextResponse.json({ error: 'Plataforma não pertence a esta casa' }, { status: 400 })
    }

    const members = await groupService.listMembers(check.groupId)
    const memberIds = members.map(m => m.id)

    // Payer defaults to the logged user; must be a member of the house either way.
    const effectivePayerId = payerId ?? check.session.userId
    if (!memberIds.includes(effectivePayerId)) {
      return NextResponse.json({ error: 'Pagador não é membro desta casa' }, { status: 400 })
    }

    const result = await expenseService.importFromCSV(
      check.groupId,
      memberIds,
      csvText,
      effectivePayerId,
      platformId,
      splitEqually
    )

    return NextResponse.json({
      message: `${result.created.length} despesas importadas com sucesso`,
      created: result.created.length,
      invalidRows: result.invalidRows,
      totalValue: result.totalValue,
      expenses: result.created
    }, { status: 201 })
  } catch (error) {
    return handleApiError(error, 'Erro ao importar despesas')
  }
}
