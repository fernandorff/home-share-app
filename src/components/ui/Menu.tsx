"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { cn } from "./cn";
import { cloneElement } from "react";
import type { ReactElement, ReactNode } from "react";
import { useTouchSafeDropdown } from "./useTouchSafeDropdown";

export function Menu({
  trigger,
  children,
  align = "end",
}: {
  trigger: ReactElement;
  children: ReactNode;
  align?: "start" | "center" | "end";
}) {
  const dropdown = useTouchSafeDropdown();

  return (
    <DropdownMenu.Root open={dropdown.open} onOpenChange={dropdown.onOpenChange}>
      <DropdownMenu.Trigger asChild>
        {cloneElement(trigger, dropdown.triggerProps)}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align={align}
          sideOffset={6}
          collisionPadding={8}
          className="anim-pop z-50 min-w-44 max-w-[calc(100vw-1rem)] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto overscroll-contain rounded-md border border-ink bg-card p-1 shadow-[3px_3px_0_rgba(22,20,15,0.14)] sm:min-w-48"
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function MenuItem({
  children,
  onSelect,
  danger = false,
  className,
}: {
  children: ReactNode;
  onSelect?: () => void;
  danger?: boolean;
  className?: string;
}) {
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className={cn(
        // min-w-0 lets a truncate child (e.g. a long house name in the switcher) actually shrink
        // and ellipsize instead of forcing the whole menu wider than the viewport (mobile QA #47).
        // R2-07: 44px rows on touch (were 36px); compact again from md.
        "flex min-h-11 min-w-0 cursor-pointer items-center gap-2 rounded-sm px-3 py-2 text-sm outline-none md:min-h-0",
        "data-[highlighted]:bg-panel",
        danger ? "text-debt" : "text-ink",
        className
      )}
    >
      {children}
    </DropdownMenu.Item>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <DropdownMenu.Label className="label-mono px-3 py-1.5">{children}</DropdownMenu.Label>;
}

export function MenuSeparator({ className }: { className?: string } = {}) {
  return <DropdownMenu.Separator className={cn("my-1 border-t border-dashed border-rule", className)} />;
}
