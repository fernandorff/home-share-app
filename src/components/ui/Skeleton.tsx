import { cn } from "./cn";

/** A single shimmering placeholder bar. Size it with className (h-4 w-32 …). */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton h-4", className)} aria-hidden />;
}

/** Generic ledger-style skeleton rows for list loading states.
 *  `inset` pads the bars (px-4) to match a table's cell padding while the dashed rule
 *  still spans full width — so the placeholders don't touch the card borders. */
export function SkeletonRows({
  rows = 5,
  inset = false,
  className,
}: {
  rows?: number;
  inset?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col", className)} aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="border-b border-dashed border-rule last:border-0">
          <div className={cn("flex items-center gap-3 py-3.5", inset && "px-4")}>
            <Skeleton className="h-4 w-40 max-w-[40%]" />
            <Skeleton className="h-4 w-24 max-w-[20%]" />
            <Skeleton className="ml-auto h-4 w-20" />
          </div>
        </div>
      ))}
    </div>
  );
}
