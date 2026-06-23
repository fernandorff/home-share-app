"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Field, Input, Textarea, Select, Label } from "@/components/ui/Field";
import { Money } from "@/components/ui/Money";
import { MemberDot } from "@/components/ui/Member";
import { ReceiptDivider } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { useToast } from "@/components/ui/Toast";
import { useSession } from "@/lib/session";
import { api } from "@/lib/api";
import { useApiError } from "@/lib/api-errors";
import {
  maskAmountInput,
  parseAmountInput,
  toDateInputValue,
  todayInputValue,
} from "@/lib/format";
import { toCents, fromCents, splitCents } from "@/lib/currency";
import { CURRENCY_META, DEFAULT_CURRENCY, isCurrency } from "@/lib/currencies";
import type { Expense, Platform, Member } from "@/lib/types";

interface ExpenseFormModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  expense?: Expense | null;
  platforms: Platform[];
  onSaved: () => void;
}

type CustomMode = "valor" | "percent";

function participantsToMasked(
  expense: Expense | null | undefined,
  members: Member[],
  locale: string
): Record<number, string> {
  const map: Record<number, string> = {};
  if (!expense) return map;
  for (const m of members) {
    const p = expense.participants.find((x) => x.userId === m.id);
    if (p) map[m.id] = maskAmountInput(String(toCents(p.amount)), locale);
  }
  return map;
}

function detectSplitEqually(expense: Expense, members: Member[]): boolean {
  const totalCents = toCents(expense.amount);
  const n = members.length;
  if (n === 0 || expense.participants.length !== n) return false;
  const expected = splitCents(totalCents, n);
  const actual = members.map((m) => {
    const p = expense.participants.find((x) => x.userId === m.id);
    return p ? toCents(p.amount) : -1;
  });
  return expected.every((c, i) => c === actual[i]);
}

/** Equal integer percentages summing to exactly 100. */
function equalPercents(n: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(100 / n);
  const arr = Array<number>(n).fill(base);
  const rem = 100 - base * n;
  for (let i = 0; i < rem; i++) arr[i] += 1;
  return arr;
}

/** Distribute totalCents by percentages with largest-remainder so it sums EXACTLY. */
function distributeByPercent(totalCents: number, percents: number[]): number[] {
  const totalPct = percents.reduce((a, b) => a + b, 0);
  if (totalPct <= 0 || totalCents <= 0) return percents.map(() => 0);
  // Naive rounding when the percentages don't add up to 100 (submit is blocked anyway).
  if (totalPct !== 100) {
    return percents.map((p) => Math.round((totalCents * p) / 100));
  }
  const raw = percents.map((p) => (totalCents * p) / 100);
  const floors = raw.map((r) => Math.floor(r));
  const remainder = totalCents - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);
  const out = [...floors];
  for (let k = 0; k < remainder && k < order.length; k++) out[order[k].i] += 1;
  return out;
}

