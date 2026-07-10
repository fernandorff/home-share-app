"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/Menu";
import { THEMES, DEFAULT_THEME, THEME_COOKIE, isTheme, type Theme } from "@/lib/theme";
import { setClientCookie } from "@/lib/client-cookie";

const LANGS = [
  { code: "en", label: "English" },
  { code: "pt", label: "Português" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
] as const;

/** Applies the theme to the document outside React's reactive scope (DOM write + cookie). */
function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  setClientCookie(THEME_COOKIE, theme);
}

/** Header control consolidating theme + language pickers into a single "Settings" menu
 *  (previously two separate top-bar buttons). Logged-in area only — the public auth pages and
 *  onboarding keep their own standalone LanguageSelector. */
export function SettingsMenu() {
  const t = useTranslations("Theme");
  const tNav = useTranslations("Nav");
  const tc = useTranslations("Common");
  const locale = useLocale();
  const router = useRouter();
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);

  // Sync from the server-rendered attribute after hydration (avoids a mismatch).
  useEffect(() => {
    const current = document.documentElement.dataset.theme;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional external (DOM) → state sync after mount
    if (isTheme(current)) setTheme(current);
  }, []);

  function pickTheme(next: Theme) {
    applyTheme(next);
    setTheme(next);
  }

  function pickLocale(code: string) {
    setClientCookie("locale", code);
    router.refresh();
  }

  return (
    <Menu
      align="end"
      trigger={
        <button
          aria-label={tNav("settings")}
          // min-h-11: 44px floor on mobile touch (D3/BL-21 — was 32x28); sm:min-h-0 restores the
          // compact desktop size (mouse input).
          className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-rule bg-card px-2 py-1.5 text-xs uppercase tracking-wide text-ink-soft transition-colors hover:bg-panel sm:min-h-0"
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
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
          </svg>
        </button>
      }
    >
      <MenuLabel>{t("label")}</MenuLabel>
      {THEMES.map((th) => (
        <MenuItem key={th} onSelect={() => pickTheme(th)}>
          <span className="flex-1">{t(th)}</span>
          {th === theme && <span className="text-stamp">✓</span>}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuLabel>{tc("language")}</MenuLabel>
      {LANGS.map((l) => (
        <MenuItem key={l.code} onSelect={() => pickLocale(l.code)}>
          <span className="flex-1">{l.label}</span>
          {l.code === locale && <span className="text-stamp">✓</span>}
        </MenuItem>
      ))}
    </Menu>
  );
}
