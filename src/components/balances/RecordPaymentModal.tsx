"use client";

import { useEffect, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Field, Input, Textarea, Select } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";
import { useSession } from "@/lib/session";
import { api } from "@/lib/api";
import { useApiError } from "@/lib/api-errors";
import { maskAmountInput, parseAmountInput, todayInputValue } from "@/lib/format";
import { CURRENCY_META, DEFAULT_CURRENCY, isCurrency } from "@/lib/currencies";
import { Money } from "@/components/ui/Money";
import type { Settlement } from "@/lib/types";

export interface PaymentPrefill {
  fromUserId?: number;
  toUserId?: number;
  amount?: number;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prefill?: PaymentPrefill | null;
  /** The current suggested optimal transfers — used to warn when the entered amount overshoots
   *  the actual debt for the selected pair (BL-14/B12). */
  settlements: Settlement[];
  onSaved: () => void;
}

export function RecordPaymentModal({ open, onOpenChange, prefill, settlements, onSaved }: Props) {
  const { members, activeGroup } = useSession();
  const t = useTranslations("Settlements");
  const tc = useTranslations("Common");
  const thh = useTranslations("Household");
  const tacc = useTranslations("Account");
  // Ex-members stay selectable here on purpose (BL-16) — resolving their locked balance is
  // exactly what this modal is for — just tagged so it's clear who's no longer active.
  const optionLabel = (m: (typeof members)[number]) =>
    m.deleted ? tacc("deletedUserLabel") : !m.active ? thh("exMemberLabel", { name: m.name }) : m.name;
  const toast = useToast();
  const apiErr = useApiError();
  const locale = useLocale();
  const currencySymbol =
    CURRENCY_META[isCurrency(activeGroup?.currency) ? activeGroup.currency : DEFAULT_CURRENCY].symbol;

  const [fromId, setFromId] = useState<number | "">("");
  const [toId, setToId] = useState<number | "">("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [date, setDate] = useState(todayInputValue());
  const [saving, setSaving] = useState(false);

  // Seed from the prefill (a suggested transfer) each time the modal opens.
  useEffect(() => {
    if (!open) return;
    setFromId(prefill?.fromUserId ?? "");
    setToId(prefill?.toUserId ?? "");
    setAmount(prefill?.amount ? maskAmountInput(String(Math.round(prefill.amount * 100)), locale) : "");
    setNote("");
    setDate(todayInputValue());
  }, [open, prefill, locale]);

  const parsedAmount = parseAmountInput(amount, locale);
  const valid = fromId !== "" && toId !== "" && fromId !== toId && parsedAmount > 0;

  // The real debt owed for the currently selected pair (from the optimal-transfer suggestions),
  // used to warn before a payment larger than what's actually owed flips who owes whom (BL-14/B12).
  const owed = settlements.find((s) => s.from.id === fromId && s.to.id === toId)?.amount ?? 0;
  const isOverpaying = owed > 0 && parsedAmount > owed;

  async function submit() {
    if (!valid) return;
    setSaving(true);
    try {
      await api.post("/api/settlements", {
        fromUserId: fromId,
        toUserId: toId,
        amount: parsedAmount,
        note: note.trim() || undefined,
        date,
      });
      toast(t("saved"), "success");
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast(apiErr(err, t("saveError")), "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t("recordPayment")}
      description={t("recordHint")}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {tc("cancel")}
          </Button>
          <Button loading={saving} disabled={!valid} onClick={submit}>
            {t("save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("from")} htmlFor="pay-from">
            <Select id="pay-from" value={fromId} onChange={(e) => setFromId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">{t("selectMember")}</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>{optionLabel(m)}</option>
              ))}
            </Select>
          </Field>
          <Field label={t("to")} htmlFor="pay-to">
            <Select id="pay-to" value={toId} onChange={(e) => setToId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">{t("selectMember")}</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>{optionLabel(m)}</option>
              ))}
            </Select>
          </Field>
        </div>

        {fromId !== "" && fromId === toId && (
          <p className="text-xs text-debt">{t("sameError")}</p>
        )}

        <Field label={t("amountLabel", { symbol: currencySymbol })} htmlFor="pay-amount">
          <Input
            id="pay-amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(maskAmountInput(e.target.value, locale))}
            placeholder={maskAmountInput("0", locale)}
          />
        </Field>

        {isOverpaying && (
          <p className="text-xs text-debt">
            {t("overpayWarning")} <Money value={owed} className="font-semibold" />
          </p>
        )}

        <Field label={t("date")} htmlFor="pay-date">
          <Input id="pay-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>

        <Field label={t("note")} htmlFor="pay-note">
          <Textarea
            id="pay-note"
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("notePlaceholder")}
          />
        </Field>
      </div>
    </Modal>
  );
}