export function ExpenseFormModal({
  open,
  onOpenChange,
  expense,
  platforms,
  onSaved,
}: ExpenseFormModalProps) {
  const { me, members, activeGroup } = useSession();
  const toast = useToast();
  const t = useTranslations("Expenses");
  const tc = useTranslations("Common");
  const apiErr = useApiError();
  const locale = useLocale();
  const isEdit = Boolean(expense);
  const currencySymbol =
    CURRENCY_META[isCurrency(activeGroup?.currency) ? activeGroup.currency : DEFAULT_CURRENCY].symbol;

  const zeroPlaceholder = maskAmountInput("0", locale);

  const [payerId, setPayerId] = useState<string>("");
  const [platformId, setPlatformId] = useState<string>("");
  const [description, setDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [amountMasked, setAmountMasked] = useState("");
  const [date, setDate] = useState(todayInputValue());
  const [splitEqually, setSplitEqually] = useState(true);
  const [customMode, setCustomMode] = useState<CustomMode>("valor");
  const [custom, setCustom] = useState<Record<number, string>>({});
  const [percent, setPercent] = useState<Record<number, number>>({});
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  function seedPercentEqual() {
    const eq = equalPercents(members.length);
    const next: Record<number, number> = {};
    members.forEach((m, i) => (next[m.id] = eq[i] ?? 0));
    setPercent(next);
  }

  useEffect(() => {
    if (!open) return;
    setCustomMode("valor");
    if (expense) {
      setPayerId(String(expense.payerId));
      setPlatformId(expense.platformId != null ? String(expense.platformId) : "");
      setDescription(expense.description);
      setNotes(expense.notes ?? "");
      setAmountMasked(maskAmountInput(String(toCents(expense.amount)), locale));
      setDate(toDateInputValue(expense.date));
      const equal = detectSplitEqually(expense, members);
      setSplitEqually(equal);
      setCustom(equal ? {} : participantsToMasked(expense, members, locale));
    } else {
      setPayerId(me ? String(me.user.id) : "");
      setPlatformId("");
      setDescription("");
      setNotes("");
      setAmountMasked("");
      setDate(todayInputValue());
      setSplitEqually(true);
      setCustom({});
    }
    const eq = equalPercents(members.length);
    const seeded: Record<number, number> = {};
    members.forEach((m, i) => (seeded[m.id] = eq[i] ?? 0));
    setPercent(seeded);
    setFormError(null);
  }, [open, expense, members, me, locale]);

  const totalCents = toCents(parseAmountInput(amountMasked, locale));

  // ---- Custom by value ----
  const customSumCents = useMemo(
    () =>
      members.reduce(
        (sum, m) => sum + toCents(parseAmountInput(custom[m.id] ?? "", locale)),
        0
      ),
    [custom, members, locale]
  );
  const diffCents = totalCents - customSumCents;
  const valorMatches = totalCents > 0 && diffCents === 0;

  // ---- Custom by percentage ----
  const totalPct = useMemo(
    () => members.reduce((sum, m) => sum + (percent[m.id] ?? 0), 0),
    [percent, members]
  );
  const percentAmounts = useMemo(() => {
    const pcts = members.map((m) => percent[m.id] ?? 0);
    return distributeByPercent(totalCents, pcts);
  }, [percent, members, totalCents]);
  const percentMatches = totalCents > 0 && totalPct === 100;

  const equalPreview = useMemo(() => {
    if (members.length === 0 || totalCents <= 0) return [];
    return splitCents(totalCents, members.length);
  }, [members.length, totalCents]);

  const customOk = customMode === "valor" ? valorMatches : percentMatches;
  const canSubmit =
    description.trim().length > 0 &&
    totalCents > 0 &&
    payerId !== "" &&
    (splitEqually || customOk) &&
    !submitting;

  function setCustomAmount(memberId: number, raw: string) {
    setCustom((prev) => ({ ...prev, [memberId]: maskAmountInput(raw, locale) }));
  }
  function setPercentValue(memberId: number, value: number) {
    setPercent((prev) => ({ ...prev, [memberId]: value }));
  }
  function fillEqualIntoCustom() {
    if (members.length === 0 || totalCents <= 0) return;
    const parts = splitCents(totalCents, members.length);
    const next: Record<number, string> = {};
    members.forEach((m, i) => (next[m.id] = maskAmountInput(String(parts[i]), locale)));
    setCustom(next);
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setFormError(null);

    const amount = parseAmountInput(amountMasked, locale);
    const body: Record<string, unknown> = {
      payerId: Number(payerId),
      platformId: platformId === "" ? null : Number(platformId),
      description: description.trim(),
      notes: notes.trim() === "" ? undefined : notes.trim(),
      amount,
      date,
      splitEqually,
    };

    if (!splitEqually) {
      if (customMode === "percent") {
        body.participants = members.map((m, i) => ({
          userId: m.id,
          amount: fromCents(percentAmounts[i]),
        }));
      } else {
        body.participants = members.map((m) => ({
          userId: m.id,
          amount: fromCents(toCents(parseAmountInput(custom[m.id] ?? "", locale))),
        }));
      }
    }

    try {
      if (isEdit && expense) {
        await api.put(`/api/expenses/${expense.publicId}`, body);
        toast(t("toastUpdated"), "success");
      } else {
        await api.post("/api/expenses", body);
        toast(t("toastCreated"), "success");
      }
      onOpenChange(false);
      onSaved();
    } catch (err) {
      const message = apiErr(err, t("saveError"));
      setFormError(message);
      toast(message, "error");
    } finally {
      setSubmitting(false);
    }
  }

  const subToggle = (mode: CustomMode, label: string) => (
    <button
      type="button"
      onClick={() => setCustomMode(mode)}
      className={cn(
        "rounded-sm border px-2.5 py-1 text-[0.68rem] font-display font-bold uppercase tracking-wide transition-colors",
        customMode === mode
          ? "border-ink bg-ink text-paper"
          : "border-rule bg-card text-ink-soft hover:bg-panel"
      )}
    >
      {label}
    </button>
  );

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? t("editExpense") : t("newExpense")}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {tc("cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit} loading={submitting}>
            {isEdit ? tc("save") : tc("add")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={t("payer")} htmlFor="exp-payer">
          <Select id="exp-payer" value={payerId} onChange={(e) => setPayerId(e.target.value)}>
            <option value="" disabled>
              {t("selectPlaceholder")}
            </option>
            {members.map((m) => (
              <option key={m.id} value={String(m.id)}>
                {m.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t("platform")} htmlFor="exp-platform">
          <Select
            id="exp-platform"
            value={platformId}
            onChange={(e) => setPlatformId(e.target.value)}
          >
            <option value="">{t("noPlatform")}</option>
            {platforms.map((p) => (
              <option key={p.id} value={String(p.id)}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t("description")} htmlFor="exp-desc" hint={`${description.length}/200`}>
          <Input
            id="exp-desc"
            value={description}
            maxLength={200}
            placeholder={t("descriptionPlaceholder")}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label={t("amountLabel", { symbol: currencySymbol })} htmlFor="exp-amount">
            <Input
              id="exp-amount"
              inputMode="numeric"
              value={amountMasked}
              placeholder={zeroPlaceholder}
              className="text-right tnum tabular-nums"
              onChange={(e) => setAmountMasked(maskAmountInput(e.target.value, locale))}
            />
          </Field>

          <Field label={t("date")} htmlFor="exp-date">
            <Input
              id="exp-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </Field>
        </div>

        <Field label={t("notes")} htmlFor="exp-notes" hint={`${notes.length}/1000`}>
          <Textarea
            id="exp-notes"
            value={notes}
            maxLength={1000}
            placeholder={t("notesPlaceholder")}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>

        <ReceiptDivider />

        {/* Split toggle */}
        <div>
          <Label>{t("split")}</Label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setSplitEqually(true)}
              className={cn(
                "flex-1 rounded-md border px-3 py-2 text-[0.74rem] font-display font-bold uppercase tracking-wide transition-colors",
                splitEqually
                  ? "border-ink bg-ink text-paper"
                  : "border-rule bg-card text-ink-soft hover:bg-panel"
              )}
            >
              {t("splitEqually")}
            </button>
            <button
              type="button"
              onClick={() => {
                setSplitEqually(false);
                const empty = members.every(
                  (m) => !custom[m.id] || parseAmountInput(custom[m.id], locale) === 0
                );
                if (empty) fillEqualIntoCustom();
                if (totalPct !== 100) seedPercentEqual();
              }}
              className={cn(
                "flex-1 rounded-md border px-3 py-2 text-[0.74rem] font-display font-bold uppercase tracking-wide transition-colors",
                !splitEqually
                  ? "border-ink bg-ink text-paper"
                  : "border-rule bg-card text-ink-soft hover:bg-panel"
              )}
            >
              {t("custom")}
            </button>
          </div>
        </div>

        {/* Equal-split preview */}
        {splitEqually && equalPreview.length > 0 && (
          <div className="rounded-md border border-dashed border-rule bg-panel/40 p-3">
            <p className="label-mono mb-2">{t("splitPreview")}</p>
            <ul className="flex flex-col gap-1.5">
              {members.map((m, i) => (
                <li key={m.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    <MemberDot colorIndex={m.colorIndex} name={m.name} size={20} />
                    <span className="truncate text-ink">{m.name}</span>
                  </span>
                  <Money value={fromCents(equalPreview[i])} />
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Custom split */}
        {!splitEqually && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <p className="label-mono">{t("splitBy")}</p>
              <div className="flex gap-1.5">
                {subToggle("valor", t("byValue"))}
                {subToggle("percent", t("byPercent"))}
              </div>
            </div>

            {customMode === "valor" ? (
              <>
                <ul className="flex flex-col gap-2">
                  {members.map((m) => (
                    <li key={m.id} className="flex items-center gap-2">
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <MemberDot colorIndex={m.colorIndex} name={m.name} size={22} />
                        <span className="truncate text-sm text-ink">{m.name}</span>
                      </span>
                      <Input
                        inputMode="numeric"
                        value={custom[m.id] ?? ""}
                        placeholder={zeroPlaceholder}
                        className="w-28 text-right tnum tabular-nums"
                        onChange={(e) => setCustomAmount(m.id, e.target.value)}
                      />
                    </li>
                  ))}
                </ul>
                <div className="flex items-center justify-between border-t border-dashed border-rule pt-2 text-sm">
                  <button
                    type="button"
                    onClick={fillEqualIntoCustom}
                    className="label-mono underline decoration-dotted hover:text-ink"
                  >
                    {t("splitEqualLink")}
                  </button>
                  <span className="flex items-center gap-2">
                    <span className="label-mono">{t("sum")}</span>
                    <Money value={fromCents(customSumCents)} />
                  </span>
                </div>
                <p className="text-xs">
                  {valorMatches ? (
                    <span className="text-credit">{t("matches")}</span>
                  ) : totalCents <= 0 ? (
                    <span className="text-faint">{t("enterTotal")}</span>
                  ) : diffCents > 0 ? (
                    <span className="text-debt">
                      {t("missing")} <Money value={fromCents(diffCents)} className="text-debt" />
                    </span>
                  ) : (
                    <span className="text-debt">
                      {t("over")} <Money value={fromCents(-diffCents)} className="text-debt" />
                    </span>
                  )}
                </p>
              </>
            ) : (
              <>
                <ul className="flex flex-col gap-3">
                  {members.map((m, i) => (
                    <li key={m.id} className="flex flex-col gap-1">
                      <div className="flex items-center justify-between gap-2 text-sm">
                        <span className="flex min-w-0 items-center gap-2">
                          <MemberDot colorIndex={m.colorIndex} name={m.name} size={22} />
                          <span className="truncate text-ink">{m.name}</span>
                        </span>
                        <span className="flex items-center gap-3">
                          <span className="tnum tabular-nums w-10 text-right text-ink-soft">
                            {percent[m.id] ?? 0}%
                          </span>
                          <Money value={fromCents(percentAmounts[i] ?? 0)} className="w-24 text-right" />
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={percent[m.id] ?? 0}
                        onChange={(e) => setPercentValue(m.id, Number(e.target.value))}
                        className="w-full accent-ink"
                        aria-label={t("percentOf", { name: m.name })}
                      />
                    </li>
                  ))}
                </ul>
                <div className="flex items-center justify-between border-t border-dashed border-rule pt-2 text-sm">
                  <button
                    type="button"
                    onClick={seedPercentEqual}
                    className="label-mono underline decoration-dotted hover:text-ink"
                  >
                    {t("equalize")}
                  </button>
                  <span className="flex items-center gap-2">
                    <span className="label-mono">{t("total")}</span>
                    <span
                      className={cn(
                        "tnum tabular-nums font-bold",
                        percentMatches ? "text-credit" : "text-debt"
                      )}
                    >
                      {totalPct}%
                    </span>
                  </span>
                </div>
                {!percentMatches && totalCents > 0 && (
                  <p className="text-xs text-debt">
                    {totalPct < 100
                      ? t("percentMissing", { pct: 100 - totalPct })
                      : t("percentOver", { pct: totalPct - 100 })}
                  </p>
                )}
                {totalCents <= 0 && (
                  <p className="text-xs text-faint">{t("enterTotal")}</p>
                )}
              </>
            )}
          </div>
        )}

        {formError && <p className="text-sm text-debt">{formError}</p>}
      </div>
    </Modal>
  );
}
