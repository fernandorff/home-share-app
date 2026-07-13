import { cn } from "./cn";
import { Spinner } from "./Feedback";
import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-ink text-paper border-ink hover:bg-stamp hover:border-stamp",
  secondary: "bg-card text-ink border-ink hover:bg-panel",
  ghost: "bg-transparent text-ink-soft border-transparent hover:bg-panel hover:text-ink",
  danger: "bg-stamp-text text-paper border-stamp-text hover:brightness-110",
};

const SIZES: Record<Size, string> = {
  // The app shell stays in touch/mobile mode through 767px, so density switches at the same `md`
  // breakpoint instead of mixing compact desktop buttons into the small-tablet layout.
  sm: "text-[0.7rem] px-3 py-1.5 gap-1.5 min-h-11 md:min-h-0",
  md: "text-[0.8rem] px-4 py-2.5 gap-2 min-h-11 md:min-h-0",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  className,
  children,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center justify-center rounded-md border font-display font-bold uppercase tracking-wider transition-all",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-paper",
        "disabled:opacity-50 disabled:pointer-events-none select-none",
        VARIANTS[variant],
        SIZES[size],
        className
      )}
    >
      {loading && <Spinner className="mr-2" />}
      {children}
    </button>
  );
}
