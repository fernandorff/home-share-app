import { toNumber } from "@/lib/currency";
import type { Money } from "@/lib/types";

// Building an Intl.NumberFormat is one of the most expensive things in a hot path, and
// <Money> renders hundreds of times per screen. Cache one formatter per locale|currency.
const formatterCache = new Map<string, Intl.NumberFormat>();

function currencyFormatter(currency: string, locale: string): Intl.NumberFormat {
  const key = `${locale}|${currency}`;
  let fmt = formatterCache.get(key);
  if (!fmt) {
    // useGrouping "always" (I7): es/pt CLDR data skips the separator for 4-digit numbers (es
    // "1234,56"); money always shows it ("1.234,56") so amounts line up and read the same everywhere.
    fmt = new Intl.NumberFormat(locale, { style: "currency", currency, useGrouping: "always" });
    // Some locales have no symbol for a currency and fall back to its ISO code (es → "8015,43 BRL"
    // / "GBP"). Only then switch to the narrow symbol ("R$" / "£"); blindly using narrowSymbol would
    // also flatten the disambiguating symbols other locales do have ("US$" in pt, "$US" in fr).
    const showsIsoCode = fmt.formatToParts(0).some((p) => p.type === "currency" && p.value === currency);
    if (showsIsoCode) {
      fmt = new Intl.NumberFormat(locale, { style: "currency", currency, currencyDisplay: "narrowSymbol", useGrouping: "always" });
    }
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

// DD/MM/YYYY everywhere, regardless of the viewer's UI language — same rationale as the house's
// currency (lib/currency) not following the viewer's locale: this app's dates, CSV export and
// filter chips already assumed DD/MM, so an English UI silently flipping the on-screen table to
// MM/DD (Intl's default English order) created a real inconsistency (BL-18/B3) — e.g. editing an
// exported CSV in Excel with the wrong day/month order. `en-GB` is just a stable way to ask Intl
// for day-month-year without hand-rolling the string; it has nothing to do with the UI language.
const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(): Intl.DateTimeFormat {
  const key = "dd-mm-yyyy";
  let fmt = dateFormatterCache.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
    dateFormatterCache.set(key, fmt);
  }
  return fmt;
}

export function formatDateLocale(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return dateFormatter().format(d);
}

/** "dd/mm/yyyy HH:mm" on the 24h clock in every UI language (I11) — expense history and Activity.
 *  Same fixed day-month order as formatDateLocale; the clock is the viewer's local time. */
export function formatDateTimeLocale(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${dateFormatter().format(d)} ${hh}:${mm}`;
}
