import { logger } from '@/lib/logger'
import {
  recurringExpenseService,
  type RecurringExpenseDto,
  type RecurringViewer,
} from '@/services/recurring-expense.service'

/**
 * The rule routes' synchronous run (spec 008, criterion 7): after a change that can make the rule due today
 * (create, edit, resume) post that rule only, and re-read it if the run wrote anything — the DTO the service
 * returned predates the run, so its `upcoming` and `lastClosedPeriod` would be stale.
 *
 * The change is already committed when this runs, so it never throws: an error here would turn a saved rule
 * into a 500 and a client retry would duplicate it. A failure is logged and the saved DTO returned; the next
 * cron run posts the period (idempotent through the ledger).
 */
export async function postRuleNow(
  groupId: number,
  viewer: RecurringViewer,
  saved: { id: number; rule: RecurringExpenseDto },
  now: Date
): Promise<{ rule: RecurringExpenseDto; postedNow: number }> {
  let postedNow = 0
  try {
    const run = await recurringExpenseService.postDue(now, { recurringExpenseId: saved.id })
    postedNow = run.posted
    const changed = run.posted + run.skipped + run.paused + run.duplicates > 0
    const rule = changed ? await recurringExpenseService.get(groupId, viewer, saved.rule.publicId, now) : saved.rule
    return { rule, postedNow }
  } catch (error) {
    logger.error('recurring expense synchronous posting failed', { recurringExpenseId: saved.id }, error)
    return { rule: saved.rule, postedNow }
  }
}
