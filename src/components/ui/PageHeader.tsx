import type { ReactNode } from "react";

/** The one header every (app) page uses (D3): h1 title, subtitle below it (sentence case, no final
 *  period), optional actions on the right that wrap below the title when they don't fit. */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <h1 className="font-display text-2xl font-bold tracking-tight text-ink">{title}</h1>
        <p className="mt-1 text-pretty text-sm text-faint">{subtitle}</p>
      </div>
      {actions}
    </header>
  );
}
