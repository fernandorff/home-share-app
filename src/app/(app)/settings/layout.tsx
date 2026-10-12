"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { cn } from "@/components/ui/cn";
import { PageHeader } from "@/components/ui/PageHeader";

const CATEGORIES = ["appearance", "notifications", "account", "security"] as const;

/** Settings (spec 011): the category list on the left from md; below md, /settings is the list and each category
 *  shows alone with a back link (CSS only — the server cannot know the viewport). */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations("Settings");
  const pathname = usePathname();
  const isIndex = pathname === "/settings";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <div className="grid gap-6 md:grid-cols-[13rem_minmax(0,1fr)]">
        <nav aria-label={t("title")} className={isIndex ? "" : "hidden md:block"}>
          <ul className="flex flex-col gap-1">
            {CATEGORIES.map((id) => {
              const active = pathname === `/settings/${id}`;
              return (
                <li key={id}>
                  <Link
                    href={`/settings/${id}`}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex min-h-12 flex-col justify-center rounded-md border px-3 py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-paper",
                      active ? "border-ink bg-ink text-paper" : "border-rule bg-card text-ink hover:bg-panel md:border-transparent md:bg-transparent"
                    )}
                  >
                    <span className="font-display text-xs font-bold uppercase tracking-wide">{t(`categories.${id}.label`)}</span>
                    <span className={cn("text-xs", active ? "text-paper/80" : "text-faint")}>{t(`categories.${id}.hint`)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* tabIndex -1: where focus goes when the control that had it disappears (install flow). */}
        <div id="settings-content" tabIndex={-1} className={cn("min-w-0 focus:outline-none", isIndex ? "hidden md:block" : "")}>
          <div className="flex flex-col gap-4">
            <Link
              href="/settings"
              className="inline-flex min-h-11 items-center self-start text-sm text-ink-soft transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink md:hidden"
            >
              <span aria-hidden>←&nbsp;</span>
              {t("back")}
            </Link>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
