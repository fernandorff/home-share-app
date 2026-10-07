"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Field, Input, Textarea, Select, Label } from "@/components/ui/Field";
import { Money } from "@/components/ui/Money";
import { MemberDot } from "@/components/ui/Member";
import { ReceiptDivider } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { MultiSelect } from "@/components/ui/MultiSelect";
import { useToast } from "@/components/ui/Toast";
import { useSession } from "@/lib/session";
import { api, ApiError } from "@/lib/api";
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
  seedPercentFromExpense,
  clampPercentInput,
} from "@/lib/split";
import { LIMITS } from "@/lib/constants";
import { EXPENSE_CATEGORIES } from "@/lib/categories";
import { DEFAULT_PLATFORMS } from "@/lib/platforms";
import { DEFAULT_PAYMENT_METHODS } from "@/lib/payment-methods";
import type { Expense, Platform, Category, PaymentMethod, Member } from "@/lib/types";

interface ExpenseFormModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  expense?: Expense | null;
  platforms: Platform[];
  categories: Category[];
  paymentMethods: PaymentMethod[];
  onSaved: () => void;
}

type CustomMode = "amount" | "percent";

function customOptions(entries: Array<Category | Platform | PaymentMethod>) {
  return [...new Map(entries.map((entry) => [entry.name, entry])).values()]
    .map((entry) => ({ value: entry.name, label: entry.name }));
}

