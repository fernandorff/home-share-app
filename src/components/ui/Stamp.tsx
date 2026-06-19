import { cn } from "./cn";

type Tone = "stamp" | "credit" | "debt" | "ink";

const TONES: Record<Tone, string> = {
  stamp: "text-stamp border-stamp",
  credit: "text-credit border-credit",
  debt: "text-debt border-debt",
  ink: "text-ink border-ink",
};

/** Rotated rubber-stamp label — "PAGO", "DEVE", "A RECEBER". */
export function Stamp({
  children,
  tone = "stamp",
  className,
}: {
  children: React.ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-block -rotate-6 select-none rounded-sm border-2 px-2 py-0.5 font-display text-[0.7rem] font-bold uppercase tracking-widest",
        TONES[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

/** Small inline tag (platform name, role, etc.) — no rotation. */
export function Tag({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm border border-rule bg-panel px-2 py-0.5 text-[0.7rem] uppercase tracking-wide text-ink-soft",
        className
      )}
    >
      {children}
    </span>
  );
}
