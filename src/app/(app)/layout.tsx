"use client";

import { useTranslations } from "next-intl";
import { SessionProvider, useSession } from "@/lib/session";
import { ToastProvider } from "@/components/ui/Toast";
import { AppChrome } from "@/components/app/AppChrome";
import { Onboarding } from "@/components/app/Onboarding";
import { PushMessageListener, PushSync } from "@/components/app/ServiceWorkerRegistrar";
import { NotificationsProvider } from "@/lib/notifications-context";
import { Spinner } from "@/components/ui/Feedback";

function Shell({ children }: { children: React.ReactNode }) {
  const { me, loading } = useSession();
  const t = useTranslations("Common");

  if (loading) {
    return (
      <div className="grid min-h-dvh place-items-center text-faint">
        <span className="flex items-center gap-2">
          <Spinner />
          <span className="label-mono">{t("loading")}</span>
        </span>
      </div>
    );
  }

  // 401 already redirected to /auth/login; render nothing while it navigates.
  if (!me) return null;

  // Spec 010: the push sync needs only the session and the locale, so it sits before the onboarding gate — a member
  // without a house yet re-registers this device (or releases a shared browser's subscription) too. It is the same
  // first child in both branches, so creating or joining a house keeps it mounted (no second sync).
  return (
    <>
      <PushSync />
      {me.user.groups.length === 0 ? (
        // No house yet → first-run onboarding (create or join).
        <Onboarding />
      ) : (
        // Spec 009: the bell and the Notices page share one unread count (needs an active house, hence after
        // onboarding). Spec 010: a push the worker reports refreshes that count (and an open Notices list).
        <NotificationsProvider>
          <PushMessageListener />
          <AppChrome>{children}</AppChrome>
        </NotificationsProvider>
      )}
    </>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <SessionProvider>
        <Shell>{children}</Shell>
      </SessionProvider>
    </ToastProvider>
  );
}
