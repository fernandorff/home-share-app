import { toNumber } from "@/lib/currency";
import type { Money } from "@/lib/types";

// Building an Intl.NumberFormat is one of the most expensive things in a hot path, and
// <Money> renders hundreds of times per screen. Cache one formatter per locale|currency.
const formatterCache = new Map<string, Intl.NumberFormat>();

function currencyFormatter(currency: string, locale: string): Intl.NumberFormat {
  const key = `${locale}|${currency}`;
  let fmt = formatterCache.get(key);
  if (!fmt) {
    fmt = new Intl.NumberFormat(locale, { style: "currency", currency });
    formatterCache.set(key, fmt);
  }
  return fmt;
}

/** Locale-aware currency formatting. Currency is the house's ISO code (display only). */
export function formatMoney(value: Money, currency: string, locale: string): string {
  return currencyFormatter(currency, locale).format(toNumber(value));
}

/** Signed money for balances: "+$66.67" / "−$66.67" (sign kept explicit, locale-formatted). */
export function formatMoneySigned(value: Money, currency: string, locale: string): string {
  const n = toNumber(value);
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${formatMoney(Math.abs(n), currency, locale)}`;
}

/** Locale-aware short date (dates are stored at local noon). */
// Same rationale as the currency cache: `toLocaleDateString(locale, opts)` rebuilds an
// Intl.DateTimeFormat on every call — brutal when formatting hundreds of rows. Cache per locale.
const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(locale: string): Intl.DateTimeFormat {
  let fmt = dateFormatterCache.get(locale);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", year: "numeric" });
    dateFormatterCache.set(locale, fmt);
  }
  return fmt;
}

export function formatDateLocale(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return dateFormatter(locale).format(d);
}
