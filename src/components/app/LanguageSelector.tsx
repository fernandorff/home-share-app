"use client";

import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Menu, MenuItem } from "@/components/ui/Menu";
import { setClientCookie } from "@/lib/client-cookie";

const LANGS = [
  { code: "en", label: "English" },
  { code: "pt", label: "Português" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
] as const;

/** Cookie write outside React's reactive scope (next-intl reads `locale` server-side). */
function setLocaleCookie(code: string) {
  setClientCookie("locale", code);
}

export function LanguageSelector() {
  const locale = useLocale();
  const tc = useTranslations("Common");
  const router = useRouter();

  function pick(code: string) {
    setLocaleCookie(code);
    router.refresh();
  }

  const current = LANGS.find((l) => l.code === locale) ?? LANGS[0];

  return (
    <Menu
      align="end"
      trigger={
        <button
          aria-label={tc("language")}
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
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18M12 3c2.6 2.6 2.6 15.4 0 18M12 3c-2.6 2.6-2.6 15.4 0 18" />
          </svg>
          {current.code.toUpperCase()}
        </button>
      }
    >
      {LANGS.map((l) => (
        <MenuItem key={l.code} onSelect={() => pick(l.code)}>
          <span className="flex-1">{l.label}</span>
          {l.code === locale && <span className="text-stamp">✓</span>}
        </MenuItem>
      ))}
    </Menu>
  );
}
