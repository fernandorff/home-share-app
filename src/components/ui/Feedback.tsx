import { cn } from "./cn";

/** Blinking monospace cursor — the retro "working…" indicator. */
export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block w-[0.6em] h-[1em] bg-current animate-pulse align-middle", className)}
    />
  );
}

export function EmptyState({
  title,
  hint,
  icon = "—",
  action,
}: {
  title: string;
  hint?: string;
  icon?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <div className="font-display text-3xl text-rule select-none" aria-hidden>
        {icon}
      </div>
      <p className="font-display text-base text-ink">{title}</p>
      {hint && <p className="max-w-xs text-sm text-faint">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
