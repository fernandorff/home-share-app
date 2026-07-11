"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { MenuSub, MenuLabel, MenuSeparator, MenuRadioGroup, MenuRadioItem } from "@/components/ui/Menu";
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

/** Theme + language pickers, as a "Settings" item that expands into its own submenu inside the
 *  user (avatar) menu — not a standalone top-bar trigger. Logged-in area only — the public auth
 *  pages and onboarding keep their own standalone LanguageSelector. */
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
    <MenuSub label={tNav("settings")}>
      <MenuLabel>{t("label")}</MenuLabel>
      <MenuRadioGroup value={theme}>
        {THEMES.map((th) => (
          <MenuRadioItem key={th} value={th} onSelect={() => pickTheme(th)}>
            {t(th)}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
      <MenuSeparator />
      <MenuLabel>{tc("language")}</MenuLabel>
      <MenuRadioGroup value={locale}>
        {LANGS.map((l) => (
          <MenuRadioItem key={l.code} value={l.code} onSelect={() => pickLocale(l.code)}>
            {l.label}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </MenuSub>
  );
}
