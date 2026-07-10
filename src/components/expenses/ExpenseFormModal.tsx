"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Field, Input, Textarea, Select, Label } from "@/components/ui/Field";
import { Money } from "@/components/ui/Money";
import { MemberDot } from "@/components/ui/Member";
import { ReceiptDivider } from "@/components/ui/Card";
import type { TagTone } from "@/components/ui/Stamp";
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
import {
  participantsToMasked,
  detectSplitEqually,
  equalPercents,
  distributeByPercent,
} from "@/lib/split";
import { LIMITS } from "@/lib/constants";
import { EXPENSE_CATEGORIES } from "@/lib/categories";
import { DEFAULT_PLATFORMS } from "@/lib/platforms";
import { DEFAULT_PAYMENT_METHODS } from "@/lib/payment-methods";
import type { Expense, Platform, Member, Category, PaymentMethod } from "@/lib/types";

interface ExpenseFormModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  expense?: Expense | null;
  platforms: Platform[];
  categories: Category[];
  paymentMethods: PaymentMethod[];
  onSaved: () => void;
}

type CustomMode = "valor" | "percent";

/** Selected-chip fill per tag dimension (mirrors the Tag tones; color carries the dimension). */
const CHIP_ON_TONES: Record<TagTone, string> = {
  default: "border-ink bg-ink text-paper",
  category: "border-cat bg-cat text-paper",
  platform: "border-plat bg-plat text-paper",
  payment: "border-pay bg-pay text-paper",
};

