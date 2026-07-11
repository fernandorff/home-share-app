import { NextResponse } from 'next/server'
import { isValidUUID } from '@/lib/uuid'
import { paymentMethodService } from '@/services/payment-method.service'
import { handleApiError, requireActiveGroup } from '@/lib/api-helpers'

interface RouteParams {
  params: Promise<{ paymentMethodId: string }>
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const { paymentMethodId } = await params
    if (!isValidUUID(paymentMethodId)) {
      return NextResponse.json({ error: 'Invalid ID' }, { status: 400 })
    }

    await paymentMethodService.delete(check.groupId, paymentMethodId)
    return NextResponse.json({ message: 'Payment method deleted successfully' })
  } catch (error) {
    return handleApiError(error, 'Failed to delete payment method')
  }
}
