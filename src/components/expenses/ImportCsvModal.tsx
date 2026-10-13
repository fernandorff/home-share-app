"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Modal } from "@/components/ui/Modal";
import { cn } from "@/components/ui/cn";
import { Button } from "@/components/ui/Button";
import { Field, Select } from "@/components/ui/Field";
import { Money } from "@/components/ui/Money";
import { ReceiptDivider } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { useSession } from "@/lib/session";
import { api, ApiError } from "@/lib/api";
import { useApiError } from "@/lib/api-errors";
import { todayInputValue } from "@/lib/format";
import { DEFAULT_PLATFORMS } from "@/lib/platforms";
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

/** Shortens a long file name in the middle (I10), e.g. "annual-household-e…s-2026.csv". */
function truncateMiddle(name: string, maxLen: number): string {
  if (name.length <= maxLen) return name;
  const headLen = Math.ceil((maxLen - 1) / 2);
  const tailLen = Math.floor((maxLen - 1) / 2);
  return `${name.slice(0, headLen)}…${name.slice(name.length - tailLen)}`;
}

// Mirrors the columns/format the parser (lib/csv-parser.ts) actually accepts (BL-25/U3 —
// the modal gave no hint of the required shape, so a mismatched CSV just 400'd).
const CSV_TEMPLATE =
  "description,amount,date,platform,notes\n" +
  'Grocery run,89.90,15/03/2026,Mercado Livre,"Weekly groceries"\n';
const CSV_TEMPLATE_HREF = `data:text/csv;charset=utf-8,${encodeURIComponent(CSV_TEMPLATE)}`;

