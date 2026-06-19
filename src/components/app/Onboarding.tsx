"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useSession } from "@/lib/session";
import { api, ApiError } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { Card } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { LanguageSelector } from "@/components/app/LanguageSelector";

export function Onboarding() {
  const { me, refresh } = useSession();
  const toast = useToast();
  const t = useTranslations("Onboarding");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);

  async function createCasa(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      await api.post("/api/groups", { name: name.trim() });
      toast(t("created"), "success");
      await refresh();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("createError"), "error");
      setCreating(false);
    }
  }

  async function joinCasa(e: React.FormEvent) {
    e.preventDefault();
    setJoining(true);
    try {
      await api.post("/api/groups/join", { code: code.trim().toUpperCase() });
      toast(t("joined"), "success");
      await refresh();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("joinError"), "error");
      setJoining(false);
    }
  }

  const logout = async () => {
    try {
      await api.post("/api/auth/logout");
    } finally {
      window.location.href = "/auth/login";
    }
  };

  return (
    <main className="paper-grain relative min-h-dvh px-4 py-10">
      <div className="absolute right-4 top-4">
        <LanguageSelector />
      </div>
      <div className="mx-auto max-w-2xl">
        <header className="mb-8 text-center">
          <h1 className="font-display text-2xl font-bold tracking-tight text-ink">
            HOME<span className="text-stamp">SHARE</span>
          </h1>
          <p className="mt-2 text-sm text-ink-soft">{t("greeting", { name: me?.user.name ?? "" })}</p>
          <p className="label-mono mt-1">{t("subtitle")}</p>
        </header>

        <div className="grid gap-4 md:grid-cols-2">
          <Card className="p-5">
            <form onSubmit={createCasa} className="flex flex-col gap-4">
              <h2 className="font-display text-base font-bold uppercase tracking-wide text-ink">
                {t("createTitle")}
              </h2>
              <Field label={t("houseName")} htmlFor="casa-name">
                <Input
                  id="casa-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={80}
                  required
                  placeholder={t("houseNamePlaceholder")}
                />
              </Field>
              <Button type="submit" loading={creating} disabled={!name.trim()} className="w-full">
                {t("createButton")}
              </Button>
              <p className="text-xs text-faint">{t("createHint")}</p>
            </form>
          </Card>

          <Card className="p-5">
            <form onSubmit={joinCasa} className="flex flex-col gap-4">
              <h2 className="font-display text-base font-bold uppercase tracking-wide text-ink">
                {t("joinTitle")}
              </h2>
              <Field label={t("houseCode")} htmlFor="casa-code" hint={t("codeHint")}>
                <Input
                  id="casa-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  maxLength={6}
                  required
                  placeholder="ABC123"
                  className="text-center text-lg tracking-[0.4em] uppercase"
                />
              </Field>
              <Button
                type="submit"
                variant="secondary"
                loading={joining}
                disabled={code.trim().length !== 6}
                className="w-full"
              >
                {t("joinButton")}
              </Button>
              <p className="text-xs text-faint">{t("joinHint")}</p>
            </form>
          </Card>
        </div>

        <div className="mt-8 text-center">
          <button onClick={logout} className="label-mono underline underline-offset-2 hover:text-ink">
            {t("logout")}
          </button>
        </div>
      </div>
    </main>
  );
}
