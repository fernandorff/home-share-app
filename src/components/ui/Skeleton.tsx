import { cn } from "./cn";

/** A single shimmering placeholder bar. Size it with className (h-4 w-32 …). */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton h-4", className)} aria-hidden />;
}

/** Generic ledger-style skeleton rows for list loading states. */
export function SkeletonRows({
  rows = 5,
  className,
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col", className)} aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 border-b border-dashed border-rule py-3.5 last:border-0"
        >
          <Skeleton className="h-4 w-40 max-w-[40%]" />
          <Skeleton className="h-4 w-24 max-w-[20%]" />
          <Skeleton className="ml-auto h-4 w-20" />
        </div>
      ))}
    </div>
  );
}
