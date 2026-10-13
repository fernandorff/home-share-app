"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Field, Input, Label, Select } from "@/components/ui/Field";
import { MemberDot } from "@/components/ui/Member";
import { ReceiptDivider } from "@/components/ui/Card";
import { Tag } from "@/components/ui/Stamp";
import { cn } from "@/components/ui/cn";
import { useToast } from "@/components/ui/Toast";
import { useSession } from "@/lib/session";
import { api, ApiError } from "@/lib/api";
import { useApiError } from "@/lib/api-errors";
import { maskAmountInput, parseAmountInput } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { fromCents, toCents } from "@/lib/currency";
import { DEFAULT_CURRENCY } from "@/lib/currencies";
import { LIMITS } from "@/lib/constants";
import { localToday } from "@/lib/recurrence";
import {
  DAY_MAX,
  DAY_MIN,
  browserTimeZone,
  buildRuleBody,
  closesOnError,
  dayHintKey,
  dueDateLabel,
  equalShareCents,
  fieldForErrorCode,
  parseDayInput,
  previewFirstPosting,
  previewPostingKey,
  ruleFormDirty,
  stepDay,
  type RecurringFormField,
  type RuleFormValues,
} from "@/lib/recurring-view";
import type { Member, RecurringExpense, RecurringListResponse, RecurringSaveResponse } from "@/lib/types";

type FormValues = RuleFormValues;
type SplitMode = RecurringExpense["splitMode"];

// POC default: the 5th (rent is usually due early in the month).
const DEFAULT_DAY = 5;

function valuesOf(rule: RecurringExpense | null, meId: number | undefined, activeIds: number[], locale: string): FormValues {
  const day = rule?.dayOfMonth ?? DEFAULT_DAY;
  return {
    description: rule?.description ?? "",
    amountMasked: rule ? maskAmountInput(String(toCents(rule.amount)), locale) : "",
    day,
    dayText: String(day),
    payerId: rule ? String(rule.payerId) : meId !== undefined ? String(meId) : "",
    splitMode: rule?.splitMode ?? "ALL",
    picked: rule?.splitMode === "SELECTED" ? rule.participantIds : activeIds,
  };
}

/**
 * Create or edit a recurring rule (spec 008, task 18; criteria 1, 16, 22). The page remounts it (a new `key`)
 * every time it opens, so its state always starts from `rule`. An edit sends `expectedUpdatedAt`; a 409
 * STALE_RECURRING_EXPENSE offers "Load latest" (B12 pattern of the expense form). Closing a filled form asks
 * first (BL-14/U9, the expense form's confirmation).
 */
