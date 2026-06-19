"use client";

import { useTranslations } from "next-intl";
import { SessionProvider, useSession } from "@/lib/session";
import { ToastProvider } from "@/components/ui/Toast";
import { AppChrome } from "@/components/app/AppChrome";
import { Onboarding } from "@/components/app/Onboarding";
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

  // No house yet → first-run onboarding (create or join).
  if (me.user.groups.length === 0) return <Onboarding />;

  return <AppChrome>{children}</AppChrome>;
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
