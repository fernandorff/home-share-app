import { LANGUAGES } from "@/lib/client-preferences";

export type UiLocale = (typeof LANGUAGES)[number]["code"];

const CODES: readonly string[] = LANGUAGES.map((language) => language.code);

/** The `locale` preference cookie when it names a supported UI locale, else "en" (DEFAULT_LOCALE). */
export function localeFromCookie(cookieHeader: string): UiLocale {
  for (const part of cookieHeader.split(";")) {
    const [name, value] = part.trim().split("=");
    if (name === "locale" && value !== undefined && CODES.includes(value)) return value as UiLocale;
  }
  return "en";
}
