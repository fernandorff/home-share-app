import { toNumber } from "@/lib/currency";
import type { Money } from "@/lib/types";

/** Locale-aware currency formatting. Currency is the house's ISO code (display only). */
export function formatMoney(value: Money, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
  }).format(toNumber(value));
}

/** Signed money for balances: "+$66.67" / "−$66.67" (sign kept explicit, locale-formatted). */
export function formatMoneySigned(value: Money, currency: string, locale: string): string {
  const n = toNumber(value);
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${formatMoney(Math.abs(n), currency, locale)}`;
}

/** Locale-aware short date (dates are stored at local noon). */
export function formatDateLocale(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}
