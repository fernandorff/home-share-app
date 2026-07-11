"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { cn } from "@/components/ui/cn";
import { EXPENSE_CATEGORIES } from "@/lib/categories";
import { DEFAULT_PLATFORMS } from "@/lib/platforms";
import { DEFAULT_PAYMENT_METHODS } from "@/lib/payment-methods";
import type { Member, Platform, Category, PaymentMethod } from "@/lib/types";

/** The expense list's filter set — each dimension is multi-select (OR within a
 *  dimension, AND across dimensions). Edited as a draft inside the modal; only
 *  committed (and applied to the list) when the user submits "Filter". */
export interface ExpenseFilters {
  query: string;
  payers: number[];
  platforms: string[];
  categories: string[];
  payments: string[];
  fromDate: string;
  toDate: string;
}

export const EMPTY_FILTERS: ExpenseFilters = {
  query: "",
  payers: [],
  platforms: [],
  categories: [],
  payments: [],
  fromDate: "",
  toDate: "",
};

/** Toggle-chip multi-select (mirrors the expense form's chips). */
function MultiChips({
  options,
  selected,
  onToggle,
}: {
  options: { value: string; label: string }[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  if (options.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = selected.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onToggle(o.value)}
            aria-pressed={on}
            className={cn(
              "rounded-md border px-2.5 py-1 text-[0.72rem] font-medium transition-colors",
              on ? "border-ink bg-ink text-paper" : "border-rule bg-card text-ink-soft hover:bg-panel"
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function ExpenseFiltersModal({
  open,
  onClose,
  initial,
  members,
  platforms,
  categories,
  paymentMethods,
  onApply,
}: {
  open: boolean;
  onClose: () => void;
  initial: ExpenseFilters;
  members: Member[];
  platforms: Platform[];
  categories: Category[];
  paymentMethods: PaymentMethod[];
  onApply: (filters: ExpenseFilters) => void;
}) {
  const t = useTranslations("Expenses");
  const tc = useTranslations("Common");
  const [draft, setDraft] = useState<ExpenseFilters>(initial);
  const [wasOpen, setWasOpen] = useState(open);

  // Re-seed the draft from the applied filters when the modal transitions to open.
  // Render-time state adjustment (React's documented pattern) — no effect, no cascading renders.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setDraft(initial);
  }

  function setField<K extends keyof ExpenseFilters>(key: K, value: ExpenseFilters[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }
  const togglePayer = (v: string) => {
    const id = Number(v);
    setDraft((d) => ({ ...d, payers: d.payers.includes(id) ? d.payers.filter((x) => x !== id) : [...d.payers, id] }));
  };
  const toggleStr = (key: "platforms" | "categories" | "payments") => (v: string) => {
    setDraft((d) => ({ ...d, [key]: d[key].includes(v) ? d[key].filter((x) => x !== v) : [...d[key], v] }));
  };

  function submit(e: React.FormEvent) {
    e.preventDefault();
    onApply(draft);
    onClose();
  }

  const platformOptions = [
    ...DEFAULT_PLATFORMS.map((k) => ({ value: k, label: t(`platform.${k}`) })),
    ...platforms.map((p) => ({ value: p.name, label: p.name })),
  ];
  const categoryOptions = [
    ...EXPENSE_CATEGORIES.map((c) => ({ value: c, label: t(`category.${c}`) })),
    ...categories.map((c) => ({ value: c.name, label: c.name })),
  ];
  const paymentOptions = [
    ...DEFAULT_PAYMENT_METHODS.map((k) => ({ value: k, label: t(`payment.${k}`) })),
    ...paymentMethods.map((p) => ({ value: p.name, label: p.name })),
  ];

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("filtersTitle")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button type="submit" form="expense-filters-form">
            {t("filter")}
          </Button>
        </>
      }
    >
      <form id="expense-filters-form" onSubmit={submit} className="flex flex-col gap-3">
        <Field label={t("searchLabel")} htmlFor="filter-search">
          <Input
            id="filter-search"
            value={draft.query}
            onChange={(e) => setField("query", e.target.value)}
            placeholder={t("searchPlaceholder")}
            autoFocus
          />
        </Field>

        <Field label={t("colPayer")}>
          <MultiChips
            options={members.map((m) => ({ value: String(m.id), label: m.name }))}
            selected={draft.payers.map(String)}
            onToggle={togglePayer}
          />
        </Field>

        <Field label={t("platformLabel")}>
          <MultiChips options={platformOptions} selected={draft.platforms} onToggle={toggleStr("platforms")} />
        </Field>

        <Field label={t("categoryLabel")}>
          <MultiChips options={categoryOptions} selected={draft.categories} onToggle={toggleStr("categories")} />
        </Field>

        <Field label={t("paymentLabel")}>
          <MultiChips options={paymentOptions} selected={draft.payments} onToggle={toggleStr("payments")} />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label={t("filterFrom")} htmlFor="filter-from">
            <Input id="filter-from" type="date" className="tnum" value={draft.fromDate} onChange={(e) => setField("fromDate", e.target.value)} />
          </Field>
          <Field label={t("filterTo")} htmlFor="filter-to">
            <Input id="filter-to" type="date" className="tnum" value={draft.toDate} onChange={(e) => setField("toDate", e.target.value)} />
          </Field>
        </div>
      </form>
    </Modal>
  );
}
