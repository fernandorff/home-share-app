import { NextResponse } from 'next/server'
import { expenseService } from '@/services/expense.service'
import { handleApiError, requireActiveGroup } from '@/lib/api-helpers'

export async function GET() {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const csv = await expenseService.exportToCSV(check.groupId)
    const filename = `despesas-casa-${new Date().toISOString().split('T')[0]}.csv`

    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`
      }
    })
  } catch (error) {
    return handleApiError(error, 'Erro ao exportar despesas')
  }
}
