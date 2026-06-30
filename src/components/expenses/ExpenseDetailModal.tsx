"use client";

import type { ReactNode } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Money } from "@/components/ui/Money";
import { MemberDot } from "@/components/ui/Member";
import { Tag, type TagTone } from "@/components/ui/Stamp";
import { useSession } from "@/lib/session";
import { formatDateLocale } from "@/lib/money";
import type { Expense } from "@/lib/types";

/** Read-only detail view of an expense, with Edit / Delete actions. */
export function ExpenseDetailModal({
  expense,
  onOpenChange,
  onEdit,
  onDelete,
}: {
  expense: Expense | null;
  onOpenChange: (open: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations("Expenses");
  const tc = useTranslations("Common");
  const locale = useLocale();
  const { members } = useSession();
  const memberById = new Map(members.map((m) => [m.id, m]));

  const lbl = (ns: string, v: string) => (t.has(`${ns}.${v}`) ? t(`${ns}.${v}`) : v);
  const payerColor = expense ? memberById.get(expense.payerId)?.colorIndex ?? 0 : 0;

  return (
    <Modal
      open={expense !== null}
      onOpenChange={onOpenChange}
      title={t("detailTitle")}
      footer={
        <>
          <Button variant="danger" onClick={onDelete}>
            {tc("delete")}
          </Button>
          <Button variant="primary" onClick={onEdit}>
            {tc("edit")}
          </Button>
        </>
      }
    >
      {expense && (
        <div className="flex flex-col gap-5">
          {/* Amount + description */}
          <div>
            <Money value={expense.amount} className="font-display text-2xl font-bold" />
            <p className="mt-1 break-words text-sm text-ink">{expense.description}</p>
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Detail label={t("payer")}>
              <span className="flex min-w-0 items-center gap-2">
                <MemberDot colorIndex={payerColor} name={expense.payer.name} size={20} />
                <span className="truncate">{expense.payer.name}</span>
              </span>
            </Detail>
            <Detail label={t("date")}>
              <span className="tnum">{formatDateLocale(expense.date, locale)}</span>
            </Detail>
          </dl>

          <TagRow tone="category" label={t("categoryLabel")} values={expense.categories} render={(v) => lbl("category", v)} empty={t("noCategory")} />
          <TagRow tone="platform" label={t("platformLabel")} values={expense.platforms} render={(v) => lbl("platform", v)} empty={t("noPlatform")} />
          <TagRow tone="payment" label={t("paymentLabel")} values={expense.paymentMethods} render={(v) => lbl("payment", v)} empty={t("noPayment")} />

          {expense.notes && (
            <div className="flex flex-col gap-1">
              <span className="label-mono">{t("notes")}</span>
              <p className="whitespace-pre-wrap break-words text-sm text-ink">{expense.notes}</p>
            </div>
          )}

          {/* Split */}
          <div className="flex flex-col gap-1">
            <span className="label-mono">{t("split")}</span>
            <ul className="mt-0.5 flex flex-col gap-1.5 rounded-md border border-dashed border-rule bg-panel/40 p-3">
              {expense.participants.map((p) => {
                const m = memberById.get(p.userId);
                return (
                  <li key={p.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <MemberDot colorIndex={m?.colorIndex ?? 0} name={m?.name ?? "?"} size={20} />
                      <span className="truncate text-ink">{m?.name ?? "?"}</span>
                    </span>
                    <Money value={p.amount} />
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </Modal>
  );
}

function TagRow({ label, values, render, empty, tone }: { label: string; values: string[]; render: (v: string) => string; empty: string; tone: TagTone }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="label-mono">{label}</span>
      {values.length === 0 ? (
        <span className="text-sm text-faint">{empty}</span>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {values.map((v) => (
            <Tag key={v} tone={tone}>{render(v)}</Tag>
          ))}
        </div>
      )}
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="label-mono">{label}</span>
      <div className="min-w-0 text-sm text-ink">{children}</div>
    </div>
  );
}