/** Toggle-chip multi-select for a tag dimension (system defaults + the house's custom entries). */
function ChipMultiSelect({
  options,
  selected,
  onToggle,
  tone = "default",
}: {
  options: { value: string; label: string }[];
  selected: Set<string>;
  onToggle: (value: string) => void;
  tone?: TagTone;
}) {
  if (options.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => {
        const on = selected.has(o.value);
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onToggle(o.value)}
            aria-pressed={on}
            className={cn(
              // Was px-2.5 py-1 (~27px tall) — D3/BL-21 flagged chips as an undersized touch target.
              "rounded-md border px-3 py-2 text-[0.72rem] font-medium transition-colors",
              on ? CHIP_ON_TONES[tone] : "border-rule bg-card text-ink-soft hover:bg-panel"
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function ExpenseFormModal({
  open,
  onOpenChange,
  expense,
  platforms,
  categories,
  paymentMethods,
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
  const [selCategories, setSelCategories] = useState<Set<string>>(new Set());
  const [selPlatforms, setSelPlatforms] = useState<Set<string>>(new Set());
  const [selPayments, setSelPayments] = useState<Set<string>>(new Set());
  const [description, setDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [amountMasked, setAmountMasked] = useState("");
  const [date, setDate] = useState(todayInputValue());
  const [splitEqually, setSplitEqually] = useState(true);
  const [customMode, setCustomMode] = useState<CustomMode>("valor");
  const [custom, setCustom] = useState<Record<number, string>>({});
  const [percent, setPercent] = useState<Record<number, number>>({});
  const [submitting, setSubmitting] = useState(false);
  // A ref (not state) guards against double-submit: state updates are batched/async, so a
  // fast double-click can re-enter handleSubmit before React re-renders with the disabled
  // button — a ref flips synchronously, closing that race.
  const submittingRef = useRef(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Unsaved-changes guard (BL-14/U9): tracks whether any field differs from what the reset effect
  // just populated. `isResettingRef` lets the dirty-tracking effect below tell "the reset effect
  // just repopulated every field" apart from "the user actually edited something" — both fire the
  // same state setters, so a plain effect on these fields alone can't tell them apart.
  const [dirty, setDirty] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const isResettingRef = useRef(false);

  function seedPercentEqual() {
    const eq = equalPercents(members.length);
    const next: Record<number, number> = {};
    members.forEach((m, i) => (next[m.id] = eq[i] ?? 0));
    setPercent(next);
  }

  const toggleTag = (setter: React.Dispatch<React.SetStateAction<Set<string>>>) => (value: string) =>
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });

  // Options for each dimension: system defaults (i18n) + the house's custom entries (raw name).
  const categoryOptions = [
    ...EXPENSE_CATEGORIES.map((k) => ({ value: k, label: t(`category.${k}`) })),
    ...categories.map((c) => ({ value: c.name, label: c.name })),
  ];
  const platformOptions = [
    ...DEFAULT_PLATFORMS.map((k) => ({ value: k, label: t(`platform.${k}`) })),
    ...platforms.map((p) => ({ value: p.name, label: p.name })),
  ];
  const paymentOptions = [
    ...DEFAULT_PAYMENT_METHODS.map((k) => ({ value: k, label: t(`payment.${k}`) })),
    ...paymentMethods.map((p) => ({ value: p.name, label: p.name })),
  ];

  useEffect(() => {
    if (!open) return;
    isResettingRef.current = true;
    setCustomMode("valor");
    if (expense) {
      setPayerId(String(expense.payerId));
      setSelCategories(new Set(expense.categories));
      setSelPlatforms(new Set(expense.platforms));
      setSelPayments(new Set(expense.paymentMethods));
      setDescription(expense.description);
      setNotes(expense.notes ?? "");
      setAmountMasked(maskAmountInput(String(toCents(expense.amount)), locale));
      setDate(toDateInputValue(expense.date));
      const equal = detectSplitEqually(expense, members);
      setSplitEqually(equal);
      setCustom(equal ? {} : participantsToMasked(expense, members, locale));
    } else {
      setPayerId(me ? String(me.user.id) : "");
      setSelCategories(new Set());
      setSelPlatforms(new Set());
      setSelPayments(new Set());
      setDescription("");
      setNotes("");
      setAmountMasked("");
      setDate(todayInputValue());
      setSplitEqually(true);
      setCustom({});
    }
    // Seed the percent map from the REAL split when editing a custom-split expense, so merely
    // toggling to "por percentual" (without editing) doesn't silently rewrite e.g. 70/30 as 50/50.
    const seeded: Record<number, number> = {};
    if (expense && !detectSplitEqually(expense, members)) {
      const total = toCents(expense.amount);
      const raw = members.map((m) => {
        const part = expense.participants.find((p) => p.userId === m.id);
        return part && total > 0 ? (toCents(part.amount) / total) * 100 : 0;
      });
      const floors = raw.map((r) => Math.floor(r));
      let rem = 100 - floors.reduce((a, b) => a + b, 0);
      raw
        .map((r, i) => ({ frac: r - Math.floor(r), i }))
        .sort((a, b) => b.frac - a.frac)
        .forEach((o) => { if (rem > 0) { floors[o.i]++; rem--; } });
      members.forEach((m, i) => (seeded[m.id] = floors[i]));
    } else {
      const eq = equalPercents(members.length);
      members.forEach((m, i) => (seeded[m.id] = eq[i] ?? 0));
    }
    setPercent(seeded);
    setFormError(null);
    setDirty(false);
  }, [open, expense, members, me, locale]);

  // Marks the form dirty on any field change that ISN'T the reset effect above repopulating them.
  useEffect(() => {
    if (isResettingRef.current) {
      isResettingRef.current = false;
      return;
    }
    setDirty(true);
  }, [
    payerId, selCategories, selPlatforms, selPayments, description, notes,
    amountMasked, date, splitEqually, custom, percent, customMode,
  ]);

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
    if (!canSubmit || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setFormError(null);

    const amount = parseAmountInput(amountMasked, locale);
    const body: Record<string, unknown> = {
      payerId: Number(payerId),
      platforms: [...selPlatforms],
      paymentMethods: [...selPayments],
      description: description.trim(),
      notes: notes.trim() === "" ? undefined : notes.trim(),
      categories: [...selCategories],
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
        // Optimistic-lock token: the server rejects with 409 STALE_EXPENSE if someone else saved
        // this expense since this form opened, instead of silently overwriting their edit.
        await api.put(`/api/expenses/${expense.publicId}`, { ...body, expectedUpdatedAt: expense.updatedAt });
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
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  // Any close attempt (✕, overlay click, Escape, Cancel button) — ask first if something would
  // be lost, instead of silently discarding an edit (BL-14/U9).
  function requestClose() {
    if (dirty) setConfirmDiscard(true);
    else onOpenChange(false);
  }
  function discardAndClose() {
    setConfirmDiscard(false);
    onOpenChange(false);
  }

  const subToggle = (mode: CustomMode, label: string) => (
    <button
      type="button"
      onClick={() => setCustomMode(mode)}
      className={cn(
        "w-full rounded-md border px-3 py-1.5 text-center text-xs font-display font-bold uppercase tracking-wide transition-colors",
        customMode === mode
          ? "border-ink bg-ink text-paper"
          : "border-rule bg-card text-ink-soft hover:bg-panel"
      )}
    >
      {label}
    </button>
  );

  return (
    <>
    <Modal
      open={open}
      onOpenChange={(o) => !o && requestClose()}
      title={isEdit ? t("editExpense") : t("newExpense")}
      footer={
        <>
          <Button variant="ghost" onClick={requestClose}>
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

        <Field label={t("categoryLabel")}>
          <ChipMultiSelect tone="category" options={categoryOptions} selected={selCategories} onToggle={toggleTag(setSelCategories)} />
        </Field>

        <Field label={t("platformLabel")}>
          <ChipMultiSelect tone="platform" options={platformOptions} selected={selPlatforms} onToggle={toggleTag(setSelPlatforms)} />
        </Field>

        <Field label={t("paymentLabel")}>
          <ChipMultiSelect tone="payment" options={paymentOptions} selected={selPayments} onToggle={toggleTag(setSelPayments)} />
        </Field>

        <Field label={t("description")} htmlFor="exp-desc" hint={`${description.length}/${LIMITS.DESCRIPTION}`}>
          <Input
            id="exp-desc"
            value={description}
            maxLength={LIMITS.DESCRIPTION}
            placeholder={t("descriptionPlaceholder")}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field
            label={t("amountLabel", { symbol: currencySymbol })}
            htmlFor="exp-amount"
            hint={t("amountHint")}
          >
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

        <Field label={t("notes")} htmlFor="exp-notes" hint={`${notes.length}/${LIMITS.NOTES}`}>
          <Textarea
            id="exp-notes"
            value={notes}
            maxLength={LIMITS.NOTES}
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
            <div className="flex items-center justify-between gap-3">
              <p className="label-mono">{t("splitBy")}</p>
              <div className="grid w-[9rem] shrink-0 grid-cols-2 gap-1.5">
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
                      {/* Input's own base class already sets w-full — putting a narrower width
                          directly on it just adds a competing class (cn() doesn't dedupe/merge
                          conflicting Tailwind utilities), so the width has to be constrained on a
                          wrapper instead. Without this, the input was winning 100% of the row's
                          width and clipping the avatar+name to a sliver. */}
                      <span className="w-28 shrink-0">
                        <Input
                          inputMode="numeric"
                          aria-label={t("amountOf", { name: m.name })}
                          value={custom[m.id] ?? ""}
                          placeholder={zeroPlaceholder}
                          className="text-right tnum tabular-nums"
                          onChange={(e) => setCustomAmount(m.id, e.target.value)}
                        />
                      </span>
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

        {formError && <p role="alert" className="text-sm text-debt">{formError}</p>}
      </div>
    </Modal>

    {/* Unsaved-changes guard (BL-14/U9) — a sibling, not nested inside the modal above */}
    <Modal
      open={confirmDiscard}
      onOpenChange={(o) => !o && setConfirmDiscard(false)}
      title={t("discardTitle")}
      footer={
        <>
          <Button variant="ghost" onClick={() => setConfirmDiscard(false)}>
            {t("keepEditing")}
          </Button>
          <Button variant="danger" onClick={discardAndClose}>
            {t("discardChanges")}
          </Button>
        </>
      }
    >
      <p className="text-sm text-ink">{t("discardPrompt")}</p>
    </Modal>
    </>
  );
}
