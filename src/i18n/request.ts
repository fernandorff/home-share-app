import { getRequestConfig } from "next-intl/server";
import { cookies } from "next/headers";
import { LOCALES, type Locale } from "./locales";

// Defined in the framework-free ./locales (shared with browser code); re-exported for existing importers.
export { LOCALES, type Locale };
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "locale";

export default getRequestConfig(async () => {
  const store = await cookies();
  const cookieLocale = store.get(LOCALE_COOKIE)?.value;
  const locale: Locale = (LOCALES as readonly string[]).includes(cookieLocale ?? "")
    ? (cookieLocale as Locale)
    : DEFAULT_LOCALE;

  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
