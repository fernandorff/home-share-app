import { cn } from "./cn";
import type {
  InputHTMLAttributes,
  TextareaHTMLAttributes,
  SelectHTMLAttributes,
  ReactNode,
} from "react";

// 16px on mobile (text-base) — iOS Safari auto-zooms the page on focus for any input under 16px
// and doesn't zoom back out, breaking every form on the app. Back to the original 14px (text-sm)
// from `sm:` up, where zoom-on-focus isn't a factor and the denser desktop look is unaffected.
const fieldBase =
  "w-full bg-card text-ink rounded-md border border-rule px-3 py-2.5 text-base sm:text-sm " +
  "placeholder:text-faint outline-none transition-colors " +
  "focus:border-ink focus:ring-1 focus:ring-ink disabled:opacity-60";

export function Label({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="label-mono block mb-1.5">
      {children}
    </label>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label?: string;
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col">
      {label && <Label htmlFor={htmlFor}>{label}</Label>}
      {children}
      {error ? (
        // role=alert so a screen reader announces the validation error when it appears (a11y
        // WCAG 3.3.1 / 4.1.3 — the toasts already do this, form errors didn't).
        <p role="alert" className="mt-1.5 text-pretty text-xs text-debt">{error}</p>
      ) : hint ? (
        <p className="mt-1.5 text-pretty text-xs text-faint">{hint}</p>
      ) : null}
    </div>
  );
}

export function Input({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(fieldBase, className)} {...props} />;
}

export function Textarea({
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(fieldBase, "resize-y min-h-20", className)} {...props} />;
}

export function Select({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select
        className={cn(fieldBase, "appearance-none pr-9 cursor-pointer", className)}
        {...props}
      >
        {children}
      </select>
      <span
        aria-hidden
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-faint text-xs"
      >
        ▼
      </span>
    </div>
  );
}
