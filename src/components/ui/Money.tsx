import { cn } from "./cn";
import { formatBRL, formatSigned, money } from "@/lib/format";
import type { Money as MoneyValue } from "@/lib/types";

export function Money({
  value,
  signed = false,
  className,
}: {
  value: MoneyValue;
  signed?: boolean;
  className?: string;
}) {
  const n = money(value);
  const tone = signed ? (n > 0 ? "text-credit" : n < 0 ? "text-debt" : "text-ink") : "text-ink";
  return (
    <span className={cn("tnum tabular-nums whitespace-nowrap", tone, className)}>
      {signed ? formatSigned(value) : formatBRL(value)}
    </span>
  );
}
