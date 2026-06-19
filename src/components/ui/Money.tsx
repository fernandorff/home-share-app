"use client";

import { useLocale } from "next-intl";
import { cn } from "./cn";
import { useSession } from "@/lib/session";
import { money } from "@/lib/format";
import { formatMoney, formatMoneySigned } from "@/lib/money";
import { DEFAULT_CURRENCY } from "@/lib/currencies";
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
  const locale = useLocale();
  const { activeGroup } = useSession();
  const currency = activeGroup?.currency ?? DEFAULT_CURRENCY;

  const n = money(value);
  const tone = signed ? (n > 0 ? "text-credit" : n < 0 ? "text-debt" : "text-ink") : "text-ink";

  return (
    <span className={cn("tnum tabular-nums whitespace-nowrap", tone, className)}>
      {signed
        ? formatMoneySigned(value, currency, locale)
        : formatMoney(value, currency, locale)}
    </span>
  );
}
