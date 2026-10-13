"use client";

import { useTranslations } from "next-intl";
import { pushConfigured } from "@/lib/push/client";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

/** The app's icon (src/app/icon.svg) inline — the brand mark, the same in every theme like the installed icon. */
export function AppIcon({ size = 40 }: { size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 32 32" className="shrink-0">
      <rect width="32" height="32" rx="6" fill="#16140f" />
      <path d="M10 6h12v20l-2-1.3-2 1.3-2-1.3-2 1.3-2-1.3-2 1.3z" fill="#f2f0e9" />
      <path d="M13 12h6M13 16h6M13 20h4" stroke="#16140f" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="22.5" cy="9.5" r="3.2" fill="#d6452c" />
    </svg>
  );
}

/**
 * "Install Home Share" banner on the Notices page (spec 009, criteria 2–3). The page decides when it shows
 * (installBannerVisible) and what Install does (the deferred prompt, or the iOS steps sheet). With push configured
 * (spec 010) the body also says the installed app receives the house's notices.
 */
export function InstallBanner({ onInstall, onNotNow }: { onInstall: () => void; onNotNow: () => void }) {
  const t = useTranslations("Notifications");
  return (
    <section aria-labelledby="install-banner-title" className="reveal">
      <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <AppIcon />
          <div className="min-w-0">
            <h2 id="install-banner-title" className="font-display text-sm font-bold text-ink">
              {t("install.bannerTitle")}
            </h2>
            <p className="mt-0.5 text-pretty text-xs text-faint">
              {pushConfigured() ? t("install.bannerBodyPush") : t("install.bannerBody")}
            </p>
          </div>
        </div>
        <div className="flex gap-2 sm:shrink-0">
          <Button size="sm" onClick={onInstall} className="flex-1 sm:flex-none">
            {t("install.install")}
          </Button>
          <Button size="sm" variant="ghost" onClick={onNotNow} className="flex-1 sm:flex-none">
            {t("install.notNow")}
          </Button>
        </div>
      </Card>
    </section>
  );
}
