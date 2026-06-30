// Visual themes — swap token VALUES only (colors/fonts/radii), never layout.
// The active theme lives on `<html data-theme>`, applied server-side from a cookie.

export const THEMES = ["default", "bolitas"] as const;
export type Theme = (typeof THEMES)[number];

export const DEFAULT_THEME: Theme = "default";
export const THEME_COOKIE = "bolitas_theme";

export function isTheme(value: string | undefined | null): value is Theme {
  return !!value && (THEMES as readonly string[]).includes(value);
}
