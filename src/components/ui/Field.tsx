import { cloneElement, isValidElement, useId } from "react";
import { cn } from "./cn";
import type {
  InputHTMLAttributes,
  TextareaHTMLAttributes,
  SelectHTMLAttributes,
  ReactNode,
  ReactElement,
} from "react";

// 16px on mobile (text-base) — iOS Safari auto-zooms the page on focus for any input under 16px
// and doesn't zoom back out, breaking every form on the app. Back to the original 14px (text-sm)
// from `sm:` up, where zoom-on-focus isn't a factor and the denser desktop look is unaffected.
// aria-invalid: variants (U11): a field with an error gets the debt border, also while focused
// (the focus pair is more specific than focus:border-ink, so it wins without tailwind-merge).
const fieldBase =
  "w-full bg-card text-ink rounded-md border border-rule px-3 py-2.5 text-base sm:text-sm " +
  "placeholder:text-faint outline-none transition-colors " +
  "focus:border-ink focus:ring-1 focus:ring-ink disabled:opacity-60 " +
  "aria-invalid:border-debt aria-invalid:focus:border-debt aria-invalid:focus:ring-debt";

export function Label({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  // text-pretty (R2-30): no single-word last line ("MOT DE / PASSE" in fr).
  return (
    <label htmlFor={htmlFor} className="label-mono block mb-1.5 text-pretty">
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
  label?: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
}) {
  // Wire the hint/error text to the control via aria-describedby so a screen reader reads it when
  // the field is focused (a11y WCAG 3.3.2). With an error the control is also marked aria-invalid
  // (U11) — announced as invalid and painted with fieldBase's debt border. cloneElement injects both
  // onto the single input child; if a caller passes something exotic, it just isn't described (no crash).
  const msgId = useId();
  const described = (error || hint) ? msgId : undefined;
  const control =
    described && isValidElement(children)
      ? cloneElement(children as ReactElement<{ "aria-describedby"?: string; "aria-invalid"?: boolean }>, {
          "aria-describedby": described,
          ...(error ? { "aria-invalid": true } : {}),
        })
      : children;
  return (
    <div className="flex flex-col">
      {label && <Label htmlFor={htmlFor}>{label}</Label>}
      {control}
      {error ? (
        // role=alert so a screen reader announces the validation error when it appears (a11y
        // WCAG 3.3.1 / 4.1.3 — the toasts already do this, form errors didn't).
        <p id={msgId} role="alert" className="mt-1.5 text-pretty text-xs text-debt">{error}</p>
      ) : hint ? (
        <p id={msgId} className="mt-1.5 text-pretty text-xs text-faint">{hint}</p>
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
      {/* D4: the same small ▾ as the custom menus (MultiSelect, header switchers). */}
      <span
        aria-hidden
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-faint"
      >
        ▾
      </span>
    </div>
  );
}
