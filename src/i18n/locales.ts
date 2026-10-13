// The app's locales, framework-free: browser code and the push validators import this without pulling
// next-intl/server + next/headers (src/i18n/request.ts) into their graph. request.ts re-exports both names.
export const LOCALES = ["en", "pt", "es", "fr"] as const;
export type Locale = (typeof LOCALES)[number];
