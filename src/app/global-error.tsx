"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect, useState } from "react";
import { globalErrorCopy, type GlobalErrorMessages } from "@/lib/global-error-copy";
import { localeFromCookie, type UiLocale } from "@/lib/locale-cookie";
import "./globals.css";

// global-error replaces the root layout, so there is no NextIntlClientProvider here: it loads only the
// visitor's locale file, lazily — one chunk per locale, fetched only after the app has crashed. Until
// (or unless) that chunk arrives, the screen shows the bundled English copy, so it is never blank.
const MESSAGES: Record<UiLocale, () => Promise<{ default: { GlobalError: GlobalErrorMessages } }>> = {
  en: () => import("@/messages/en.json"),
  pt: () => import("@/messages/pt.json"),
  es: () => import("@/messages/es.json"),
  fr: () => import("@/messages/fr.json"),
};

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  const [screen, setScreen] = useState<{ locale: UiLocale; text: GlobalErrorMessages } | null>(null);
  const copy = globalErrorCopy(screen?.text);

  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  useEffect(() => {
    let active = true;
    const locale = localeFromCookie(document.cookie);
    MESSAGES[locale]()
      .then((messages) => {
        if (active) setScreen({ locale, text: messages.default.GlobalError });
      })
      .catch(() => {
        // keep the English fallback
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <html lang={screen?.locale ?? "en"}>
      <body className="antialiased">
        <main className="paper-grain flex min-h-dvh flex-col items-center justify-center px-4 py-10 text-center">
          <div className="w-full max-w-sm">
            <p className="font-display text-2xl font-bold tracking-tight text-ink">
              HOME<span className="text-stamp">SHARE</span>
            </p>
            <h1 className="mt-8 font-display text-lg font-bold uppercase tracking-wide text-ink">{copy.title}</h1>
            <p className="mt-2 text-sm text-ink-soft">{copy.description}</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-8 inline-flex min-h-11 items-center justify-center rounded-md border border-ink bg-ink px-4 py-2.5 font-display text-[0.8rem] font-bold uppercase tracking-wider text-paper transition-all hover:bg-stamp-text hover:border-stamp-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-paper md:min-h-0"
            >
              {copy.reload}
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
