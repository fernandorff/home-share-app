"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api";
import { useApiError } from "@/lib/api-errors";
import { useToast } from "@/components/ui/Toast";
import { Card, SectionTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";

/** Settings › Security (spec 011). ADR 0013: "Log out" only signs this device out; this revokes every session (a
 *  forgotten or copied cookie too). */
export default function SecuritySettingsPage() {
  const t = useTranslations("Account");
  const tc = useTranslations("Common");
  const apiErr = useApiError();
  const toast = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onLogoutAll() {
    setBusy(true);
    try {
      await api.post("/api/auth/logout-all");
      window.location.href = "/auth/login";
    } catch (err) {
      toast(apiErr(err, t("logoutAllError")), "error");
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <SectionTitle>{t("sessionsTitle")}</SectionTitle>
      <Card className="p-4">
        <div className="flex flex-col gap-3">
          <div>
            <p className="text-sm font-medium text-ink">{t("logoutAllTitle")}</p>
            <p className="mt-1 text-pretty text-sm text-faint">{t("logoutAllHint")}</p>
          </div>
          <Button variant="secondary" className="w-full sm:w-auto" onClick={() => setConfirmOpen(true)}>
            {t("logoutAllButton")}
          </Button>
        </div>
      </Card>

      <Modal
        open={confirmOpen}
        onOpenChange={(o) => !o && !busy && setConfirmOpen(false)}
        title={t("logoutAllConfirmTitle")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={busy}>
              {tc("cancel")}
            </Button>
            <Button variant="danger" loading={busy} onClick={onLogoutAll}>
              {t("logoutAllButton")}
            </Button>
          </>
        }
      >
        <p className="text-pretty text-sm text-ink">{t("logoutAllHint")}</p>
      </Modal>
    </section>
  );
}
