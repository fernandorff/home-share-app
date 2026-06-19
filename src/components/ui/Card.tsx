import { cn } from "./cn";
import type { ReactNode } from "react";

export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("bg-card border border-rule rounded-md", className)}>
      {children}
    </div>
  );
}

/** Dotted receipt rule. */
export function ReceiptDivider({ className }: { className?: string }) {
  return <div className={cn("border-t border-dashed border-rule", className)} aria-hidden />;
}

/** Uppercase section heading with a trailing rule, like a ledger column header. */
export function SectionTitle({
  children,
  right,
  className,
}: {
  children: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <h2 className="font-display text-sm font-bold uppercase tracking-wider text-ink whitespace-nowrap">
        {children}
      </h2>
      <span className="flex-1 border-t border-dashed border-rule" aria-hidden />
      {right}
    </div>
  );
}
