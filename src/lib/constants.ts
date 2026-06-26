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
} as const