export function ImportCsvModal({
  open,
  onOpenChange,
  platforms,
  onImported,
}: ImportCsvModalProps) {
  const { me, members: allMembers } = useSession();
  // Active only (BL-16) — CSV import only ever creates brand-new expenses.
  const members = allMembers.filter((m) => m.active);
  const toast = useToast();
  const t = useTranslations("Expenses");
  const tc = useTranslations("Common");
  const apiErr = useApiError();
  const tCsv = useTranslations("CsvErrors");

  const [file, setFile] = useState<File | null>(null);
  const [platform, setPlatform] = useState<string>("");
  const [payerId, setPayerId] = useState<string>("");
  const [splitEqually, setSplitEqually] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  // `fileLevel` = the error is about the CSV itself (CsvErrors code): only then is the file marked invalid.
  // Network drops, 429/500 and payer/platform errors show the same message without blaming the file.
  const [formError, setFormError] = useState<{ message: string; fileLevel: boolean } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileHintId = useId();
  const fileErrorId = useId();
  const fileErrorRef = useRef<HTMLParagraphElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  // R3-12: after an import, bring its outcome into view — on a phone the summary and the invalid
  // rows sat below the fold of the sheet while the toast faded away.
  useEffect(() => {
    if (formError) fileErrorRef.current?.scrollIntoView({ block: "nearest" });
    else if (result) resultRef.current?.scrollIntoView({ block: "start" });
  }, [result, formError]);

  // Reset state each time the modal opens; default payer = current user.
  useEffect(() => {
    if (!open) return;
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setPlatform("");
    setPayerId(me ? String(me.user.id) : "");
    setSplitEqually(true);
    setResult(null);
    setFormError(null);
  }, [open, me]);

  // `hasFile` drives the footer button styling; `canSubmit` (also !submitting) only drives
  // `disabled`, so the buttons don't swap variants while a request is in flight.
  const hasFile = file !== null;
  const canSubmit = hasFile && !submitting;

  async function handleSubmit() {
    if (!canSubmit || !file) return;
    setSubmitting(true);
    setFormError(null);
    setResult(null);

    const form = new FormData();
    form.append("file", file);
    if (platform !== "") form.append("platform", platform);
    if (payerId !== "") form.append("payerId", payerId);
    form.append("splitEqually", splitEqually ? "true" : "false");
    // The server parses in UTC, so rows without a date need OUR local "today" (else evening
    // imports land on tomorrow).
    form.append("defaultDate", todayInputValue());

    try {
      const res = await api.post<ImportResult>("/api/expenses/import", form);
      setResult(res);
      const n = createdCount(res.created);
      const skipped = res.invalidRows.length;
      toast(
        skipped > 0
          ? t("toastImportedPartial", { count: n, skipped })
          : t("toastImported", { count: n }),
        skipped > 0 ? "info" : n > 0 ? "success" : "info"
      );
      if (n > 0) onImported();
      // B2: a completed import must not leave "Import" one click away from re-importing the
      // same rows — clear the file (state + native input) so it goes back to disabled.
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err) {
      // CSV-specific failures (missing columns, empty file, no valid rows) carry a `code` translated in the
      // CsvErrors namespace; anything else falls back to ApiErrors / the generic import error.
      // Shown inline only, not also as a toast, so the error isn't repeated twice (B11).
      const code = err instanceof ApiError ? err.code : undefined;
      const fileLevel = !!code && tCsv.has(code);
      const message = fileLevel && code ? tCsv(code) : apiErr(err, t("importError"));
      setFormError({ message, fileLevel });
    } finally {
      setSubmitting(false);
    }
  }

  const created = result ? createdCount(result.created) : 0;
  const fileLevelError = formError?.fileLevel === true;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t("importTitle")}
      description={t("importDescription")}
      footer={
        <>
          <Button
            variant={hasFile ? "ghost" : "primary"}
            onClick={() => onOpenChange(false)}
          >
            {tc("close")}
          </Button>
          <Button
            variant={hasFile ? "primary" : "secondary"}
            onClick={handleSubmit}
            disabled={!canSubmit}
            loading={submitting}
          >
            {t("importButton")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={t("csvFile")} htmlFor="imp-file">
          <div className="flex flex-wrap items-center gap-3">
            {/* I10: visually hidden but still focusable/labelled — a screen reader or keyboard
                user reaches the real control by its label + aria-describedby; sighted users get
                the translated button + file name below instead of the browser's own "Choose
                file / No file chosen" strings. */}
            <input
              ref={fileInputRef}
              id="imp-file"
              type="file"
              accept=".csv"
              aria-describedby={fileLevelError ? `${fileErrorId} ${fileHintId}` : fileHintId}
              aria-invalid={fileLevelError ? true : undefined}
              className="peer sr-only"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setFormError(null); // the error belonged to the previous file (red name, aria-invalid)
              }}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              className="peer-focus-visible:ring-2 peer-focus-visible:ring-ink peer-focus-visible:ring-offset-2"
            >
              {t("chooseFile")}
            </Button>
            <span
              className={cn("min-w-0 flex-1 truncate text-sm", fileLevelError ? "text-debt" : "text-ink-soft")}
              title={file?.name}
            >
              {file ? truncateMiddle(file.name, 30) : t("noFileChosen")}
            </span>
          </div>
          {/* R3-12: an import error (a file-level one — missing columns, empty file, no valid rows — or a
              request failure) sits under the file row — it used to be the last line of the form. */}
          {formError && (
            <p id={fileErrorId} ref={fileErrorRef} role="alert" className="mt-1.5 text-pretty text-xs text-debt">
              {formError.message}
            </p>
          )}
          <p id={fileHintId} className="mt-1.5 text-pretty text-xs text-faint">
            <span className="block">{t("csvFileHint")}</span>
            <span className="mt-1 block">{t("csvColumnsHelp")}</span>
            <a
              href={CSV_TEMPLATE_HREF}
              download="expenses-template.csv"
              className="mt-1 inline-flex min-h-11 items-center text-ink-soft underline decoration-dotted underline-offset-2 hover:text-ink md:min-h-0"
            >
              {t("downloadTemplate")}
            </a>
          </p>
        </Field>

        <Field label={t("platformLabelOne")} htmlFor="imp-platform">
          <Select
            id="imp-platform"
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
          >
            <option value="">{t("noPlatform")}</option>
            {DEFAULT_PLATFORMS.map((k) => (
              <option key={k} value={k}>
                {t(`platform.${k}`)}
              </option>
            ))}
            {platforms.map((p) => (
              <option key={p.publicId} value={p.name}>
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

        {result && (
          <div ref={resultRef} className="flex flex-col gap-3">
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
                      {tCsv(row.code, row.values)}
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
