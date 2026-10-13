import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { LanguageSelector } from "@/components/app/LanguageSelector";

export default async function AuthLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations("Auth");
  return (
    <main className="paper-grain flex min-h-dvh flex-col items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-4 flex justify-end">
          <LanguageSelector />
        </div>
        <header className="mb-6 text-center">
          <div className="mx-auto mb-3 h-px w-24 border-t border-dashed border-rule" />
          <h1 className="font-display text-2xl font-bold tracking-tight text-ink">
            HOME<span className="text-stamp">SHARE</span>
          </h1>
          <p className="label-mono mt-1">{t("brandTagline")}</p>
        </header>
        {children}
        <p className="mt-6 text-center text-xs uppercase tracking-widest text-faint">
          ░ {t("footer")} ░
        </p>
      </div>
    </main>
  );
}
