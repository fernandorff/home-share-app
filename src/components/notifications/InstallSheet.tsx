"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Stamp } from "@/components/ui/Stamp";
import { cn } from "@/components/ui/cn";
import { AppIcon } from "@/components/notifications/InstallBanner";
import type { InstallSheetAndroid } from "@/lib/notification-view";
import { useInstallPrompt } from "@/lib/use-install-prompt";

export type InstallSheetView = "steps" | "installed";
type Platform = "android" | "ios";

const IOS_STEPS = ["install.iosStep1", "install.iosStep2", "install.iosStep3"] as const;

/**
 * "Install the app" sheet (spec 009, criteria 2–3): Android = the browser's native prompt (when it offered one),
 * else the step through the browser menu; iPhone = the three manual Safari steps; then the "Installed"
 * confirmation. A bottom sheet below `sm` (Modal).
 * The page remounts it on every open, so the platform starts from the device each time.
 */
export function InstallSheet({
  open,
  onOpenChange,
  view,
  android,
  ios,
  onPrompt,
  onIosDone,
  fallbackFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: InstallSheetView;
  android: InstallSheetAndroid;
  ios: boolean;
  onPrompt: () => void;
  onIosDone: () => void;
  /** Focus target on close when the control that opened the sheet is gone (banner hidden meanwhile). */
  fallbackFocus: () => HTMLElement | null;
}) {
  const t = useTranslations("Notifications");
  const tc = useTranslations("Common");
  const [platform, setPlatform] = useState<Platform>(ios ? "ios" : "android");

  const platforms = [
    { id: "android", label: t("install.android") },
    { id: "ios", label: t("install.iphone") },
  ] as const;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t("install.sheetTitle")}
      fallbackFocus={fallbackFocus}
      footer={
        view === "installed" ? (
          // The confirmation replaces the button that had focus; focus lands here instead of on <body>.
          <Button autoFocus onClick={() => onOpenChange(false)} className="w-full sm:w-auto">
            {tc("close")}
          </Button>
        ) : undefined
      }
    >
      {view === "installed" ? (
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          <AppIcon size={56} />
          <Stamp tone="credit">{t("install.installedStamp")}</Stamp>
          <p className="text-pretty text-sm text-ink">{t("install.installedBody")}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-1">
            {platforms.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                aria-pressed={platform === id}
                onClick={() => setPlatform(id)}
                className={cn(
                  "min-h-11 rounded-md border px-3 py-1.5 text-xs font-display font-bold uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-stamp md:min-h-0",
                  platform === id ? "border-ink bg-ink text-paper" : "border-rule bg-card text-ink-soft hover:bg-panel"
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {platform === "android" ? (
            android === "prompt" ? (
              <>
                <p className="text-pretty text-sm text-ink-soft">{t("install.bannerBody")}</p>
                <Button onClick={onPrompt} className="w-full">
                  {t("install.install")}
                </Button>
              </>
            ) : android === "menu" ? (
              // The one-time prompt is spent (or this is an iPhone reading the Android tab): the browser menu installs.
              <p className="text-pretty text-sm text-ink">{t("install.androidMenu")}</p>
            ) : (
              <p className="text-pretty text-sm text-ink-soft">{t("install.unsupported")}</p>
            )
          ) : (
            <>
              <p className="text-pretty text-sm text-ink-soft">{t("install.iosIntro")}</p>
              <ol className="flex flex-col gap-2">
                {IOS_STEPS.map((key, i) => (
                  <li key={key} className="flex items-start gap-3 text-sm text-ink">
                    <span
                      aria-hidden
                      className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-ink font-display text-xs font-bold tnum"
                    >
                      {i + 1}
                    </span>
                    <span className="min-w-0 pt-0.5 text-pretty">{t(key)}</span>
                  </li>
                ))}
              </ol>
              <Button onClick={onIosDone} className="w-full">
                {t("install.iosDone")}
              </Button>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

/**
 * The install flow shared by the Notices banner and the Settings › Notifications card (spec 011): the device's install
 * state, `startInstall` (criterion 2: the deferred prompt; criterion 3: on iPhone/iPad the manual steps) and the sheet
 * to render. `fallbackFocus` is where focus goes when the control that started it is gone.
 */
export function useInstallFlow(fallbackFocus: () => HTMLElement | null) {
  const install = useInstallPrompt();
  // The sheet remounts (new key) on every open, so its platform starts from the device each time.
  const [sheet, setSheet] = useState<{ open: boolean; key: number; view: InstallSheetView }>({ open: false, key: 0, view: "steps" });

  const openSheet = (view: InstallSheetView) => setSheet((s) => ({ open: true, key: s.key + 1, view }));

  async function startInstall() {
    if (install.canPrompt) {
      // Spending the one-time prompt removes the control that has focus (the banner, the card's Install button).
      const trigger = document.activeElement;
      const outcome = await install.prompt();
      // Before the sheet opens, so the sheet hands focus back to the fallback when it closes.
      if (trigger instanceof HTMLElement && !trigger.isConnected) fallbackFocus()?.focus();
      if (outcome === "accepted") openSheet("installed");
      // The event was already used (single use): offer the manual paths.
      else if (outcome === "unavailable") openSheet("steps");
      return;
    }
    openSheet("steps");
  }

  async function promptFromSheet() {
    const outcome = await install.prompt();
    setSheet((s) => (outcome === "accepted" ? { ...s, view: "installed" } : { ...s, open: false }));
  }

  function iosDone() {
    // They added it by hand: no banner on this device for the next 30 days.
    install.dismiss();
    setSheet((s) => ({ ...s, view: "installed" }));
  }

  const sheetElement = (
    <InstallSheet
      key={sheet.key}
      open={sheet.open}
      onOpenChange={(open) => setSheet((s) => ({ ...s, open }))}
      view={sheet.view}
      android={install.sheetAndroid}
      ios={install.ios}
      onPrompt={() => void promptFromSheet()}
      onIosDone={iosDone}
      // Closed after its opener left (Android prompt accepted in the sheet, iOS "I've added it").
      fallbackFocus={fallbackFocus}
    />
  );

  return { install, startInstall, sheet: sheetElement };
}