export function RecurringExpenseFormModal({
  open,
  onOpenChange,
  rule,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The rule to edit; null creates one. */
  rule: RecurringExpense | null;
  /** Something was saved (or reloaded): the page refetches its list. */
  onChanged: () => void;
}) {
  const t = useTranslations("Recurring");
  const te = useTranslations("Expenses");
  const thh = useTranslations("Household");
  const tacc = useTranslations("Account");
  const tApi = useTranslations("ApiErrors");
  const apiErr = useApiError();
  const toast = useToast();
  const locale = useLocale();
  const { me, members: allMembers, activeGroup } = useSession();
  const currency = activeGroup?.currency ?? DEFAULT_CURRENCY;

  const activeIds = useMemo(() => allMembers.filter((m) => m.active).map((m) => m.id), [allMembers]);
  // Active members, plus the rule's own ex-members on an edit (so the form shows what the rule says; resume
  // then asks for active people — RECURRING_MEMBER_INACTIVE).
  const members = useMemo(() => {
    const involved = new Set(rule ? [rule.payerId, ...rule.participantIds] : []);
    return allMembers.filter((m) => m.active || involved.has(m.id));
  }, [allMembers, rule]);

  // What the form opened with (or Load latest last reseeded it with): the unsaved-changes guard compares to it.
  const [pristine, setPristine] = useState<FormValues>(() => valuesOf(rule, me?.user.id, activeIds, locale));
  const [values, setValues] = useState<FormValues>(pristine);
  // The version being edited (refreshed by Load latest): its token, ledger and skips feed the preview.
  const [base, setBase] = useState<RecurringExpense | null>(rule);
  // "Today" in the rule's zone (an edit) or the browser's (a new rule — criterion 22), fixed while open.
  const [today] = useState(() => localToday(rule?.timezone ?? browserTimeZone(), new Date()));
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<RecurringFormField, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [staleError, setStaleError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Synchronous double-submit guard (state updates are batched; a fast double tap re-enters otherwise).
  const submittingRef = useRef(false);
  const reseeded = useRef(false); // set by a successful Load latest, read by the focus effect
  const [loadingLatest, setLoadingLatest] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const { description, amountMasked, day, dayText, payerId, splitMode, picked } = values;
  const lockToken = base?.updatedAt;

  function update<K extends keyof FormValues>(key: K, value: FormValues[K], field?: RecurringFormField) {
    setValues((previous) => ({ ...previous, [key]: value }));
    if (field) setFieldErrors((previous) => (previous[field] ? { ...previous, [field]: undefined } : previous));
  }
  const setDay = (next: number) => setValues((previous) => ({ ...previous, day: next, dayText: String(next) }));
  const setSplitMode = (mode: SplitMode) => update("splitMode", mode, "split");
  const togglePick = (id: number) =>
    update("picked", picked.includes(id) ? picked.filter((p) => p !== id) : [...picked, id], "split");

  function onDayText(raw: string) {
    const digits = raw.replace(/\D/g, "").slice(0, 2);
    const parsed = parseDayInput(digits);
    setValues((previous) => ({ ...previous, dayText: digits, day: parsed ?? previous.day }));
    setFieldErrors((previous) => (previous.day ? { ...previous, day: undefined } : previous));
  }

  const memberLabel = (m: Member) =>
    m.deleted ? tacc("deletedUserLabel") : m.active ? m.name : thh("exMemberLabel", { name: m.name });
  const money = (cents: number) => formatMoney(fromCents(cents), currency, locale);

  // Live preview (criterion 22): the same recurrence rules and integer-cents split the poster uses.
  const amountCents = toCents(parseAmountInput(amountMasked, locale));
  const count = splitMode === "ALL" ? activeIds.length : picked.length;
  const share = equalShareCents(amountCents, count);
  const firstPosting = previewFirstPosting({
    dayOfMonth: day,
    today,
    // A paused rule restarts at the resume day, like a new one.
    activeFrom: base && !base.paused ? base.activeFrom : today,
    lastClosedPeriod: base?.lastClosedPeriod ?? null,
    skippedPeriods: base?.skippedPeriods ?? [],
  });

  // An edit shows the rule's next posting (or nothing while it is paused); a new rule its first one.
  const postingKey = previewPostingKey(rule ? base : null);

  const canSubmit =
    description.trim().length > 0 && amountCents > 0 && payerId !== "" && count > 0 && !submitting && !loadingLatest;
  const dirty = ruleFormDirty(pristine, values);

  async function handleSubmit() {
    if (!canSubmit || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setFormError(null);
    setStaleError(false);
    setFieldErrors({});

    const fields = { ...values, amountCents };

    try {
      if (rule) {
        const res = await api.patch<RecurringSaveResponse>(
          `/api/recurring-expenses/${rule.publicId}`,
          buildRuleBody(fields, { mode: "edit", groupId: activeGroup?.id, lockToken })
        );
        toast(res.postedNow > 0 ? t("toast.savedPostedNow", { name: res.rule.description }) : t("toast.saved"), "success");
      } else {
        const res = await api.post<RecurringSaveResponse>("/api/recurring-expenses", buildRuleBody(fields, {
          mode: "create",
          groupId: activeGroup?.id,
          timezone: browserTimeZone(),
        }));
        const name = res.rule.description;
        toast(
          res.postedNow > 0
            ? t("toast.createdPostedToday", { name })
            : t("toast.created", { name, day: res.rule.dayOfMonth, date: dueDateLabel(res.rule.upcoming[0]?.dueOn ?? firstPosting) }),
          "success"
        );
      }
      onOpenChange(false);
      onChanged();
    } catch (err) {
      const stale = err instanceof ApiError && err.code === "STALE_RECURRING_EXPENSE";
      const message = apiErr(err, t("saveError"));
      const field = err instanceof ApiError ? fieldForErrorCode(err.code) : null;
      if (err instanceof ApiError && closesOnError(err.code)) {
        // Deleted elsewhere (404) or no longer the viewer's (403): saving again cannot work. Close and resync.
        toast(message, "error");
        onOpenChange(false);
        onChanged();
      } else if (field) {
        setFieldErrors({ [field]: message });
      } else {
        setFormError(message);
        setStaleError(stale);
        // The stale case is only inline, next to its own recovery action.
        if (!stale) toast(message, "error");
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  // After a 409: reseed the form (fields + token) from the rule as it is now, without closing it.
  async function loadLatest() {
    if (!rule || loadingLatest) return;
    setLoadingLatest(true);
    try {
      const { rules } = await api.get<RecurringListResponse>("/api/recurring-expenses");
      const latest = rules.find((r) => r.publicId === rule.publicId);
      if (latest) {
        const next = valuesOf(latest, me?.user.id, activeIds, locale);
        setValues(next);
        setPristine(next);
        setBase(latest);
        setFormError(null);
        setStaleError(false);
        reseeded.current = true;
      } else {
        toast(tApi("RECURRING_NOT_FOUND"), "error");
        onOpenChange(false);
      }
      onChanged();
    } catch (err) {
      toast(apiErr(err, t("saveError")), "error");
    } finally {
      setLoadingLatest(false);
    }
  }

  // Load latest is the only useful action once the stale error shows (Save would hit the same 409): focus it.
  // After a reseed that button unmounts with the footer swap, so focus goes back to the form.
  useEffect(() => {
    if (staleError) document.getElementById("rec-load-latest")?.focus();
    else if (reseeded.current) {
      reseeded.current = false;
      document.getElementById("rec-desc")?.focus();
    }
  }, [staleError]);

  // Any close attempt (✕, overlay, Escape, Cancel) asks first when something would be lost (BL-14/U9).
  function requestClose() {
    if (dirty) setConfirmDiscard(true);
    else onOpenChange(false);
  }
  function discardAndClose() {
    setConfirmDiscard(false);
    onOpenChange(false);
  }

  const actionButtons = (
    <>
      <Button variant="ghost" onClick={requestClose}>
        {t("form.cancel")}
      </Button>
      <Button onClick={handleSubmit} disabled={!canSubmit} loading={submitting}>
        {rule ? t("form.save") : t("form.create")}
      </Button>
    </>
  );

  const segment = (active: boolean) =>
    cn(
      "flex min-h-11 flex-1 items-center justify-center rounded-md border px-3 py-2 text-[0.75rem] font-display font-bold uppercase tracking-wide transition-colors md:min-h-0",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-stamp",
      active ? "border-ink bg-ink text-paper" : "border-rule bg-card text-ink-soft hover:bg-panel"
    );
  const stepper =
    "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-ink bg-card font-display text-lg font-bold leading-none text-ink transition-colors hover:bg-panel aria-disabled:cursor-default aria-disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-card";

  return (
    <>
    <Modal
      open={open}
      onOpenChange={(o) => !o && requestClose()}
      title={rule ? t("form.editTitle") : t("form.createTitle")}
      footer={
        formError ? (
          // The save error has its own full-width row above the buttons (always visible, never scrolled away).
          <div className="flex w-full flex-col gap-3">
            <p role="alert" className="text-sm text-debt">{formError}</p>
            <div className="flex flex-wrap justify-end gap-2">
              {staleError ? (
                <>
                  <Button variant="ghost" onClick={requestClose}>
                    {t("form.cancel")}
                  </Button>
                  <Button id="rec-load-latest" loading={loadingLatest} onClick={loadLatest}>
                    {te("loadLatest")}
                  </Button>
                </>
              ) : (
                actionButtons
              )}
            </div>
          </div>
        ) : (
          actionButtons
        )
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label={t("form.description")}
          htmlFor="rec-desc"
          hint={`${description.length}/${LIMITS.DESCRIPTION}`}
          error={fieldErrors.description}
        >
          <Input
            id="rec-desc"
            value={description}
            maxLength={LIMITS.DESCRIPTION}
            placeholder={t("form.descriptionHint")}
            autoComplete="off"
            onChange={(e) => update("description", e.target.value, "description")}
          />
        </Field>

        <Field label={t("form.amount")} htmlFor="rec-amount" error={fieldErrors.amount}>
          <Input
            id="rec-amount"
            inputMode="numeric"
            value={amountMasked}
            placeholder={maskAmountInput("0", locale)}
            className="text-right tnum tabular-nums"
            onChange={(e) => update("amountMasked", maskAmountInput(e.target.value, locale), "amount")}
          />
        </Field>

        {/* Day of month: − / typed value / +. The hint explains the last-day clamp above 28. */}
        <div className="flex flex-col">
          <Label htmlFor="rec-day">{t("form.day")}</Label>
          <div role="group" aria-label={t("form.day")} className="flex items-center gap-2">
            {/* aria-disabled, not disabled: a button disabled under focus drops focus to <body>; stepDay clamps. */}
            <button
              type="button"
              className={stepper}
              aria-label={t("form.dayDecrease")}
              aria-disabled={day <= DAY_MIN}
              onClick={() => setDay(stepDay(day, -1))}
            >
              −
            </button>
            <input
              id="rec-day"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={2}
              value={dayText}
              aria-describedby="rec-day-hint"
              aria-invalid={fieldErrors.day ? true : undefined}
              onChange={(e) => onDayText(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              onBlur={() => setDay(day)}
              className="h-11 w-16 rounded-md border border-rule bg-card text-center font-display text-lg font-bold text-ink tnum tabular-nums outline-none transition-colors focus:border-ink focus:ring-1 focus:ring-ink aria-invalid:border-debt"
            />
            <button
              type="button"
              className={stepper}
              aria-label={t("form.dayIncrease")}
              aria-disabled={day >= DAY_MAX}
              onClick={() => setDay(stepDay(day, 1))}
            >
              +
            </button>
          </div>
          {fieldErrors.day ? (
            <p id="rec-day-hint" role="alert" className="mt-1.5 text-pretty text-xs text-debt">{fieldErrors.day}</p>
          ) : (
            <p id="rec-day-hint" className="mt-1.5 text-pretty text-xs text-faint">{t(dayHintKey(day), { day })}</p>
          )}
        </div>

        <Field label={t("form.payer")} htmlFor="rec-payer" error={fieldErrors.payer}>
          <Select id="rec-payer" value={payerId} onChange={(e) => update("payerId", e.target.value, "payer")}>
            <option value="" disabled>
              {te("selectPlaceholder")}
            </option>
            {members.map((m) => (
              <option key={m.id} value={String(m.id)}>
                {memberLabel(m)}
              </option>
            ))}
          </Select>
        </Field>

        <ReceiptDivider />

        {/* A group of buttons, not one control: labelled and described by hand (a <label> needs a control). */}
        <div
          role="group"
          aria-labelledby="rec-split-label"
          aria-describedby={fieldErrors.split ? "rec-split-error" : undefined}
          className="flex flex-col"
        >
          <span id="rec-split-label" className="label-mono mb-1.5 block text-pretty">
            {t("form.split")}
          </span>
          <div className="flex flex-col gap-2">
            <div className="flex gap-2">
              <button type="button" aria-pressed={splitMode === "ALL"} onClick={() => setSplitMode("ALL")} className={segment(splitMode === "ALL")}>
                {t("form.splitAll")}
              </button>
              <button
                type="button"
                aria-pressed={splitMode === "SELECTED"}
                onClick={() => setSplitMode("SELECTED")}
                className={segment(splitMode === "SELECTED")}
              >
                {t("form.splitPick")}
              </button>
            </div>
            {splitMode === "SELECTED" && (
              <ul aria-label={t("form.splitPick")} className="flex flex-col rounded-md border border-dashed border-rule">
                {members.map((m) => (
                  <li key={m.id} className="border-b border-dotted border-rule last:border-b-0">
                    <label className="flex min-h-11 cursor-pointer items-center gap-2.5 px-3 py-2 text-sm text-ink md:min-h-0">
                      <input
                        type="checkbox"
                        checked={picked.includes(m.id)}
                        onChange={() => togglePick(m.id)}
                        className="h-4 w-4 shrink-0 accent-ink"
                      />
                      <MemberDot colorIndex={m.colorIndex} name={memberLabel(m)} size={22} />
                      <span className="min-w-0 truncate">{memberLabel(m)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {fieldErrors.split && (
            <p id="rec-split-error" role="alert" className="mt-1.5 text-pretty text-xs text-debt">
              {fieldErrors.split}
            </p>
          )}
        </div>

        <div aria-live="polite" className="rounded-md border border-dashed border-rule bg-panel/40 p-3">
          {share !== null ? (
            <>
              <p className="text-sm font-medium text-ink tnum tabular-nums">
                {t("form.preview", { amount: money(amountCents), count, share: money(share) })}
              </p>
              {postingKey ? (
                <p className="mt-1 text-pretty text-xs text-faint">{t(postingKey, { date: dueDateLabel(firstPosting), day })}</p>
              ) : (
                // A paused rule (by a member or because someone left) posts nothing until it is resumed.
                <p className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                  <Tag>{t("paused")}</Tag>
                  <span className="text-faint">{t("pausedNothing")}</span>
                </p>
              )}
            </>
          ) : (
            <p className="text-pretty text-xs text-faint">{t("form.previewEmpty")}</p>
          )}
        </div>
      </div>
    </Modal>

    {/* Unsaved-changes guard (BL-14/U9): a sibling, not nested inside the modal above (as in the expense form). */}
    <Modal
      open={confirmDiscard}
      onOpenChange={(o) => !o && setConfirmDiscard(false)}
      title={te("discardTitle")}
      footer={
        <>
          <Button variant="ghost" onClick={() => setConfirmDiscard(false)}>
            {te("keepEditing")}
          </Button>
          <Button variant="danger" onClick={discardAndClose}>
            {te("discardChanges")}
          </Button>
        </>
      }
    >
      <p className="text-sm text-ink">{te("discardPrompt")}</p>
    </Modal>
    </>
  );
}
