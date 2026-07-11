"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { cn } from "./cn";
import type { ReactNode } from "react";

export function Menu({
  trigger,
  children,
  align = "end",
}: {
  trigger: ReactNode;
  children: ReactNode;
  align?: "start" | "center" | "end";
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align={align}
          sideOffset={6}
          collisionPadding={8}
          className="anim-pop z-50 min-w-44 max-w-[calc(100vw-1rem)] rounded-md border border-ink bg-card p-1 shadow-[3px_3px_0_rgba(22,20,15,0.14)] sm:min-w-48"
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
        "flex min-w-0 cursor-pointer items-center gap-2 rounded-sm px-3 py-2 text-sm outline-none",
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

export function MenuSeparator() {
  return <DropdownMenu.Separator className="my-1 border-t border-dashed border-rule" />;
}

/** A menu item that expands into its own nested menu (e.g. "Settings" inside the user menu),
 *  instead of being a standalone top-level trigger. Must be rendered inside a <Menu>. */
export function MenuSub({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger
        className={cn(
          "flex cursor-pointer items-center justify-between gap-2 rounded-sm px-3 py-2 text-sm text-ink outline-none",
          "data-[highlighted]:bg-panel data-[state=open]:bg-panel"
        )}
      >
        <span>{label}</span>
        <span className="text-faint" aria-hidden>▸</span>
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent
          sideOffset={4}
          alignOffset={-4}
          collisionPadding={8}
          className="anim-pop z-50 min-w-44 max-w-[calc(100vw-1rem)] rounded-md border border-ink bg-card p-1 shadow-[3px_3px_0_rgba(22,20,15,0.14)] sm:min-w-48"
        >
          {children}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}
