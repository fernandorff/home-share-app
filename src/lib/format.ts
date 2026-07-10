import { formatCurrency, toNumber } from "@/lib/currency";
import type { Money } from "@/lib/types";

/** Coerce any money value (number | string | Decimal-like) to a plain number. */
export function money(value: Money): number {
  return toNumber(value);
}

/** "R$ 1.234,56" (non-breaking space after R$ so it never wraps). */
export function formatBRL(value: Money): string {
  return `R$ ${formatCurrency(toNumber(value))}`;
}

/** "1.234,56" — no currency symbol (for tight ledger columns). */
export function formatAmount(value: Money): string {
  return formatCurrency(toNumber(value));
}

/** Signed money for balances: "+R$ 66,67" / "−R$ 66,67". */
export function formatSigned(value: Money): string {
  const n = toNumber(value);
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${formatBRL(Math.abs(n))}`;
}

/** ISO date → "dd/mm/aaaa" in local time (dates are stored at local noon). */
export function formatDateBR(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/** ISO (or now) → "aaaa-mm-dd" for <input type="date">. */
export function toDateInputValue(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function todayInputValue(): string {
  return toDateInputValue();
}

/** The grouping + decimal separators a locale uses for plain numbers. */
function localeSeparators(locale: string): { group: string; decimal: string } {
  const parts = new Intl.NumberFormat(locale).formatToParts(11111.11);
  return {
    group: parts.find((p) => p.type === "group")?.value ?? ",",
    decimal: parts.find((p) => p.type === "decimal")?.value ?? ".",
  };
}

// 10 raw digits = max 9,999,999,999 cents = R$99,999,999.99 — matches the server's
// AMOUNT_TOO_HIGH ceiling (toCents(amount) > 9_999_999_999 is rejected) exactly.
const MAX_AMOUNT_DIGITS = 10;

/** Currency input mask working in cents, formatted for `locale`. "12345" → "123.45"/"123,45". */
export function maskAmountInput(raw: string, locale = "pt-BR"): string {
  const digits = raw.replace(/\D/g, "").slice(0, MAX_AMOUNT_DIGITS);
  if (!digits) return "";
  const cents = parseInt(digits, 10);
  return (cents / 100).toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Parse a locale-formatted masked amount back to a number (e.g. en "1,234.56" → 1234.56). */
export function parseAmountInput(masked: string, locale = "pt-BR"): number {
  const { group, decimal } = localeSeparators(locale);
  const cleaned = masked
    .split(group)
    .join("")
    .split(decimal)
    .join(".")
    .replace(/[^\d.-]/g, "");
  return parseFloat(cleaned) || 0;
}