/** Equal integer percentages (largest-remainder) mapped onto each member's id. */
function equalPercentMap(members: Member[]): Record<number, number> {
  const eq = equalPercents(members.length);
  const next: Record<number, number> = {};
  members.forEach((m, i) => (next[m.id] = eq[i] ?? 0));
  return next;
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
  const { me, members: allMembers, activeGroup } = useSession();
  // Active members only (BL-16) — an ex-member can't be assigned to a new expense. Editing an
  // expense that already involves an ex-member (payer or participant) keeps them selectable for
  // THIS expense only — grandfathered in, not offered for anything new. Every `members` reference
  // below intentionally uses this filtered list, not the raw session one.
  const members = useMemo(() => {
    if (!expense) return allMembers.filter((m) => m.active);
    const involvedIds = new Set([expense.payerId, ...expense.participants.map((p) => p.userId)]);
    return allMembers.filter((m) => m.active || involvedIds.has(m.id));
  }, [allMembers, expense]);
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
  const [createdCategories, setCreatedCategories] = useState<Category[]>([]);
  const [createdPlatforms, setCreatedPlatforms] = useState<Platform[]>([]);
  const [createdPayments, setCreatedPayments] = useState<PaymentMethod[]>([]);
  const [description, setDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [amountMasked, setAmountMasked] = useState("");
  const [date, setDate] = useState(todayInputValue());
  const [splitEqually, setSplitEqually] = useState(true);
  const [customMode, setCustomMode] = useState<CustomMode>("amount");
  const [custom, setCustom] = useState<Record<number, string>>({});
  const [percent, setPercent] = useState<Record<number, number>>({});
  const [submitting, setSubmitting] = useState(false);
  // A ref (not state) guards against double-submit: state updates are batched/async, so a
  // fast double-click can re-enter handleSubmit before React re-renders with the disabled
  // button — a ref flips synchronously, closing that race.
  const submittingRef = useRef(false);
  const [formError, setFormError] = useState<string | null>(null);
  // B12: a stale-expense (409) save error gets a "Load latest" recovery action instead of a toast;
  // any other save error keeps today's inline + toast behavior.
  const [staleError, setStaleError] = useState(false);
  const [loadingLatest, setLoadingLatest] = useState(false);
  const loadingLatestRef = useRef(false);
  // Optimistic-lock token sent back on save. Tracked separately from the `expense` prop (owned by
  // the parent) so "Load latest" can refresh it without being able to mutate that prop.
  const [lockToken, setLockToken] = useState<string | undefined>(undefined);

  // Unsaved-changes guard (BL-14/U9): tracks whether any field differs from what the reset effect
  // just populated. `isResettingRef` lets the dirty-tracking effect below tell "the reset effect
  // just repopulated every field" apart from "the user actually edited something" — both fire the
  // same state setters, so a plain effect on these fields alone can't tell them apart.
  const [dirty, setDirty] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const isResettingRef = useRef(false);

  // Round-1 fix #1: identifies the current "form session" — bumped by the reset-on-open effect
  // below every time it runs (open, close, or a reseed triggered by expense/members/me/locale
  // changing), plus which expense it's for. `loadLatest` snapshots both before its GET and
  // re-checks them after, so a response landing once the form has moved on (modal closed, or
  // reopened for the same or a different expense) can't silently overwrite what's on screen.
  const sessionRef = useRef(0);
  const sessionTargetRef = useRef<string | undefined>(undefined);

  function seedPercentEqual() {
    setPercent(equalPercentMap(members));
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
    ...customOptions([...categories, ...createdCategories]),
  ];
  const platformOptions = [
    ...DEFAULT_PLATFORMS.map((k) => ({ value: k, label: t(`platform.${k}`) })),
    ...customOptions([...platforms, ...createdPlatforms]),
  ];
  const paymentOptions = [
    ...DEFAULT_PAYMENT_METHODS.map((k) => ({ value: k, label: t(`payment.${k}`) })),
    ...customOptions([...paymentMethods, ...createdPayments]),
  ];

  async function createTag(kind: "category" | "platform" | "payment", name: string) {
    try {
      if (kind === "category") {
        const { category } = await api.post<{ category: Category }>("/api/categories", { name });
        setCreatedCategories((previous) => [...previous, category]);
        setSelCategories((previous) => new Set(previous).add(category.name));
      } else if (kind === "platform") {
        const { platform } = await api.post<{ platform: Platform }>("/api/platforms", { name });
        setCreatedPlatforms((previous) => [...previous, platform]);
        setSelPlatforms((previous) => new Set(previous).add(platform.name));
      } else {
        const { paymentMethod } = await api.post<{ paymentMethod: PaymentMethod }>("/api/payment-methods", { name });
        setCreatedPayments((previous) => [...previous, paymentMethod]);
        setSelPayments((previous) => new Set(previous).add(paymentMethod.name));
      }
    } catch (error) {
      toast(apiErr(error, t("createTagError")), "error");
      throw error;
    }
  }

  useEffect(() => {
    // Round-1 fix #1: see `sessionRef` above.
    sessionRef.current += 1;
    sessionTargetRef.current = expense?.publicId;
    if (!open) return;
    isResettingRef.current = true;
    setCustomMode("amount");
    setLockToken(expense?.updatedAt);
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
      // Seed the percent map from the REAL split when editing a custom-split expense, so merely
      // toggling to "by percent" (without editing) doesn't silently rewrite e.g. 70/30 as 50/50.
      setPercent(equal ? equalPercentMap(members) : seedPercentFromExpense(expense, members));
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
      setPercent(equalPercentMap(members));
    }
    setFormError(null);
    setStaleError(false);
    setDirty(false);
  }, [open, expense, members, me, locale]);

  // B12: refetches the expense after a 409 STALE_EXPENSE and resets the form (fields + the
  // optimistic-lock token) from the current row, without closing the modal or losing the edit UI.
  async function loadLatest() {
    if (!expense || loadingLatestRef.current) return;
    loadingLatestRef.current = true;
    setLoadingLatest(true);
    // Round-1 fix #1: snapshot the session/target this call is for, before the await.
    const session = sessionRef.current;
    const targetPublicId = expense.publicId;
    try {
      const { expense: latest } = await api.get<{ expense: Expense }>(`/api/expenses/${targetPublicId}`);
      // Staleness guard: the modal may have closed, or reopened for the same or a different
      // expense, while this GET was in flight. Applying it now would silently overwrite whatever
      // the user is looking at (or typing) now — bail without touching any state.
      if (sessionRef.current !== session || sessionTargetRef.current !== targetPublicId) return;
      isResettingRef.current = true;
      setPayerId(String(latest.payerId));
      setSelCategories(new Set(latest.categories));
      setSelPlatforms(new Set(latest.platforms));
      setSelPayments(new Set(latest.paymentMethods));
      setDescription(latest.description);
      setNotes(latest.notes ?? "");
      setAmountMasked(maskAmountInput(String(toCents(latest.amount)), locale));
      setDate(toDateInputValue(latest.date));
      const equal = detectSplitEqually(latest, members);
      setSplitEqually(equal);
      setCustom(equal ? {} : participantsToMasked(latest, members, locale));
      setPercent(equal ? equalPercentMap(members) : seedPercentFromExpense(latest, members));
      setLockToken(latest.updatedAt);
      setFormError(null);
      setStaleError(false);
      setDirty(false);
    } catch (err) {
      // Same staleness guard: don't toast an error for a session the user has already left.
      if (sessionRef.current === session && sessionTargetRef.current === targetPublicId) {
        toast(apiErr(err, t("saveError")), "error");
      }
    } finally {
      loadingLatestRef.current = false;
      setLoadingLatest(false);
    }
  }

  // Round-1 fix #2: move focus to "Load latest" the moment the stale-conflict error appears — at
  // that point it's the only useful action (Save would just fail again against the same 409).
  useEffect(() => {
    if (staleError) document.getElementById("exp-load-latest")?.focus();
  }, [staleError]);

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
  const amountMatches = totalCents > 0 && diffCents === 0;

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

  const customOk = customMode === "amount" ? amountMatches : percentMatches;
  const canSubmit =
    description.trim().length > 0 &&
    totalCents > 0 &&
    payerId !== "" &&
    (splitEqually || customOk) &&
    !submitting &&
    !loadingLatest;
  // U3 / round-1 fix #3: the reason a custom split (either mode) blocks Add/Save — rendered via
  // `mismatchReason` below, under TOTAL and in the modal footer (always visible).
  const customMismatch = !splitEqually && !customOk && totalCents > 0;
  // R3-05: the reason as a node — shown under TOTAL (next to the numbers it explains) and repeated in
  // the always-visible footer (round-1 fix #3: still readable when the member list is scrolled).
  const mismatchReason = !customMismatch
    ? null
    : customMode === "amount"
    ? diffCents > 0
      ? <>{t("missing")} <Money value={fromCents(diffCents)} className="text-debt" /></>
      : <>{t("over")} <Money value={fromCents(-diffCents)} className="text-debt" /></>
    : totalPct < 100
    ? t("percentMissing", { pct: 100 - totalPct })
    : t("percentOver", { pct: totalPct - 100 });

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
      // Sanity guard, NOT the source of truth for the house (that's always the cookie server-side):
      // if the active house changed in another tab while this form was open, the server rejects with
      // 409 instead of silently saving into the wrong house (found in QA). See requireActiveGroup.
      expectedGroupId: activeGroup?.id,
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
        // this expense since this form opened, instead of silently overwriting their edit. Sent
        // from `lockToken` (not `expense.updatedAt` directly) so "Load latest" can refresh it.
        await api.put(`/api/expenses/${expense.publicId}`, { ...body, expectedUpdatedAt: lockToken });
        toast(t("toastUpdated"), "success");
      } else {
        await api.post("/api/expenses", body);
        toast(t("toastCreated"), "success");
      }
      onOpenChange(false);
      onSaved();
    } catch (err) {
      const stale = err instanceof ApiError && err.code === "STALE_EXPENSE";
      const message = apiErr(err, t("saveError"));
      setFormError(message);
      setStaleError(stale);
      // B12: the stale-expense case only shows inline (with its own "Load latest" action) — no
      // duplicate toast. Every other save error keeps the existing inline + toast behavior.
      if (!stale) toast(message, "error");
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
      aria-pressed={customMode === mode}
      className={cn(
        "flex min-h-11 w-full items-center justify-center whitespace-nowrap rounded-md border px-3 py-1.5 text-center text-xs font-display font-bold uppercase tracking-wide transition-colors md:min-h-0",
        customMode === mode
          ? "border-ink bg-ink text-paper"
          : "border-rule bg-card text-ink-soft hover:bg-panel"
      )}
    >
      {label}
    </button>
  );

  const actionButtons = (
    <>
      <Button variant="ghost" onClick={requestClose}>
        {tc("cancel")}
      </Button>
      <Button onClick={handleSubmit} disabled={!canSubmit} loading={submitting}>
        {isEdit ? tc("save") : tc("add")}
      </Button>
    </>
  );

  return (
    <>
    <Modal
      open={open}
      onOpenChange={(o) => !o && requestClose()}
      title={isEdit ? t("editExpense") : t("newExpense")}
      footer={
        formError ? (
          // Round-1 fix #2: the save error (incl. the stale-conflict case and its "Load latest"
          // recovery action) lives in this always-visible footer slot, never the scrollable body.
          // Round-2 fix: the message always gets its own full-width row above the buttons, so it
          // never gets squeezed into a narrow column next to Load latest / Cancel / Save.
          <div className="flex w-full flex-col gap-3">
            <p role="alert" className="text-sm text-debt">{formError}</p>
            {/* R3-10: in the stale-conflict state Save is not offered (it can only fail with the same
                409 until the latest version is loaded) — Load latest takes its place next to Cancel,
                one row instead of two (the footer took ~21% of a 390px screen). flex-wrap: the fr
                label is long. */}
            <div className="flex flex-wrap justify-end gap-2">
              {staleError ? (
                <>
                  <Button variant="ghost" onClick={requestClose}>
                    {tc("cancel")}
                  </Button>
                  <Button type="button" id="exp-load-latest" loading={loadingLatest} onClick={loadLatest}>
                    {t("loadLatest")}
                  </Button>
                </>
              ) : (
                actionButtons
              )}
            </div>
          </div>
        ) : customMismatch ? (
          <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-debt">{mismatchReason}</p>
            <div className="flex justify-end gap-2">{actionButtons}</div>
          </div>
        ) : (
          actionButtons
        )
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

        <Field label={t("description")} htmlFor="exp-desc" hint={`${description.length}/${LIMITS.DESCRIPTION}`}>
          <Input
            id="exp-desc"
            value={description}
            maxLength={LIMITS.DESCRIPTION}
            placeholder={t("descriptionPlaceholder")}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>

        {/* R2-04: stacked below 380px — at 360 the half-width native date input cut the year
            ("03/10/202"). Stacked, the date moves last so the amount hint stays under Amount. */}
        <div className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2">
          <Field label={t("amountLabel", { symbol: currencySymbol })} htmlFor="exp-amount">
            <Input
              id="exp-amount"
              inputMode="numeric"
              value={amountMasked}
              placeholder={zeroPlaceholder}
              aria-describedby="exp-amount-hint"
              className="text-right tnum tabular-nums"
              onChange={(e) => setAmountMasked(maskAmountInput(e.target.value, locale))}
            />
          </Field>

          <div className="max-[379px]:order-last">
            <Field label={t("date")} htmlFor="exp-date">
              <Input
                id="exp-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </Field>
          </div>

          {/* D17: full-width row below Amount/Date instead of squeezed into the Amount half. */}
          <p id="exp-amount-hint" className="text-pretty text-xs text-faint min-[380px]:col-span-2">
            {t("amountHint")}
          </p>
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
              aria-pressed={splitEqually}
              className={cn(
                "flex min-h-11 flex-1 items-center justify-center rounded-md border px-3 py-2 text-[0.75rem] font-display font-bold uppercase tracking-wide transition-colors md:min-h-0",
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
              aria-pressed={!splitEqually}
              className={cn(
                "flex min-h-11 flex-1 items-center justify-center rounded-md border px-3 py-2 text-[0.75rem] font-display font-bold uppercase tracking-wide transition-colors md:min-h-0",
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
              <div className="grid shrink-0 grid-cols-2 gap-1.5">
                {subToggle("amount", t("byValue"))}
                {subToggle("percent", t("byPercent"))}
              </div>
            </div>

            {customMode === "amount" ? (
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
                    className="label-mono inline-flex min-h-11 items-center underline decoration-dotted hover:text-ink md:min-h-0"
                  >
                    {t("equalize")}
                  </button>
                  <span className="flex items-center gap-2">
                    <span className="label-mono">{t("total")}</span>
                    <Money
                      value={fromCents(customSumCents)}
                      // R2-16: same rule as the % mode — the total takes the state color.
                      className={customMismatch ? "text-debt" : amountMatches ? "text-credit" : undefined}
                    />
                  </span>
                </div>
                {/* R3-05: the reason sits right under TOTAL, where "Matches ✓" appears (the footer repeats it). */}
                {customMismatch && <p className="text-xs text-debt">{mismatchReason}</p>}
                {(amountMatches || totalCents <= 0) && (
                  <p className="text-xs">
                    {amountMatches ? (
                      <span className="text-credit">{t("matches")}</span>
                    ) : (
                      <span className="text-faint">{t("enterTotal")}</span>
                    )}
                  </p>
                )}
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
                          <span className="flex items-center gap-1">
                            {/* U21: type the percentage; the slider below stays in sync (same state).
                                text-base below sm avoids the iOS zoom-on-focus; min-h-11 is the mobile
                                touch floor. */}
                            <input
                              type="text"
                              inputMode="numeric"
                              pattern="[0-9]*"
                              maxLength={3}
                              value={String(percent[m.id] ?? 0)}
                              onChange={(e) => setPercentValue(m.id, clampPercentInput(e.target.value))}
                              onFocus={(e) => e.currentTarget.select()}
                              aria-label={t("percentOf", { name: m.name })}
                              className="min-h-11 w-12 rounded-md border border-rule bg-card px-1.5 text-right text-base text-ink tnum tabular-nums outline-none focus:border-ink focus:ring-1 focus:ring-ink sm:text-sm md:min-h-0 md:py-1"
                            />
                            <span className="text-ink-soft" aria-hidden>%</span>
                          </span>
                          <Money value={fromCents(percentAmounts[i] ?? 0)} className="w-24 text-right" />
                        </span>
                      </div>
                      {/* R3-09: 44px hit area below md (24px from md) — the native track stays thin and centered. */}
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={percent[m.id] ?? 0}
                        onChange={(e) => setPercentValue(m.id, Number(e.target.value))}
                        className="h-11 w-full cursor-pointer accent-ink md:h-6"
                        aria-label={t("percentSliderOf", { name: m.name })}
                      />
                    </li>
                  ))}
                </ul>
                <div className="flex items-center justify-between border-t border-dashed border-rule pt-2 text-sm">
                  <button
                    type="button"
                    onClick={seedPercentEqual}
                    className="label-mono inline-flex min-h-11 items-center underline decoration-dotted hover:text-ink md:min-h-0"
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
                {/* R3-05: the reason sits right under TOTAL, where "Matches ✓" appears (the footer repeats it). */}
                {customMismatch && <p className="text-xs text-debt">{mismatchReason}</p>}
                {totalCents <= 0 && (
                  <p className="text-xs text-faint">{t("enterTotal")}</p>
                )}
                {/* R2-16: "Matches ✓" in both modes (Amount already shows it). */}
                {percentMatches && (
                  <p className="text-xs">
                    <span className="text-credit">{t("matches")}</span>
                  </p>
                )}
              </>
            )}
          </div>
        )}

        <Field label={t("categoryLabel")}>
          <MultiSelect tone="category" options={categoryOptions} selected={selCategories} onToggle={toggleTag(setSelCategories)} placeholder={t("selectPlaceholder")} searchPlaceholder={t("searchTags")} searchLabel={t("searchCategoriesLabel")} createLabel={(name) => t("createTag", { name })} onCreate={(name) => createTag("category", name)} />
        </Field>

        <Field label={t("platformLabel")}>
          <MultiSelect tone="platform" options={platformOptions} selected={selPlatforms} onToggle={toggleTag(setSelPlatforms)} placeholder={t("selectPlaceholder")} searchPlaceholder={t("searchTags")} searchLabel={t("searchPlatformsLabel")} createLabel={(name) => t("createTag", { name })} onCreate={(name) => createTag("platform", name)} />
        </Field>

        <Field label={t("paymentLabel")}>
          <MultiSelect tone="payment" options={paymentOptions} selected={selPayments} onToggle={toggleTag(setSelPayments)} placeholder={t("selectPlaceholder")} searchPlaceholder={t("searchTags")} searchLabel={t("searchPaymentsLabel")} createLabel={(name) => t("createTag", { name })} onCreate={(name) => createTag("payment", name)} />
        </Field>
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
