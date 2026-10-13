import { NextResponse } from 'next/server'
import { ApiError } from '@/lib/errors'
import { postRuleNow } from '@/lib/recurring-post-now'
import { recurringExpenseService } from '@/services/recurring-expense.service'
import { handleApiError, requireActiveGroup, recordActivity, assertExpectedGroup } from '@/lib/api-helpers'

interface RouteParams {
  params: Promise<{ recurringExpenseId: string }>
}

// A pause/resume body is `{ paused }` alone; these envelope keys are the only ones allowed next to it.
const PAUSE_ENVELOPE_KEYS = new Set(['paused', 'expectedGroupId', 'expectedUpdatedAt'])

/**
 * Pause/resume or edit a rule (spec 008, criteria 14, 16, 18, 24). `{ paused: boolean }` alone pauses or
 * resumes (the current state is a 200 no-op); otherwise the body edits fields and `expectedUpdatedAt` is the
 * stale-state token. Mixing the two, or sending nothing to change, is 400 RECURRING_PATCH_INVALID. A resume or
 * an edit can make the rule due today, so it posts synchronously (`postRuleNow`). The `[recurringExpenseId]`
 * segment is the rule's publicId; ownership and house scoping live in the service.
 */
export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const { recurringExpenseId: publicId } = await params
    const body = await request.json().catch(() => null)
    const staleGroup = assertExpectedGroup(check.groupId, body?.expectedGroupId)
    if (staleGroup) return staleGroup

    const viewer = { userId: check.session.userId, role: check.role }
    const now = new Date()

    if (body?.paused !== undefined) {
      if (typeof body.paused !== 'boolean' || Object.keys(body).some((key) => !PAUSE_ENVELOPE_KEYS.has(key))) {
        throw new ApiError('Send either paused alone or the fields to change', 400, 'RECURRING_PATCH_INVALID')
      }
      const paused: boolean = body.paused
      const result = await recurringExpenseService.setPaused(check.groupId, viewer, publicId, paused, now)
      if (!result.changed) return NextResponse.json({ rule: result.rule, postedNow: 0 })

      await recordActivity({
        groupId: check.groupId,
        actorId: check.session.userId,
        entityType: 'RECURRING_EXPENSE',
        entityId: result.rule.publicId,
        action: paused ? 'PAUSE' : 'RESUME',
        summary: result.rule.description,
      })
      return NextResponse.json(paused ? { rule: result.rule, postedNow: 0 } : await postRuleNow(check.groupId, viewer, result, now))
    }

    const expectedUpdatedAt = typeof body?.expectedUpdatedAt === 'string' ? body.expectedUpdatedAt : undefined
    const result = await recurringExpenseService.update(check.groupId, viewer, publicId, body, expectedUpdatedAt, now)
    if (!result.changed) return NextResponse.json({ rule: result.rule, postedNow: 0 })

    await recordActivity({
      groupId: check.groupId,
      actorId: check.session.userId,
      entityType: 'RECURRING_EXPENSE',
      entityId: result.rule.publicId,
      action: 'UPDATE',
      summary: result.rule.description,
      changes: result.changes,
    })
    return NextResponse.json(await postRuleNow(check.groupId, viewer, result, now))
  } catch (error) {
    return handleApiError(error, 'Failed to update recurring expense')
  }
}

/**
 * Deletes the rule and its ledger (criteria 17, 18, 24). Expenses it already posted stay, with their
 * recurring marker cleared; nothing more is posted.
 */
export async function DELETE(_request: Request, { params }: RouteParams) {
  try {
    const check = await requireActiveGroup()
    if (!check.ok) return check.response

    const { recurringExpenseId: publicId } = await params
    const deleted = await recurringExpenseService.delete(
      check.groupId,
      { userId: check.session.userId, role: check.role },
      publicId
    )

    await recordActivity({
      groupId: check.groupId,
      actorId: check.session.userId,
      entityType: 'RECURRING_EXPENSE',
      entityId: deleted.publicId,
      action: 'DELETE',
      summary: deleted.description,
      changes: { amount: deleted.amount },
    })

    return NextResponse.json({ ok: true })
  } catch (error) {
    return handleApiError(error, 'Failed to delete recurring expense')
  }
}
