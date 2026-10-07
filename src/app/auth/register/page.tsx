"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import { useApiError } from "@/lib/api-errors";
import { authErrorField, firstErrorField, validateRegister, type AuthField } from "@/lib/auth-form";
import { Card } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { GoogleButton } from "@/components/auth/GoogleButton";

type ErrorRef = { key: string } | { api: unknown; fallbackKey: string };
const REGISTER_FIELDS: readonly AuthField[] = ["name", "username", "password"];

export default function RegisterPage() {
  const router = useRouter();
  const t = useTranslations("Auth");
  const tc = useTranslations("Common");
  const apiErr = useApiError();
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  // Stores what the error IS (a translation key, or an API error paired with its fallback key),
  // not its already-translated text — so a language switch (which refreshes this page's
  // translations without remounting it, see LanguageSelector) re-translates the banner
  // instead of leaving it stuck in the old language (I2).
  const [error, setError] = useState<ErrorRef | null>(null);
  // R3-03: an error that belongs to one field renders under it (Field: debt border, aria-invalid,
  // message) and that field gets focus; the banner stays for whole-form errors. Stored as keys /
  // API errors too, so a language switch re-translates them (I2).
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<AuthField, ErrorRef>>>({});
  const message = (e: ErrorRef) => ("key" in e ? t(e.key) : apiErr(e.api, t(e.fallbackKey)));
  function showFieldErrors(errors: Partial<Record<AuthField, ErrorRef>>) {
    setFieldErrors(errors);
    const first = firstErrorField(REGISTER_FIELDS, errors);
    if (first) document.getElementById(first)?.focus();
  }
  function clearFieldError(field: AuthField) {
    if (fieldErrors[field]) setFieldErrors((prev) => ({ ...prev, [field]: undefined }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});

    // Validated here (not via required/minLength) so the message is a styled inline error in the
    // UI's chosen language, not the browser's native validation bubble (U1). R3-03: under the field.
    const invalid = validateRegister({ name, username, password });
    if (Object.keys(invalid).length > 0) {
      const refs: Partial<Record<AuthField, ErrorRef>> = {};
      for (const [field, key] of Object.entries(invalid) as [AuthField, string][]) refs[field] = { key };
      showFieldErrors(refs);
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
      const field = authErrorField(err instanceof ApiError ? err.code : undefined);
      if (field) showFieldErrors({ [field]: { api: err, fallbackKey: "errorRegister" } });
      else setError({ api: err, fallbackKey: "errorRegister" });
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
          <div role="alert" className="rounded-md border border-debt/40 bg-stamp-soft px-3 py-2 text-sm text-stamp-text">
            {message(error)}
          </div>
        )}

        <Field label={t("name")} htmlFor="name" error={fieldErrors.name && message(fieldErrors.name)}>
          <Input
            id="name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              clearFieldError("name");
            }}
            autoComplete="name"
            maxLength={80}
            required
            placeholder={t("namePlaceholder")}
          />
        </Field>

        <Field
          label={t("username")}
          htmlFor="username"
          hint={t("usernameHint")}
          error={fieldErrors.username && message(fieldErrors.username)}
        >
          <Input
            id="username"
            value={username}
            // Scrubs to the server's own rule (lowercase letters, digits, . - _, max 30) as the
            // user types (BL-30/U2) — invalid chars just never appear, instead of a round-trip 400.
            onChange={(e) => {
              setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 30));
              clearFieldError("username");
            }}
            autoComplete="username"
            autoCapitalize="none"
            required
            placeholder={t("usernamePlaceholder")}
          />
        </Field>

        <Field
          label={t("password")}
          htmlFor="password"
          hint={t("passwordHint")}
          error={fieldErrors.password && message(fieldErrors.password)}
        >
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              clearFieldError("password");
            }}
            autoComplete="new-password"
            minLength={8}
            required
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
        <Link href="/auth/login" className="inline-flex min-h-11 items-center text-ink underline underline-offset-2 md:min-h-0">
          {t("signin")}
        </Link>
      </p>
    </Card>
  );
}
