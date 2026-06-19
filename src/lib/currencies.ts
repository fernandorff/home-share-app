export const SUPPORTED_CURRENCIES = ["BRL", "USD", "EUR", "GBP"] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];
export const DEFAULT_CURRENCY: Currency = "BRL";

export const CURRENCY_META: Record<Currency, { symbol: string }> = {
  BRL: { symbol: "R$" },
  USD: { symbol: "$" },
  EUR: { symbol: "€" },
  GBP: { symbol: "£" },
};

export function isCurrency(value: unknown): value is Currency {
  return (
    typeof value === "string" &&
    (SUPPORTED_CURRENCIES as readonly string[]).includes(value)
  );
}
