// Single source of truth for field length limits — referenced by the server validators,
// the CSV parser, and the form inputs so front and back can never drift apart.
export const LIMITS = {
  DESCRIPTION: 200,
  NOTES: 1000,
  SETTLEMENT_NOTE: 500,
  PLATFORM_NAME: 80,
  HOUSEHOLD_NAME: 80,
  SHOPPING_NAME: 200,
  CATEGORY_NAME: 30,
  PAYMENT_NAME: 30,
} as const

// Shared by GET /api/activity (fetches +1 to detect truncation) and the Activity Summary page
// (shows the "N most recent" notice only when the route says there's more) — a single source of
// truth so the two can never drift apart (fix round 1, task 13: exactly-100 false positive).
export const ACTIVITY_SUMMARY_LIMIT = 100

// Activity › Detailed page size (R3-21: one extra row tells the page that older revisions exist).
export const ACTIVITY_DETAILED_LIMIT = 100

// Entity types the Activity "Detailed" feed can filter by (Prisma model names, as stored in
// EntityRevision.entityType). Shared by GET /api/revisions (allow-list) and the filter chips so the
// two can't drift — the route's own list once lacked GroupMember and ignored that chip.
export const REVISION_ENTITY_TYPES = [
  "Expense", "Settlement", "ShoppingItem", "Category", "Platform", "PaymentMethod", "GroupMember", "Group", "RecurringExpense",
] as const
