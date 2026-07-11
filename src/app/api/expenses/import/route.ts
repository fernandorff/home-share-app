import { NextResponse } from 'next/server'
import { expenseService } from '@/services/expense.service'
import { groupService } from '@/services/group.service'
import { platformService } from '@/services/platform.service'
import { isDefaultPlatform } from '@/lib/platforms'
import { handleApiError, requireActiveGroup } from '@/lib/api-helpers'

interface ParsedImportBody {
  csvText: string
  splitEqually: boolean
  payerId: number | null
  platform: string | null
}

async function parseRequestBody(request: Request): Promise<ParsedImportBody> {
  const contentType = request.headers.get('content-type') || ''

  let csvText: string
  let splitEqually = true
  let payerId: number | null = null
  let platform: string | null = null

  if (contentType.includes('multipart/form-data')) {
    const formData = await request.formData()
    const file = formData.get('file') as File | null
    if (!file) throw new Error('CSV file not provided')
    csvText = await file.text()

    const divideParam = formData.get('splitEqually')
    if (divideParam !== null) splitEqually = divideParam === 'true'

    const payerParam = formData.get('payerId')
    if (payerParam) payerId = parseInt(payerParam.toString()) || null

    const platformParam = formData.get('platform')
    if (platformParam) platform = platformParam.toString().trim() || null
  } else if (contentType.includes('application/json')) {
    const body = await request.json()
    csvText = body.csv
    if (body.splitEqually !== undefined) splitEqually = body.splitEqually
    if (body.payerId) payerId = parseInt(body.payerId) || null
    if (typeof body.platform === 'string') platform = body.platform.trim() || null
  } else {
    csvText = await request.text()
  }

  return { csvText, splitEqually, payerId, platform }
}

export async function POST(request: Request) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const { csvText, splitEqually, payerId, platform } = await parseRequestBody(request)

    if (!csvText || csvText.trim().length === 0) {
      return NextResponse.json({ error: 'Empty CSV' }, { status: 400 })
    }

    // Platform is optional now; if set it must be a system default or a custom platform of the house.
    if (platform && !isDefaultPlatform(platform) && !(await platformService.existsInGroup(check.groupId, platform))) {
      return NextResponse.json({ error: 'Invalid platform' }, { status: 400 })
    }

    const members = await groupService.listMembers(check.groupId)
    // Active only (BL-16) — CSV import only ever creates brand-new expenses, so an ex-member is
    // never a valid payer/split target here (no edit-grandfathering case, unlike PUT /expenses/[id]).
    const memberIds = members.filter(m => m.active).map(m => m.id)

    const effectivePayerId = payerId ?? check.session.userId
    if (!memberIds.includes(effectivePayerId)) {
      return NextResponse.json({ error: 'Payer is not a member of this house' }, { status: 400 })
    }

    const result = await expenseService.importFromCSV(
      check.groupId,
      memberIds,
      csvText,
      effectivePayerId,
      platform,
      splitEqually
    )

    return NextResponse.json({
      message: `${result.created.length} expenses imported successfully`,
      created: result.created.length,
      invalidRows: result.invalidRows,
      totalValue: result.totalValue,
      expenses: result.created
    }, { status: 201 })
  } catch (error) {
    return handleApiError(error, 'Failed to import expenses')
  }
}
