"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { api } from "@/lib/api";
import { useApiError } from "@/lib/api-errors";
import { Card } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { GoogleButton } from "@/components/auth/GoogleButton";

export default function RegisterPage() {
  const router = useRouter();
  const t = useTranslations("Auth");
  const tc = useTranslations("Common");
  const apiErr = useApiError();
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Validated here (not via required/minLength) so the message is a styled inline error in
    // the UI's chosen language, not the browser's native validation bubble (which renders in
    // the browser/OS locale regardless of the app's language — a jarring mismatch, U1).
    if (!name.trim() || !username.trim() || !password) {
      setError(t("fieldsRequired"));
      return;
    }
    if (username.trim().length < 3) {
      setError(t("usernameHint"));
      return;
    }
    if (password.length < 8) {
      setError(t("passwordHint"));
      return;
    }

    setLoading(true);
    try {
      await api.post("/api/auth/register", {
        name: name.trim(),
        username: username.trim().toLowerCase(),
        password,
      });
      router.replace("/");
    } catch (err) {
      setError(apiErr(err, t("errorRegister")));
      setLoading(false);
    }
  }

  return (
    <Card className="p-5">
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <h2 className="font-display text-lg font-bold uppercase tracking-wide text-ink">
          {t("registerTitle")}
        </h2>

        {error && (
          <div className="rounded-md border border-debt/40 bg-stamp-soft px-3 py-2 text-sm text-debt">
            {error}
          </div>
        )}

        <Field label={t("name")} htmlFor="name">
          <Input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            maxLength={80}
            required
            placeholder={t("namePlaceholder")}
          />
        </Field>

        <Field label={t("username")} htmlFor="username" hint={t("usernameHint")}>
          <Input
            id="username"
            value={username}
            // Scrubs to the server's own rule (lowercase letters, digits, . - _, max 30) as the
            // user types (BL-30/U2) — invalid chars just never appear, instead of a round-trip 400.
            onChange={(e) =>
              setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 30))
            }
            autoComplete="username"
            autoCapitalize="none"
            required
            placeholder={t("usernamePlaceholder")}
          />
        </Field>

        <Field label={t("password")} htmlFor="password" hint={t("passwordHint")}>
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

        <Button type="submit" loading={loading} className="w-full">
          {t("registerButton")}
        </Button>
      </form>

      <div className="my-4 flex items-center gap-3">
        <span className="flex-1 border-t border-dashed border-rule" />
        <span className="label-mono">{tc("or")}</span>
        <span className="flex-1 border-t border-dashed border-rule" />
      </div>

      <GoogleButton label={t("googleRegister")} />

      <p className="mt-5 text-center text-sm text-faint">
        {t("hasAccount")}{" "}
        <Link href="/auth/login" className="text-ink underline underline-offset-2">
          {t("signin")}
        </Link>
      </p>
    </Card>
  );
}
