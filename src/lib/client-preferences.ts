import { setClientCookie } from "@/lib/client-cookie";
import { THEME_COOKIE, type Theme } from "@/lib/theme";

export const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "pt", label: "Português" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
] as const;

export function applyThemePreference(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  setClientCookie(THEME_COOKIE, theme);
}

export function applyLocalePreference(locale: string) {
  setClientCookie("locale", locale);
}
