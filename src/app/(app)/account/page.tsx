"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { api, ApiError } from "@/lib/api";
import { useApiError } from "@/lib/api-errors";
import { useSession } from "@/lib/session";
import { syncPush } from "@/lib/push/client";
import { useToast } from "@/components/ui/Toast";
import { Card, SectionTitle } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { PageHeader } from "@/components/ui/PageHeader";
import type { Me } from "@/lib/types";

export default function AccountPage() {
  const t = useTranslations("Account");
  const { me, refresh } = useSession();

  if (!me) return null;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <ProfileSection me={me} onSaved={refresh} />
      <PasswordSection hasPassword={me.user.hasPassword} owner={me.user.publicId} />
      <SessionsSection />
      <DeleteAccountSection
        hasPassword={me.user.hasPassword}
        lastAdminHouses={me.user.groups.filter((g) => g.lastAdmin).map((g) => g.name)}
      />
    </div>
  );
}

/** ADR 0013: "Log out" only signs this device out; this revokes every session (a forgotten or copied cookie too). */
function SessionsSection() {
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

function ProfileSection({ me, onSaved }: { me: Me; onSaved: () => Promise<void> }) {
  const t = useTranslations("Account");
  const tErr = useTranslations("ApiErrors");
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
  const [nameError, setNameError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [currentPasswordError, setCurrentPasswordError] = useState<string | null>(null);

  const sensitiveChanged =
    email.trim().toLowerCase() !== original.email.toLowerCase() ||
    username.trim().toLowerCase() !== original.username;
  const needsCurrentPassword = sensitiveChanged && me.user.hasPassword;
  const dirty = name.trim() !== original.name || sensitiveChanged;

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setNameError(null);
    setEmailError(null);
    setUsernameError(null);
    setCurrentPasswordError(null);

    // Guard (reviewer, round 1): clearing Name — or Username on a Google-only account, which
    // needs no current password — still leaves dirty/needsCurrentPassword true, so Save stays
    // enabled. Catch the empty value here instead of round-tripping for the server's own
    // INVALID_NAME/INVALID_USERNAME, which used to surface only as a toast.
    if (!name.trim()) {
      setNameError(tErr("INVALID_NAME"));
      return;
    }
    if (!username.trim()) {
      setUsernameError(tErr("INVALID_USERNAME"));
      return;
    }

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
      // U11 (controller ruling, round 1): every field-level code PATCH /api/auth/me can return
      // renders under its own field; anything else (rate limit, network, unknown) keeps the toast.
      const code = err instanceof ApiError ? err.code : undefined;
      if (code === "INVALID_NAME") {
        setNameError(apiErr(err, t("profileError")));
      } else if (code === "INVALID_USERNAME" || code === "USERNAME_TAKEN") {
        setUsernameError(apiErr(err, t("profileError")));
      } else if (code === "INVALID_EMAIL" || code === "EMAIL_TAKEN") {
        setEmailError(apiErr(err, t("profileError")));
      } else if (code === "CURRENT_PASSWORD_REQUIRED" || code === "CURRENT_PASSWORD_INVALID") {
        setCurrentPasswordError(apiErr(err, t("profileError")));
      } else {
        toast(apiErr(err, t("profileError")), "error");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <SectionTitle>{t("profileTitle")}</SectionTitle>
      <Card className="p-4">
        <form onSubmit={onSave} noValidate className="flex flex-col gap-4">
          <Field label={t("name")} htmlFor="account-name" error={nameError}>
            <Input
              id="account-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (nameError) setNameError(null);
              }}
              maxLength={80}
              autoComplete="name"
              required
              aria-invalid={!!nameError}
            />
          </Field>
          <Field label={t("email")} htmlFor="account-email" hint={t("emailHint")} error={emailError}>
            {/* Not required: email is optional (nullable in the DB — self-registered accounts
                have none until they set it here or link Google). A required-but-empty field would
                silently block the browser's native form submit even for an unrelated name-only edit.
                R3-30: the hint says it is optional and the placeholder shows the format. */}
            <Input
              id="account-email"
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (emailError) setEmailError(null);
              }}
              maxLength={254}
              autoComplete="email"
              placeholder={t("emailPlaceholder")}
              aria-invalid={!!emailError}
            />
          </Field>
          <Field label={t("username")} htmlFor="account-username" error={usernameError}>
            <Input
              id="account-username"
              value={username}
              // Scrubs to the server's own rule (lowercase letters, digits, . - _) as the user
              // types (BL-30/U2) — invalid chars just never appear, instead of a round-trip 400.
              onChange={(e) => {
                setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ""));
                if (usernameError) setUsernameError(null);
              }}
              maxLength={30}
              autoCapitalize="none"
              autoComplete="username"
              required
              aria-invalid={!!usernameError}
            />
          </Field>
          {needsCurrentPassword && (
            <Field
              label={t("currentPassword")}
              htmlFor="account-current-password"
              hint={t("currentPasswordHint")}
              error={currentPasswordError}
            >
              <Input
                id="account-current-password"
                type="password"
                value={currentPassword}
                onChange={(e) => {
                  setCurrentPassword(e.target.value);
                  if (currentPasswordError) setCurrentPasswordError(null);
                }}
                autoComplete="current-password"
                required
                aria-invalid={!!currentPasswordError}
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

function PasswordSection({ hasPassword, owner }: { hasPassword: boolean; owner: string }) {
  const t = useTranslations("Account");
  const apiErr = useApiError();
  const toast = useToast();
  const locale = useLocale();
  const { refresh } = useSession();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [currentPasswordError, setCurrentPasswordError] = useState<string | null>(null);
  const [newPasswordError, setNewPasswordError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  // U11: checked on blur (not on every keystroke) so a mismatch shows under the confirm field
  // instead of only as a toast; an empty field is left alone (not yet the user's business to fix).
  function onConfirmBlur() {
    if (confirm && newPassword !== confirm) {
      setConfirmError(t("passwordMismatch"));
    }
  }

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword !== confirm) {
      setConfirmError(t("passwordMismatch"));
      return;
    }
    setSaving(true);
    setCurrentPasswordError(null);
    setNewPasswordError(null);
    try {
      await api.post("/api/auth/password", {
        ...(hasPassword ? { currentPassword } : {}),
        newPassword,
      });
      // Spec 010 (criterion 9): the change deleted every push subscription of the account. This device keeps its session
      // (the answer re-signed the cookie) and its permission, so it re-registers now, without a prompt — best effort.
      syncPush({ owner, locale }).catch(() => {});
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
      // U11 (controller ruling, round 1): current-password and new-password codes render under
      // their own field; anything else (rate limit, network, unknown) keeps the toast.
      const code = err instanceof ApiError ? err.code : undefined;
      if (code === "CURRENT_PASSWORD_INVALID" || code === "CURRENT_PASSWORD_REQUIRED") {
        setCurrentPasswordError(apiErr(err, t("passwordError")));
      } else if (code === "INVALID_PASSWORD" || code === "PASSWORD_TOO_COMMON" || code === "PASSWORD_NO_COMPLEXITY") {
        setNewPasswordError(apiErr(err, t("passwordError")));
      } else {
        toast(apiErr(err, t("passwordError")), "error");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <SectionTitle>{t("passwordTitle")}</SectionTitle>
      <Card className="p-4">
        <form onSubmit={onSave} noValidate className="flex flex-col gap-4">
          <p className="text-pretty text-sm text-faint">
            {hasPassword ? t("changePasswordHint") : t("definePasswordHint")}
          </p>
          {hasPassword && (
            <Field label={t("currentPassword")} htmlFor="password-current" error={currentPasswordError}>
              <Input
                id="password-current"
                type="password"
                value={currentPassword}
                onChange={(e) => {
                  setCurrentPassword(e.target.value);
                  if (currentPasswordError) setCurrentPasswordError(null);
                }}
                autoComplete="current-password"
                required
                aria-invalid={!!currentPasswordError}
              />
            </Field>
          )}
          <Field
            label={t("newPassword")}
            htmlFor="password-new"
            hint={t("passwordHint")}
            error={newPasswordError}
          >
            <Input
              id="password-new"
              type="password"
              value={newPassword}
              onChange={(e) => {
                setNewPassword(e.target.value);
                if (confirmError) setConfirmError(null);
                if (newPasswordError) setNewPasswordError(null);
              }}
              autoComplete="new-password"
              minLength={8}
              required
              aria-invalid={!!newPasswordError}
            />
          </Field>
          <Field label={t("confirmPassword")} htmlFor="password-confirm" error={confirmError}>
            <Input
              id="password-confirm"
              type="password"
              value={confirm}
              onChange={(e) => {
                setConfirm(e.target.value);
                if (confirmError) setConfirmError(null);
              }}
              onBlur={onConfirmBlur}
              autoComplete="new-password"
              minLength={8}
              required
              aria-invalid={!!confirmError}
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

/** BL-23: anonymizes name/email/username/password/googleId in place (never a real row delete —
 *  Expense/Settlement FKs point straight at User.id and must survive for other members'
 *  history), soft-leaves every house the account is active in, then signs out everywhere. */
function DeleteAccountSection({
  hasPassword,
  lastAdminHouses,
}: {
  hasPassword: boolean;
  lastAdminHouses: string[];
}) {
  const t = useTranslations("Account");
  const tc = useTranslations("Common");
  const apiErr = useApiError();
  const toast = useToast();

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [deleting, setDeleting] = useState(false);
  // spec 006: the server refuses with LAST_ADMIN while the user is the only admin of a house
  // that still has other members — block the button and name the houses up front.
  const blockedByLastAdmin = lastAdminHouses.length > 0;

  async function onDelete() {
    setDeleting(true);
    try {
      await api.del("/api/auth/me", hasPassword ? { currentPassword } : undefined);
      toast(t("deleteAccountSuccess"), "success");
      // The server already cleared the session/group cookies — a full navigation (not
      // router.push) guarantees the client picks up the logged-out state immediately.
      window.location.href = "/auth/login";
    } catch (err) {
      toast(apiErr(err, t("deleteAccountError")), "error");
      setDeleting(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <SectionTitle>{t("dangerZoneTitle")}</SectionTitle>
      <Card className="border-debt/40 p-4">
        <div className="flex flex-col gap-3">
          <div>
            <p className="text-sm font-medium text-ink">{t("deleteAccountTitle")}</p>
            <p className="mt-1 text-pretty text-sm text-faint">{t("deleteAccountHint")}</p>
          </div>
          <Button
            variant="danger"
            className="w-full sm:w-auto"
            onClick={() => {
              setCurrentPassword("");
              setConfirmOpen(true);
            }}
          >
            {t("deleteAccountButton")}
          </Button>
        </div>
      </Card>

      <Modal
        open={confirmOpen}
        onOpenChange={(o) => !o && !deleting && setConfirmOpen(false)}
        title={t("deleteAccountConfirmTitle")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={deleting}>
              {tc("cancel")}
            </Button>
            <Button
              variant="danger"
              loading={deleting}
              disabled={blockedByLastAdmin || (hasPassword && !currentPassword)}
              onClick={onDelete}
            >
              {t("deleteAccountConfirmButton")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {blockedByLastAdmin && (
            <p className="rounded-md bg-stamp-soft px-3 py-2 text-pretty text-sm text-ink">
              {t("deleteAccountLastAdmin", { houses: lastAdminHouses.join(", ") })}
            </p>
          )}
          <p className="text-pretty text-sm text-ink">
            {t("deleteAccountHint")} {t("deleteAccountConfirmPrompt")}
          </p>
          {hasPassword && (
            <Field label={t("currentPassword")} htmlFor="delete-account-password">
              <Input
                id="delete-account-password"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </Field>
          )}
        </div>
      </Modal>
    </section>
  );
}
