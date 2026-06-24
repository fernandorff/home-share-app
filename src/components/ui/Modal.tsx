"use client";

import * as Dialog from "@radix-ui/react-dialog";
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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="anim-overlay fixed inset-0 z-40 bg-ink/40 backdrop-blur-[1px]" />
        <Dialog.Content
          aria-describedby={description ? undefined : undefined}
          className={cn(
            "anim-sheet fixed z-50 flex flex-col bg-card border border-ink",
            "inset-x-0 bottom-0 max-h-[92dvh] rounded-t-lg",
            "sm:inset-auto sm:left-1/2 sm:top-1/2 sm:bottom-auto sm:-translate-x-1/2 sm:-translate-y-1/2",
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
              aria-label="Fechar"
              className="shrink-0 text-lg leading-none text-faint transition-colors hover:text-ink"
            >
              ✕
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>

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
