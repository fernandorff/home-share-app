"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api";
import { useApiError } from "@/lib/api-errors";
import { useSession } from "@/lib/session";
import { useToast } from "@/components/ui/Toast";
import { Card, SectionTitle } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import type { Me } from "@/lib/types";

export default function ContaPage() {
  const t = useTranslations("Account");
  const { me, refresh } = useSession();

  if (!me) return null;

  return (
    <div className="flex flex-col gap-8">
      <div>
        <p className="label-mono text-faint">{t("subtitle")}</p>
        <h1 className="font-display text-2xl font-bold tracking-tight text-ink">{t("title")}</h1>
      </div>

      <ProfileSection me={me} onSaved={refresh} />
      <PasswordSection hasPassword={me.user.hasPassword} />
    </div>
  );
}

function ProfileSection({ me, onSaved }: { me: Me; onSaved: () => Promise<void> }) {
  const t = useTranslations("Account");
  const apiErr = useApiError();
  const toast = useToast();

  const original = {
    name: me.user.name,
    email: me.user.email ?? "",
    username: me.user.username,
  };
  const [name, setName] = useState(original.name);
  const [email, setEmail] = useState(original.email);
  const [username, setUsername] = useState(original.username);
  const [currentPassword, setCurrentPassword] = useState("");
  const [saving, setSaving] = useState(false);

  const sensitiveChanged =
    email.trim().toLowerCase() !== original.email.toLowerCase() ||
    username.trim().toLowerCase() !== original.username;
  const needsCurrentPassword = sensitiveChanged && me.user.hasPassword;
  const dirty = name.trim() !== original.name || sensitiveChanged;

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      // Only send fields that actually changed. A name-only edit must never touch email/username —
      // sending the untouched, possibly-empty email back would (a) trip the field's own validation
      // and (b) make the server treat it as a real change requiring re-auth.
      const body: { name?: string; email?: string; username?: string; currentPassword?: string } = {};
      if (name.trim() !== original.name) body.name = name.trim();
      if (email.trim().toLowerCase() !== original.email.toLowerCase()) body.email = email.trim();
      if (username.trim().toLowerCase() !== original.username) body.username = username.trim();
      if (needsCurrentPassword) body.currentPassword = currentPassword;

      await api.patch("/api/auth/me", body);
      setCurrentPassword("");
      await onSaved();
      toast(t("profileSaved"), "success");
    } catch (err) {
      toast(apiErr(err, t("profileError")), "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <SectionTitle>{t("profileTitle")}</SectionTitle>
      <Card className="p-4">
        <form onSubmit={onSave} className="flex flex-col gap-4">
          <Field label={t("name")} htmlFor="account-name">
            <Input
              id="account-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              required
            />
          </Field>
          <Field label={t("email")} htmlFor="account-email">
            {/* Not required: email is optional (nullable in the DB — self-registered accounts
                have none until they set it here or link Google). A required-but-empty field would
                silently block the browser's native form submit even for an unrelated name-only edit. */}
            <Input
              id="account-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              maxLength={254}
            />
          </Field>
          <Field label={t("username")} htmlFor="account-username">
            <Input
              id="account-username"
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase())}
              maxLength={30}
              autoCapitalize="none"
              required
            />
          </Field>
          {needsCurrentPassword && (
            <Field
              label={t("currentPassword")}
              htmlFor="account-current-password"
              hint={t("currentPasswordHint")}
            >
              <Input
                id="account-current-password"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </Field>
          )}
          <Button
            type="submit"
            loading={saving}
            disabled={!dirty || (needsCurrentPassword && !currentPassword)}
            className="w-full sm:w-auto"
          >
            {t("save")}
          </Button>
        </form>
      </Card>
    </section>
  );
}

function PasswordSection({ hasPassword }: { hasPassword: boolean }) {
  const t = useTranslations("Account");
  const apiErr = useApiError();
  const toast = useToast();
  const { refresh } = useSession();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword !== confirm) {
      toast(t("passwordMismatch"), "error");
      return;
    }
    setSaving(true);
    try {
      await api.post("/api/auth/password", {
        ...(hasPassword ? { currentPassword } : {}),
        newPassword,
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirm("");
      if (hasPassword) {
        toast(t("passwordSaved"), "success");
      } else {
        toast(t("passwordDefined"), "success");
        await refresh();
      }
    } catch (err) {
      toast(apiErr(err, t("passwordError")), "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <SectionTitle>{t("passwordTitle")}</SectionTitle>
      <Card className="p-4">
        <form onSubmit={onSave} className="flex flex-col gap-4">
          <p className="text-sm text-faint">
            {hasPassword ? t("changePasswordHint") : t("definePasswordHint")}
          </p>
          {hasPassword && (
            <Field label={t("currentPassword")} htmlFor="password-current">
              <Input
                id="password-current"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </Field>
          )}
          <Field label={t("newPassword")} htmlFor="password-new" hint={t("passwordHint")}>
            <Input
              id="password-new"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
            />
          </Field>
          <Field label={t("confirmPassword")} htmlFor="password-confirm">
            <Input
              id="password-confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
            />
          </Field>
          <Button
            type="submit"
            loading={saving}
            disabled={(hasPassword && !currentPassword) || newPassword.length < 8 || confirm.length < 8}
            className="w-full sm:w-auto"
          >
            {hasPassword ? t("saveButton") : t("defineButton")}
          </Button>
        </form>
      </Card>
    </section>
  );
}
