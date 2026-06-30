import { NextResponse } from 'next/server'
import { paymentMethodService } from '@/services/payment-method.service'
import { handleApiError, requireActiveGroup } from '@/lib/api-helpers'
import { LIMITS } from '@/lib/constants'

export async function GET(request: Request) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const { searchParams } = new URL(request.url)
    const withCounts = searchParams.get('counts') === 'true'

    const paymentMethods = withCounts
      ? await paymentMethodService.listWithCounts(check.groupId)
      : await paymentMethodService.list(check.groupId)

    return NextResponse.json({ paymentMethods })
  } catch (error) {
    return handleApiError(error, 'Erro ao listar formas de pagamento')
  }
}

export async function POST(request: Request) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const body = await request.json()
    const name = typeof body?.name === 'string' ? body.name.trim() : ''

    if (!name) {
      return NextResponse.json({ error: 'Nome é obrigatório', code: 'NAME_REQUIRED' }, { status: 400 })
    }
    if (name.length > LIMITS.PAYMENT_NAME) {
      return NextResponse.json(
        { error: `Nome muito longo (máx. ${LIMITS.PAYMENT_NAME} caracteres)`, code: 'NAME_TOO_LONG' },
        { status: 400 }
      )
    }

    const paymentMethod = await paymentMethodService.create(check.groupId, name)
    return NextResponse.json({ paymentMethod }, { status: 201 })
  } catch (error) {
    return handleApiError(error, 'Erro ao criar forma de pagamento')
  }
}
