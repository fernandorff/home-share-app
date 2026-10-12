"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { SectionTitle } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { ThemePreview } from "@/components/settings/ThemePreview";
import { LANGUAGES, applyLocalePreference, applyThemePreference } from "@/lib/client-preferences";
import { DEFAULT_THEME, THEMES, isTheme, type Theme } from "@/lib/theme";

const optionClass = (active: boolean) =>
  cn(
    "rounded-md border text-left text-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-paper",
    active ? "border-ink ring-1 ring-ink" : "border-rule hover:border-ink"
  );

/** Settings › Appearance (spec 011, criteria 3–5): a live preview card per theme — a click applies it to the whole app
 *  at once — and the language. Both are per-browser cookies, as before. */
export default function AppearanceSettingsPage() {
  const t = useTranslations("Settings");
  const tt = useTranslations("Theme");
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
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <SectionTitle>{t("theme")}</SectionTitle>
        <p className="text-pretty text-sm text-faint">{t("themeHint")}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {THEMES.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={theme === option}
              onClick={() => pickTheme(option)}
              className={cn(optionClass(theme === option), "flex flex-col gap-2 bg-card p-2")}
            >
              <ThemePreview theme={option} />
              <span className="flex min-h-8 items-center justify-between px-1 text-sm font-medium">
                {tt(option)}
                {theme === option && <span className="text-stamp-text" aria-hidden>✓</span>}
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle>{tc("language")}</SectionTitle>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {LANGUAGES.map((language) => (
            <button
              key={language.code}
              type="button"
              aria-pressed={locale === language.code}
              onClick={() => pickLocale(language.code)}
              className={cn(optionClass(locale === language.code), "flex min-h-11 items-center justify-between gap-2 bg-card px-3 text-sm")}
            >
              {language.label}
              {locale === language.code && <span className="text-stamp-text" aria-hidden>✓</span>}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
