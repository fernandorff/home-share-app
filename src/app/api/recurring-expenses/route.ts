import { NextResponse } from 'next/server'
import { recurringExpenseService } from '@/services/recurring-expense.service'
import { postRuleNow } from '@/lib/recurring-post-now'
import { handleApiError, requireActiveGroup, recordActivity, assertExpectedGroup } from '@/lib/api-helpers'

/**
 * The active house's recurring rules, the summary card numbers and the 50 most recent closed periods
 * (spec 008, criterion 4). The caller's role decides `canManage` on each rule.
 */
export async function GET() {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const list = await recurringExpenseService.list(
      check.groupId,
      { userId: check.session.userId, role: check.role },
      new Date()
    )
    return NextResponse.json(list)
  } catch (error) {
    return handleApiError(error, 'Failed to list recurring expenses')
  }
}

/**
 * Creates a monthly rule in the active house (criteria 1–3, 6, 7, 24). The service validates the body; then
 * the rule posts synchronously, for itself only, so one created on its due day posts today instead of at the
 * next cron run. `postedNow` is the number of periods posted by that run (0 or 1).
 */
export async function POST(request: Request) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const body = await request.json().catch(() => null)
    const staleGroup = assertExpectedGroup(check.groupId, body?.expectedGroupId)
    if (staleGroup) return staleGroup

    const viewer = { userId: check.session.userId, role: check.role }
    const now = new Date()
    const { id, rule } = await recurringExpenseService.create(check.groupId, viewer, body, now)

    await recordActivity({
      groupId: check.groupId,
      actorId: check.session.userId,
      entityType: 'RECURRING_EXPENSE',
      entityId: rule.publicId,
      action: 'CREATE',
      summary: rule.description,
      changes: { amount: rule.amount },
    })

    const { rule: current, postedNow } = await postRuleNow(check.groupId, viewer, { id, rule }, now)

    return NextResponse.json({ rule: current, postedNow }, { status: 201 })
  } catch (error) {
    return handleApiError(error, 'Failed to create recurring expense')
  }
}
