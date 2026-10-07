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

/** A group of mutually-exclusive choices (e.g. theme, language) — `role=menuitemradio` with a real
 *  aria-checked, so a screen reader announces which option is selected (a11y). `value` is the
 *  currently-selected option. */
export function MenuRadioGroup({ value, label, children }: { value: string; label?: string; children: ReactNode }) {
  return <DropdownMenu.RadioGroup value={value} aria-label={label}>{children}</DropdownMenu.RadioGroup>;
}

export function MenuRadioItem({
  value,
  onSelect,
  children,
}: {
  value: string;
  onSelect?: () => void;
  children: ReactNode;
}) {
  return (
    <DropdownMenu.RadioItem
      value={value}
      onSelect={onSelect}
      className={cn(
        "flex min-h-11 min-w-0 cursor-pointer items-center gap-2 rounded-sm px-3 py-2 text-sm text-ink outline-none md:min-h-0",
        "data-[highlighted]:bg-panel"
      )}
    >
      <span className="min-w-0 flex-1">{children}</span>
      <DropdownMenu.ItemIndicator>
        <span className="text-stamp-text">✓</span>
      </DropdownMenu.ItemIndicator>
    </DropdownMenu.RadioItem>
  );
}

export function MenuSeparator({ className }: { className?: string } = {}) {
  return <DropdownMenu.Separator className={cn("my-1 border-t border-dashed border-rule", className)} />;
}
