// System-default platforms (marketplaces / stores). Stored value is a stable key; the UI
// translates it via Expenses.platform.<key>. A house can also add custom platforms (Platform table),
// whose stored value is the free-text name. Expense.platforms[] mixes both.
export const DEFAULT_PLATFORMS = [
  "amazon",
  "mercadolivre",
  "shopee",
  "loja_fisica",
] as const;

export type DefaultPlatform = (typeof DEFAULT_PLATFORMS)[number];

export function isDefaultPlatform(value: unknown): value is DefaultPlatform {
  return typeof value === "string" && (DEFAULT_PLATFORMS as readonly string[]).includes(value);
}
