"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { MenuLabel, MenuSeparator, MenuRadioGroup, MenuRadioItem } from "@/components/ui/Menu";
import { THEMES, DEFAULT_THEME, isTheme, type Theme } from "@/lib/theme";
import { LANGUAGES, applyLocalePreference, applyThemePreference } from "@/lib/client-preferences";

/** Theme + language pickers as two labelled sections inside the user (avatar) menu. R3-31: they were
 *  a "Settings ▸" submenu that always opened to the LEFT (the menu sits at the right edge), against
 *  its own arrow and above its row. Logged-in area only — the public auth pages and onboarding keep
 *  their own standalone LanguageSelector. */
export function SettingsMenu() {
  const t = useTranslations("Theme");
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
    applyThemePreference(next);
    setTheme(next);
  }

  function pickLocale(code: string) {
    applyLocalePreference(code);
    router.refresh();
  }

  return (
    <>
      <MenuLabel>{t("label")}</MenuLabel>
      <MenuRadioGroup value={theme} label={t("label")}>
        {THEMES.map((th) => (
          <MenuRadioItem key={th} value={th} onSelect={() => pickTheme(th)}>
            {t(th)}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
      <MenuSeparator />
      <MenuLabel>{tc("language")}</MenuLabel>
      <MenuRadioGroup value={locale} label={tc("language")}>
        {LANGUAGES.map((l) => (
          <MenuRadioItem key={l.code} value={l.code} onSelect={() => pickLocale(l.code)}>
            {l.label}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </>
  );
}
