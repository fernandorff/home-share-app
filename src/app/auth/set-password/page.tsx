"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";

export default function SetPasswordPage() {
  const router = useRouter();
  const t = useTranslations("Auth");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const u = new URLSearchParams(window.location.search).get("u");
    if (u) setUsername(u);
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError(t("passwordMismatch"));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await api.post("/api/auth/set-password", {
        username: username.trim().toLowerCase(),
        password,
      });
      router.replace("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("errorSetPassword"));
      setLoading(false);
    }
  }

  return (
    <Card className="p-5">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <h2 className="font-display text-lg font-bold uppercase tracking-wide text-ink">
          {t("setPasswordTitle")}
        </h2>

        <p className="rounded-md border border-rule bg-panel px-3 py-2 text-sm text-ink-soft">
          {t("legacyNote")}
        </p>

        {error && (
          <div className="rounded-md border border-debt/40 bg-stamp-soft px-3 py-2 text-sm text-debt">
            {error}
          </div>
        )}

        <Field label={t("username")} htmlFor="username">
          <Input
            id="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            required
            placeholder={t("usernamePlaceholder")}
          />
        </Field>

        <Field label={t("newPassword")} htmlFor="password" hint={t("passwordHint")}>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
            placeholder="••••••••"
          />
        </Field>

        <Field label={t("confirmPassword")} htmlFor="confirm">
          <Input
            id="confirm"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
            placeholder="••••••••"
          />
        </Field>

        <Button type="submit" loading={loading} className="w-full">
          {t("setPasswordButton")}
        </Button>
      </form>

      <p className="mt-5 text-center text-sm text-faint">
        <Link href="/auth/login" className="text-ink underline underline-offset-2">
          {t("backToLogin")}
        </Link>
      </p>
    </Card>
  );
}
