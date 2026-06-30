"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Menu, MenuItem } from "@/components/ui/Menu";
import { THEMES, DEFAULT_THEME, THEME_COOKIE, isTheme, type Theme } from "@/lib/theme";

/** Header control to switch the visual theme. Applies instantly via the
 *  `<html data-theme>` attribute and persists in a cookie for SSR (no FOUC). */
export function ThemeSelector() {
  const t = useTranslations("Theme");
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);

  // Sync from the server-rendered attribute after hydration (avoids a mismatch).
  useEffect(() => {
    const current = document.documentElement.dataset.theme;
    if (isTheme(current)) setTheme(current);
  }, []);

  function pick(next: Theme) {
    document.documentElement.dataset.theme = next;
    document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    setTheme(next);
  }

  return (
    <Menu
      align="end"
      trigger={
        <button
          aria-label={t("label")}
          className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-card px-2 py-1.5 text-xs uppercase tracking-wide text-ink-soft transition-colors hover:bg-panel"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <circle cx="13.5" cy="6.5" r="1.5" />
            <circle cx="17.5" cy="10.5" r="1.5" />
            <circle cx="8.5" cy="7.5" r="1.5" />
            <circle cx="6.5" cy="12.5" r="1.5" />
            <path d="M12 2a10 10 0 1 0 0 20 2.5 2.5 0 0 0 2-4 2.5 2.5 0 0 1 2-4h2a4 4 0 0 0 4-4 10 10 0 0 0-12-8Z" />
          </svg>
        </button>
      }
    >
      {THEMES.map((th) => (
        <MenuItem key={th} onSelect={() => pick(th)}>
          <span className="flex-1">{t(th)}</span>
          {th === theme && <span className="text-stamp">✓</span>}
        </MenuItem>
      ))}
    </Menu>
  );
}
