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

/** Currency input mask working in cents: "12345" → "123,45". */
export function maskAmountInput(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  const cents = parseInt(digits, 10);
  return (cents / 100).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Parse a masked "1.234,56" back to a number 1234.56. */
export function parseAmountInput(masked: string): number {
  const cleaned = masked.replace(/\./g, "").replace(",", ".");
  return parseFloat(cleaned) || 0;
}
