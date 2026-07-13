"use client";

import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { setClientCookie } from "@/lib/client-cookie";

const LANGS = [
  { code: "en", label: "English" },
  { code: "pt", label: "Português" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
] as const;

/**
 * The public auth pages use a native select instead of the app-wide Radix menu. Besides being
 * keyboard/screen-reader friendly out of the box, this keeps the dropdown runtime out of the
 * first unauthenticated visit, where the language picker only needs four static options.
 */
export function AuthLanguageSelector() {
  const locale = useLocale();
  const tc = useTranslations("Common");
  const router = useRouter();

  function pick(code: string) {
    setClientCookie("locale", code);
    router.refresh();
  }

  return (
    <label className="relative inline-flex min-h-11 items-center rounded-md border border-rule bg-card text-xs uppercase tracking-wide text-ink-soft transition-colors hover:bg-panel md:min-h-0">
      <span className="sr-only">{tc("language")}</span>
      <svg
        className="pointer-events-none absolute left-2"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c2.6 2.6 2.6 15.4 0 18M12 3c-2.6 2.6-2.6 15.4 0 18" />
      </svg>
      <select
        aria-label={tc("language")}
        value={LANGS.some((language) => language.code === locale) ? locale : "en"}
        onChange={(event) => pick(event.target.value)}
        className="min-h-11 cursor-pointer appearance-none bg-transparent py-1.5 pl-7 pr-7 text-xs uppercase tracking-wide outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-paper md:min-h-0"
      >
        {LANGS.map((language) => (
          <option key={language.code} value={language.code}>
            {language.label}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-2 text-[0.6rem]" aria-hidden="true">
        ▾
      </span>
    </label>
  );
}
