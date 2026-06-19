"use client";

import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import { Menu, MenuItem } from "@/components/ui/Menu";

const LANGS = [
  { code: "en", label: "English" },
  { code: "pt", label: "Português" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
] as const;

export function LanguageSelector() {
  const locale = useLocale();
  const router = useRouter();

  function pick(code: string) {
    document.cookie = `locale=${code}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  }

  const current = LANGS.find((l) => l.code === locale) ?? LANGS[0];

  return (
    <Menu
      align="end"
      trigger={
        <button
          aria-label="Language"
          className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-card px-2 py-1.5 text-xs uppercase tracking-wide text-ink-soft transition-colors hover:bg-panel"
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
