"use client";

import { useTranslations } from "next-intl";
import { Money } from "@/components/ui/Money";
import type { Theme } from "@/lib/theme";

/** A miniature of the app drawn with `theme`'s own tokens (spec 011, criterion 3): the `data-theme` wrapper re-points
 *  every token utility below, so the preview of a theme that is not active still shows its real colors, fonts and
 *  radii. Decorative — the card around it carries the name and the pressed state. */
export function ThemePreview({ theme }: { theme: Theme }) {
  const t = useTranslations("Settings.preview");

  return (
    <div data-theme={theme} aria-hidden className="pointer-events-none overflow-hidden rounded-md border border-rule bg-paper font-mono text-ink">
      <div className="flex items-center justify-between border-b border-rule px-3 py-2">
        <span className="font-display text-xs font-bold tracking-tight">
          HOME<span className="text-stamp">SHARE</span>
        </span>
        <span className="h-3 w-3 rounded-full bg-stamp" />
      </div>
      <div className="flex flex-col gap-2 p-3">
        <div className="rounded-md border border-rule bg-card text-xs">
          <div className="flex items-center justify-between gap-2 px-2.5 py-1.5">
            <span className="truncate">{t("groceries")}</span>
            <Money value={182.4} />
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-dotted border-rule px-2.5 py-1.5">
            <span className="truncate">{t("power")}</span>
            <Money value={96} />
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 rounded-md bg-panel px-2.5 py-1.5 text-xs">
          <span className="truncate text-ink-soft">{t("owed")}</span>
          <Money value={45.6} signed />
        </div>
      </div>
    </div>
  );
}
