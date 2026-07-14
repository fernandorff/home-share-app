"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useMemo, useState } from "react";
import { cn } from "./cn";
import { Spinner } from "./Feedback";
import type { TagTone } from "./Stamp";

const TONE_DOT: Record<TagTone, string> = {
  default: "bg-ink",
  category: "bg-cat",
  platform: "bg-plat",
  payment: "bg-pay",
};

export function MultiSelect({
  options,
  selected,
  onToggle,
  placeholder,
  searchPlaceholder,
  createLabel,
  onCreate,
  tone = "default",
}: {
  options: { value: string; label: string }[];
  selected: Set<string>;
  onToggle: (value: string) => void;
  placeholder: string;
  searchPlaceholder: string;
  createLabel: (name: string) => string;
  onCreate: (name: string) => Promise<void>;
  tone?: TagTone;
}) {
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const labels = options.filter((option) => selected.has(option.value)).map((option) => option.label);
  const summary = labels.length === 0
    ? placeholder
    : labels.length <= 2
      ? labels.join(", ")
      : `${labels.slice(0, 2).join(", ")} +${labels.length - 2}`;
  const normalized = query.trim().toLocaleLowerCase();
  const filtered = useMemo(
    () => options.filter((option) => !normalized || option.label.toLocaleLowerCase().includes(normalized)),
    [normalized, options]
  );
  const canCreate = Boolean(normalized) && !options.some(
    (option) => option.label.trim().toLocaleLowerCase() === normalized
  );

  const create = async () => {
    const name = query.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      await onCreate(name);
      setQuery("");
    } catch {
      // The parent owns the localized error toast; keep the menu open so the name can be retried.
    } finally {
      setCreating(false);
    }
  };

  return (
    <DropdownMenu.Root onOpenChange={(open) => !open && setQuery("")}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="flex min-h-11 w-full items-center gap-2 rounded-md border border-rule bg-card px-3 text-left text-sm text-ink transition-colors hover:border-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
        >
          <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", TONE_DOT[tone])} aria-hidden />
          <span className={cn("min-w-0 flex-1 truncate", labels.length === 0 && "text-faint")}>{summary}</span>
          {labels.length > 0 && <span className="label-mono shrink-0">{labels.length}</span>}
          <span className="shrink-0 text-faint" aria-hidden>▾</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="anim-pop z-[60] w-[var(--radix-dropdown-menu-trigger-width)] min-w-64 max-w-[calc(100vw-1rem)] rounded-md border border-ink bg-card p-1 shadow-[3px_3px_0_rgba(22,20,15,0.14)]"
        >
          <div className="p-1">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => event.stopPropagation()}
              placeholder={searchPlaceholder}
              className="min-h-11 w-full rounded-sm border border-rule bg-paper px-3 text-sm text-ink outline-none placeholder:text-faint focus:border-ink"
              autoComplete="off"
            />
          </div>
          <div className="max-h-56 overflow-y-auto">
            {filtered.map((option) => (
              <DropdownMenu.CheckboxItem
                key={option.value}
                checked={selected.has(option.value)}
                onCheckedChange={() => onToggle(option.value)}
                onSelect={(event) => event.preventDefault()}
                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-sm px-3 py-2 text-sm text-ink outline-none data-[highlighted]:bg-panel"
              >
                <span className="grid h-5 w-5 shrink-0 place-items-center rounded-sm border border-rule">
                  <DropdownMenu.ItemIndicator>✓</DropdownMenu.ItemIndicator>
                </span>
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
              </DropdownMenu.CheckboxItem>
            ))}
          </div>
          {canCreate && (
            <>
              <DropdownMenu.Separator className="my-1 border-t border-dashed border-rule" />
              <DropdownMenu.Item
                disabled={creating}
                onSelect={(event) => {
                  event.preventDefault();
                  void create();
                }}
                className="flex min-h-11 cursor-pointer items-center gap-2 rounded-sm px-3 py-2 text-sm font-semibold text-ink outline-none data-[highlighted]:bg-panel data-[disabled]:opacity-50"
              >
                {creating ? <Spinner /> : <span aria-hidden>＋</span>}
                <span className="min-w-0 truncate">{createLabel(query.trim())}</span>
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
