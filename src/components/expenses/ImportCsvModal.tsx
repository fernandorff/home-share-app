"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import { Money } from "@/components/ui/Money";
import { ReceiptDivider } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { useSession } from "@/lib/session";
import { api } from "@/lib/api";
import { useApiError } from "@/lib/api-errors";
import type { Platform, ImportResult } from "@/lib/types";

interface ImportCsvModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  platforms: Platform[];
  /** Called after a successful import so the list can refetch. */
  onImported: () => void;
}

function createdCount(created: ImportResult["created"]): number {
  return Array.isArray(created) ? created.length : created;
}

export function ImportCsvModal({
  open,
  onOpenChange,
  platforms,
  onImported,
}: ImportCsvModalProps) {
  const { me, members } = useSession();
  const toast = useToast();
  const t = useTranslations("Expenses");
  const tc = useTranslations("Common");
  const apiErr = useApiError();

  const [file, setFile] = useState<File | null>(null);
  const [platformId, setPlatformId] = useState<string>("");
  const [payerId, setPayerId] = useState<string>("");
  const [splitEqually, setSplitEqually] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  // Reset state each time the modal opens; default payer = current user.
  useEffect(() => {
    if (!open) return;
    setFile(null);
    setPlatformId("");
    setPayerId(me ? String(me.user.id) : "");
    setSplitEqually(true);
    setResult(null);
    setFormError(null);
  }, [open, me]);

  const canSubmit = file !== null && platformId !== "" && !submitting;

  async function handleSubmit() {
    if (!canSubmit || !file) return;
    setSubmitting(true);
    setFormError(null);
    setResult(null);

    const form = new FormData();
    form.append("file", file);
    form.append("platformId", platformId);
    if (payerId !== "") form.append("payerId", payerId);
    form.append("splitEqually", splitEqually ? "true" : "false");

    try {
      const res = await api.post<ImportResult>("/api/expenses/import", form);
      setResult(res);
      const n = createdCount(res.created);
      toast(
        t("toastImported", { count: n }),
        n > 0 ? "success" : "info"
      );
      if (n > 0) onImported();
    } catch (err) {
      const message = apiErr(err, t("importError"));
      setFormError(message);
      toast(message, "error");
    } finally {
      setSubmitting(false);
    }
  }

  const created = result ? createdCount(result.created) : 0;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t("importTitle")}
      description={t("importDescription")}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {tc("close")}
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit} loading={submitting}>
            {t("importButton")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label={t("csvFile")}
          htmlFor="imp-file"
          hint={t("csvFileHint")}
        >
          <Input
            id="imp-file"
            type="file"
            accept=".csv"
            className="cursor-pointer file:mr-3 file:rounded-sm file:border file:border-rule file:bg-panel file:px-2 file:py-1 file:text-xs file:uppercase file:tracking-wide"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </Field>

        <Field label={t("platform")} htmlFor="imp-platform" hint={t("required")}>
          <Select
            id="imp-platform"
            value={platformId}
            onChange={(e) => setPlatformId(e.target.value)}
          >
            <option value="" disabled>
              {t("selectPlaceholder")}
            </option>
            {platforms.map((p) => (
              <option key={p.id} value={String(p.id)}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label={t("payer")}
          htmlFor="imp-payer"
          hint={t("payerImportHint")}
        >
          <Select
            id="imp-payer"
            value={payerId}
            onChange={(e) => setPayerId(e.target.value)}
          >
            {members.map((m) => (
              <option key={m.id} value={String(m.id)}>
                {m.name}
              </option>
            ))}
          </Select>
        </Field>

        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={splitEqually}
            onChange={(e) => setSplitEqually(e.target.checked)}
            className="h-4 w-4 accent-ink"
          />
          {t("splitEquallyMembers")}
        </label>

        {formError && <p className="text-sm text-debt">{formError}</p>}

        {result && (
          <div className="flex flex-col gap-3">
            <ReceiptDivider />
            <div className="flex items-center justify-between text-sm">
              <span className="label-mono">{t("imported")}</span>
              <span className="font-display font-bold text-ink tnum tabular-nums">
                {created}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="label-mono">{t("totalValue")}</span>
              <Money value={result.totalValue} />
            </div>

            {result.invalidRows.length > 0 && (
              <div>
                <p className="label-mono mb-2 text-debt">
                  {t("invalidRows", { count: result.invalidRows.length })}
                </p>
                <ul className="flex flex-col gap-1.5 rounded-md border border-dashed border-debt/40 bg-panel/40 p-3">
                  {result.invalidRows.map((row) => (
                    <li key={row.line} className="text-xs text-ink-soft">
                      <span className="font-display font-bold text-debt">
                        {t("rowLabel", { line: row.line })}
                      </span>{" "}
                      {row.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
