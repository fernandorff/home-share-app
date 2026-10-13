"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api";
import { useApiError } from "@/lib/api-errors";
import { NOTIFICATION_TYPES, type NotificationType } from "@/lib/notifications";
import type { InstallCardState } from "@/lib/notification-view";
import type { NotificationPreferences as Preferences, NotificationPreferencesResponse } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Card, SectionTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/Feedback";
import { Skeleton } from "@/components/ui/Skeleton";
import { Stamp } from "@/components/ui/Stamp";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/components/ui/cn";
import { AppIcon } from "@/components/notifications/InstallBanner";
import { PushCard } from "@/components/notifications/PushCard";

/**
 * Preferences tab (spec 009, task 19; criteria 9, 13, 15): one switch per notice type with its description — off
 * means no notice of that type is created (per user, every house) — and the "App on home screen" card. Toggles are
 * optimistic and roll back on error. Spec 010 adds the push card on top; its iPhone link opens the same install steps.
 */
export function NotificationPreferences({ installState, onInstall }: { installState: InstallCardState; onInstall: () => void }) {
  const t = useTranslations("Notifications");
  const apiErr = useApiError();
  const toast = useToast();
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [failed, setFailed] = useState(false);
  // Types with a save in flight; the ref is the synchronous double-tap guard.
  const busyRef = useRef(new Set<NotificationType>());

  const load = useCallback(async () => {
    try {
      const res = await api.get<NotificationPreferencesResponse>("/api/notification-preferences");
      setPrefs(res.preferences);
      setFailed(false);
    } catch (e) {
      toast(apiErr(e, t("prefsLoadError")), "error");
      setFailed(true);
    }
  }, [apiErr, t, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(type: NotificationType) {
    if (!prefs || busyRef.current.has(type)) return;
    busyRef.current.add(type);
    const enabled = !prefs[type];
    const label = t(`types.${type}.label`);
    setPrefs((p) => p && { ...p, [type]: enabled });
    try {
      const res = await api.put<NotificationPreferencesResponse>("/api/notification-preferences", { type, enabled });
      // Only this switch: another toggle may still be in flight, and this answer predates its optimistic value.
      setPrefs((p) => p && { ...p, [type]: res.preferences[type] });
      toast(enabled ? t("toast.prefOn", { label }) : t("toast.prefOff", { label }), "success");
    } catch (e) {
      setPrefs((p) => p && { ...p, [type]: !enabled });
      toast(apiErr(e, t("prefError")), "error");
    } finally {
      busyRef.current.delete(type);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PushCard onIosHowTo={onInstall} />

      <SectionTitle>{t("prefsTypes")}</SectionTitle>

      {prefs === null && failed ? (
        <Card>
          <EmptyState title={t("prefsLoadError")} icon="↻" />
        </Card>
      ) : prefs === null ? (
        <Card className="flex flex-col gap-4 p-4">
          {NOTIFICATION_TYPES.map((type) => (
            <div key={type} className="flex items-center gap-3">
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="w-36" />
                <Skeleton className="w-56 max-w-full" />
              </div>
              <Skeleton className="w-11" />
            </div>
          ))}
        </Card>
      ) : (
        <Card className="reveal">
          <ul>
            {NOTIFICATION_TYPES.map((type) => {
              const on = prefs[type];
              return (
                <li key={type} className="flex items-center gap-3 border-b border-dotted border-rule px-4 py-3 last:border-0">
                  <div className="min-w-0 flex-1">
                    <p id={`pref-${type}-label`} className="text-sm font-bold text-ink">
                      {t(`types.${type}.label`)}
                    </p>
                    <p id={`pref-${type}-description`} className="mt-0.5 text-pretty text-xs text-faint">
                      {t(`types.${type}.description`)}
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={on}
                    aria-labelledby={`pref-${type}-label`}
                    aria-describedby={`pref-${type}-description`}
                    onClick={() => void toggle(type)}
                    // 44px target below md around the 24px track; compact from md.
                    className="inline-flex h-11 w-14 shrink-0 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink md:h-8 md:w-12"
                  >
                    <span
                      aria-hidden
                      className={cn("relative h-6 w-11 rounded-full border transition-colors", on ? "border-ink bg-ink" : "border-rule bg-panel")}
                    >
                      <span
                        className={cn(
                          "absolute left-0.5 top-0.5 h-[1.125rem] w-[1.125rem] rounded-full border motion-safe:transition-transform",
                          on ? "translate-x-5 border-paper bg-paper" : "border-rule bg-card"
                        )}
                      />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <Card className="flex items-center gap-3 p-4">
        <AppIcon />
        <div className="min-w-0 flex-1">
          <p id="install-card-title" className="text-sm font-bold text-ink">
            {t("install.cardTitle")}
          </p>
          <p className="mt-0.5 text-pretty text-xs text-faint">
            {installState === "installed"
              ? t("install.cardInstalled")
              : installState === "unsupported"
              ? t("install.unsupported")
              : t("install.cardBody")}
          </p>
        </div>
        {/* Install only where it does something; after the one-time prompt was used ("promptUsed"): body, no button. */}
        {installState === "prompt" || installState === "manual" ? (
          <Button variant="secondary" size="sm" onClick={onInstall} aria-describedby="install-card-title" className="shrink-0">
            {t("install.install")}
          </Button>
        ) : installState === "installed" ? (
          <Stamp tone="credit" className="shrink-0">
            {t("install.installedStamp")}
          </Stamp>
        ) : null}
      </Card>
    </div>
  );
}
