import { cn } from "./cn";

type Tone = "stamp" | "credit" | "debt" | "ink";

const TONES: Record<Tone, string> = {
  stamp: "text-stamp border-stamp",
  credit: "text-credit border-credit",
  debt: "text-debt border-debt",
  ink: "text-ink border-ink",
};

/** Rotated rubber-stamp label — "PAID", "OWES", "TO RECEIVE". */
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

/** Tag dimension tones — color a chip by what it represents (category / platform / payment). */
export type TagTone = "default" | "category" | "platform" | "payment";

const TAG_TONES: Record<TagTone, string> = {
  default: "border-rule bg-panel text-ink-soft",
  category: "border-cat/50 bg-cat-soft text-cat",
  platform: "border-plat/50 bg-plat-soft text-plat",
  payment: "border-pay/50 bg-pay-soft text-pay",
};

/** Small inline tag (platform name, role, etc.) — no rotation. */
export function Tag({
  children,
  tone = "default",
  className,
}: {
  children: React.ReactNode;
  tone?: TagTone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-sm border px-2 py-0.5 text-[0.7rem] uppercase tracking-wide",
        TAG_TONES[tone],
        className
      )}
    >
      {children}
    </span>
  );
}
