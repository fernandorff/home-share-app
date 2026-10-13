import { NextResponse } from 'next/server'
import { expenseService } from '@/services/expense.service'
import { handleApiError, requireActiveGroup } from '@/lib/api-helpers'
import { sanitizeDefaultDate } from '@/lib/csv-parser'
import { ApiError } from '@/lib/errors'

export async function GET(request: Request) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const csv = await expenseService.exportToCSV(check.groupId)
    // R3-02: the server runs in UTC, so in the evening its "today" is already tomorrow in Brazil —
    // the browser sends its local day (?date=), accepted only within ±1 day of UTC (Task 1's rule).
    const day = sanitizeDefaultDate(new URL(request.url).searchParams.get('date')) ?? new Date().toISOString().split('T')[0]
    const filename = `home-share-expenses-${day}.csv`

    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`
      }
    })
  } catch (error) {
    // handleApiError logs / reports the RAW error; an unexpected failure then answers with a translatable
    // `code` (ApiErrors) instead of its bare message. Typed errors keep their own status and code.
    const res = await handleApiError(error, 'Failed to export expenses')
    if (error instanceof ApiError || res.status !== 500) return res
    return NextResponse.json({ error: 'Failed to export expenses', code: 'EXPORT_FAILED' }, { status: 500 })
  }
}
