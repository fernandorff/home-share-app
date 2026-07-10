"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { api } from "@/lib/api";
import { useApiError } from "@/lib/api-errors";
import { Card } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { GoogleButton } from "@/components/auth/GoogleButton";

const CODE_TO_KEY: Record<string, string> = {
  google_indisponivel: "googleUnavailable",
  google_cancelado: "googleCancelled",
  google_estado: "googleState",
  google_falha: "googleFailed",
};

export default function LoginPage() {
  const router = useRouter();
  const t = useTranslations("Auth");
  const tc = useTranslations("Common");
  const apiErr = useApiError();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("error");
    if (code) setError(t(CODE_TO_KEY[code] ?? "genericError"));
  }, [t]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const u = username.trim().toLowerCase();

    // Validated here (not via `required`) so the message is a styled inline error in the UI's
    // chosen language, not the browser's native validation bubble (renders in the browser/OS
    // locale regardless of the app's language — U1).
    if (!u || !password) {
      setError(t("fieldsRequired"));
      return;
    }

    setLoading(true);
    try {
      await api.post("/api/auth/login", { username: u, password });
      router.replace("/");
    } catch (err) {
      setError(apiErr(err, t("errorLogin")));
      setLoading(false);
    }
  }

  return (
    <Card className="p-5">
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <h2 className="font-display text-lg font-bold uppercase tracking-wide text-ink">
          {t("loginTitle")}
        </h2>

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

        <Field label={t("password")} htmlFor="password">
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            placeholder="••••••••"
          />
        </Field>

        <Button type="submit" loading={loading} className="w-full">
          {t("loginButton")}
        </Button>
      </form>

      <div className="my-4 flex items-center gap-3">
        <span className="flex-1 border-t border-dashed border-rule" />
        <span className="label-mono">{tc("or")}</span>
        <span className="flex-1 border-t border-dashed border-rule" />
      </div>

      <GoogleButton label={t("googleLogin")} />

      <p className="mt-5 text-center text-sm text-faint">
        {t("noAccount")}{" "}
        <Link href="/auth/register" className="text-ink underline underline-offset-2">
          {t("createAccount")}
        </Link>
      </p>
    </Card>
  );
}
