import { NextResponse } from 'next/server'
import { ApiError } from '@/lib/errors'
import { isValidPeriod } from '@/lib/recurrence'
import { recurringExpenseService } from '@/services/recurring-expense.service'
import { handleApiError, requireActiveGroup, recordActivity } from '@/lib/api-helpers'

interface RouteParams {
  params: Promise<{ recurringExpenseId: string; period: string }>
}

/** Shared by PUT and DELETE: both are idempotent, and only a real change reaches the Summary feed. */
async function setSkipped({ params }: RouteParams, skip: boolean) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const { recurringExpenseId: publicId, period } = await params
    // The service re-checks it and also limits skips to the rule's next 3 upcoming periods.
    if (!isValidPeriod(period)) throw new ApiError('Invalid month', 400, 'RECURRING_PERIOD_INVALID')

    const viewer = { userId: check.session.userId, role: check.role }
    const now = new Date()
    const result = skip
      ? await recurringExpenseService.skip(check.groupId, viewer, publicId, period, now)
      : await recurringExpenseService.unskip(check.groupId, viewer, publicId, period, now)

    if (result.changed) {
      await recordActivity({
        groupId: check.groupId,
        actorId: check.session.userId,
        entityType: 'RECURRING_EXPENSE',
        entityId: result.rule.publicId,
        action: skip ? 'SKIP' : 'UNSKIP',
        summary: result.rule.description,
        changes: { period },
      })
    }

    return NextResponse.json({ rule: result.rule })
  } catch (error) {
    return handleApiError(error, skip ? 'Failed to skip month' : 'Failed to undo skip')
  }
}

/** Skips one of the rule's next 3 upcoming months (spec 008, criteria 15, 18, 24). */
export async function PUT(_request: Request, context: RouteParams) {
  return setSkipped(context, true)
}

/** Undoes the skip of one of the rule's next 3 upcoming months (criteria 15, 18, 24). */
export async function DELETE(_request: Request, context: RouteParams) {
  return setSkipped(context, false)
}
