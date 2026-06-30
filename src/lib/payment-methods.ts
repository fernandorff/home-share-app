// System-default payment methods. Stored value is a stable key; the UI translates it via
// Expenses.payment.<key>. A house can add custom ones (PaymentMethod table), stored as the name.
// Expense.paymentMethods[] mixes both.
export const DEFAULT_PAYMENT_METHODS = [
  "credit",
  "debit",
  "pix",
  "cash",
] as const;

export type DefaultPaymentMethod = (typeof DEFAULT_PAYMENT_METHODS)[number];

export function isDefaultPaymentMethod(value: unknown): value is DefaultPaymentMethod {
  return typeof value === "string" && (DEFAULT_PAYMENT_METHODS as readonly string[]).includes(value);
}
