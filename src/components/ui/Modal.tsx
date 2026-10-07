"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { cn } from "./cn";
import type { ReactNode } from "react";

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
  fallbackFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  /** Where focus goes on close when the element that opened the modal is gone (it unmounted meanwhile). */
  fallbackFocus?: () => HTMLElement | null;
}) {
  const tc = useTranslations("Common");
  // These modals are controlled (no Dialog.Trigger), so Radix has no trigger to restore focus to
  // on close and focus lands on <body> — a keyboard user gets dumped to the top (WCAG 2.4.3).
  // Capture whatever was focused when the modal opened and restore it in onCloseAutoFocus.
  const triggerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) triggerRef.current = document.activeElement as HTMLElement | null;
  }, [open]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        {/* Same z-50 as Dialog.Content: all overlay/content pairs then stack purely by portal
            (DOM) order, so a confirmation dialog opened on top of this one dims this one too. */}
        <Dialog.Overlay className="anim-overlay fixed inset-0 z-50 bg-ink/40 backdrop-blur-[1px]" />
        <Dialog.Content
          aria-modal
          onCloseAutoFocus={(e) => {
            const el = triggerRef.current;
            const target = el && el.isConnected && typeof el.focus === "function" ? el : fallbackFocus?.();
            if (target) {
              e.preventDefault();
              target.focus();
            }
          }}
          // With a description present, let Radix auto-wire aria-describedby to <Dialog.Description>;
          // only suppress the "missing description" warning (undefined attr) when there is none.
          {...(description ? {} : { "aria-describedby": undefined })}
          className={cn(
            "anim-sheet fixed z-50 flex flex-col bg-card border border-ink",
            // R3-13 / R3-06: anchored 4.5rem from the top, not centered — a centered dialog jumped
            // (title up, buttons down) whenever an error or a result grew its body, and the tallest one
            // (expense form) started at y≈37, under the top toast (16-62px) dialogs move toasts to.
            // Below sm the bottom sheet stops 4.5rem short of the top for the same toast.
            "inset-x-0 bottom-0 max-h-[calc(100dvh-4.5rem)] rounded-t-lg",
            "sm:inset-auto sm:left-1/2 sm:top-[4.5rem] sm:bottom-auto sm:-translate-x-1/2 sm:max-h-[calc(100dvh-6rem)]",
            "sm:w-[calc(100vw-2rem)] sm:max-w-md sm:rounded-md",
            "shadow-[4px_4px_0_rgba(22,20,15,0.18)]",
            className
          )}
        >
          <div className="flex shrink-0 items-start justify-between gap-4 border-b border-dashed border-rule p-4">
            <div className="min-w-0">
              <Dialog.Title className="font-display text-base font-bold uppercase tracking-wide text-ink">
                {title}
              </Dialog.Title>
              {description && (
                <Dialog.Description className="mt-1 text-sm text-faint">
                  {description}
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close
              aria-label={tc("close")}
              /* Fixed 44x44 hit area (D3/BL-21) hugging the header's top-right corner via a small
                 negative margin, with the focus ring drawn inset so it stays inside the header
                 instead of hugging the sheet's outer corner (A9). */
              className="-mr-2 -mt-2 grid h-11 w-11 shrink-0 place-items-center rounded-md text-lg leading-none text-faint transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink"
            >
              ✕
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4 [overflow-wrap:anywhere]">{children}</div>

          {footer && (
            <div className="flex shrink-0 justify-end gap-2 border-t border-dashed border-rule p-4">
              {footer}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
