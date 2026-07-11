"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Money } from "@/components/ui/Money";
import { MemberDot } from "@/components/ui/Member";
import { Tag, type TagTone } from "@/components/ui/Stamp";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { useSession } from "@/lib/session";
import { useToast } from "@/components/ui/Toast";
import { api } from "@/lib/api";
import { useApiError } from "@/lib/api-errors";
import { formatDateLocale } from "@/lib/money";
import { buildExpenseHistory, type RawRevision } from "@/lib/audit-diff";
import type { Expense, ExpenseHistoryResponse, Money as MoneyValue } from "@/lib/types";

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
  const thh = useTranslations("Household");
  const tacc = useTranslations("Account");
  const { members } = useSession();
  const memberById = new Map(members.map((m) => [m.id, m]));

  const lbl = (ns: string, v: string) => (t.has(`${ns}.${v}`) ? t(`${ns}.${v}`) : v);
  const payerColor = expense ? memberById.get(expense.payerId)?.colorIndex ?? 0 : 0;
  // Same ex-member/deleted-account treatment as balances/activity (BL-16/BL-23) — the embedded
  // `expense.payer.name` snapshot is a live join to the CURRENT User row, so a deleted account
  // would already show its (untranslated, raw) placeholder there without this override.
  const memberDisplayName = (id: number, fallback: string) => {
    const m = memberById.get(id);
    if (!m) return fallback;
    if (m.deleted) return tacc("deletedUserLabel");
    if (!m.active) return thh("exMemberLabel", { name: m.name });
    return m.name;
  };

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
                <MemberDot colorIndex={payerColor} name={memberDisplayName(expense.payerId, expense.payer.name)} size={20} />
                <span className="truncate">{memberDisplayName(expense.payerId, expense.payer.name)}</span>
              </span>
            </Detail>
            <Detail label={t("date")}>
              <span className="tnum">{formatDateLocale(expense.date)}</span>
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
                const name = memberDisplayName(p.userId, m?.name ?? "?");
                return (
                  <li key={p.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <MemberDot colorIndex={m?.colorIndex ?? 0} name={name} size={20} />
                      <span className="truncate text-ink">{name}</span>
                    </span>
                    <Money value={p.amount} />
                  </li>
                );
              })}
            </ul>
          </div>

          <ExpenseHistory expense={expense} />
        </div>
      )}
    </Modal>
  );
}

/** Change history for one expense (from the EntityRevision trail). Fetched lazily on expand. */
function ExpenseHistory({ expense }: { expense: Expense }) {
  const t = useTranslations("Expenses");
  const thh = useTranslations("Household");
  const tacc = useTranslations("Account");
  const locale = useLocale();
  const apiErr = useApiError();
  const toast = useToast();
  const { members } = useSession();
  const memberById = new Map(members.map((m) => [m.id, m]));
  // Same ex-member/deleted-account treatment as the detail view above (BL-16/BL-23).
  const memberDisplayName = (id: number) => {
    const m = memberById.get(id);
    if (!m) return `#${id}`;
    if (m.deleted) return tacc("deletedUserLabel");
    if (!m.active) return thh("exMemberLabel", { name: m.name });
    return m.name;
  };

  const [expanded, setExpanded] = useState(false);
  const [entries, setEntries] = useState<ReturnType<typeof buildExpenseHistory> | null>(null);
  const [loading, setLoading] = useState(false);

  // Reset when the modal is reused for a different expense.
  useEffect(() => {
    setExpanded(false);
    setEntries(null);
  }, [expense.publicId]);

  useEffect(() => {
    if (!expanded || entries !== null) return;
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const res = await api.get<ExpenseHistoryResponse>(`/api/expenses/${expense.publicId}/history`);
        if (alive) setEntries(buildExpenseHistory(res.revisions as RawRevision[]));
      } catch (err) {
        if (alive) {
          toast(apiErr(err, t("history.loadError")), "error");
          setExpanded(false);
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, expense.publicId]);

  const lbl = (ns: string, v: string) => (t.has(`${ns}.${v}`) ? t(`${ns}.${v}`) : v);

  const fieldLabelKey: Record<string, string> = {
    description: "description",
    // colAmount is a plain "Amount" label; amountLabel is an ICU message that requires a {symbol} arg.
    amount: "colAmount",
    categories: "categoryLabel",
    platforms: "platformLabel",
    paymentMethods: "paymentLabel",
    date: "date",
    notes: "notes",
    payerId: "payer",
  };
  const fieldLabel = (f: string) => (fieldLabelKey[f] ? t(fieldLabelKey[f]) : f);

  const renderValue = (field: string, value: unknown): ReactNode => {
    if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) {
      return <span className="text-faint">—</span>;
    }
    switch (field) {
      case "amount":
        return <Money value={value as MoneyValue} />;
      case "date":
        return <span className="tnum">{formatDateLocale(String(value))}</span>;
      case "payerId":
        return <span>{memberDisplayName(Number(value))}</span>;
      case "categories":
        return <span>{(value as string[]).map((v) => lbl("category", v)).join(", ")}</span>;
      case "platforms":
        return <span>{(value as string[]).map((v) => lbl("platform", v)).join(", ")}</span>;
      case "paymentMethods":
        return <span>{(value as string[]).map((v) => lbl("payment", v)).join(", ")}</span>;
      default:
        return <span className="break-words">{String(value)}</span>;
    }
  };

  const when = (iso: string) => {
    const d = new Date(iso);
    // Date part fixed DD/MM regardless of UI language (same reasoning as lib/money's
    // formatDateLocale, BL-18/B3) — only the time part follows the viewer's locale.
    return (
      d.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit" }) +
      " " +
      d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
    );
  };

  return (
    <div className="flex flex-col gap-1 border-t border-dotted border-rule pt-4">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex items-center gap-1.5 self-start label-mono text-ink-soft hover:text-ink"
      >
        <span aria-hidden className="text-faint">{expanded ? "–" : "+"}</span>
        {t("history.title")}
      </button>

      {expanded &&
        (loading ? (
          <div className="mt-1">
            <SkeletonRows rows={3} />
          </div>
        ) : entries && entries.length > 0 ? (
          <ol className="mt-1.5 flex flex-col gap-2.5 border-l border-dotted border-rule pl-3">
            {entries.map((e) => (
              <li key={e.id} className="text-sm">
                <p className="text-ink">
                  <span className="font-medium">{e.actorName ?? t("history.someone")}</span>{" "}
                  <span className="text-ink-soft">{t(`history.${e.action}`)}</span>
                  <span className="ml-1.5 text-xs text-faint tnum">{when(e.createdAt)}</span>
                </p>
                {e.action === "UPDATE" &&
                  (e.changes.length > 0 ? (
                    <ul className="mt-1 flex flex-col gap-0.5">
                      {e.changes.map((c) => (
                        <li key={c.field} className="flex flex-wrap items-center gap-1 text-xs text-faint">
                          <span>{fieldLabel(c.field)}:</span>
                          <span className="line-through opacity-70">{renderValue(c.field, c.from)}</span>
                          <span aria-hidden>→</span>
                          <span className="text-ink-soft">{renderValue(c.field, c.to)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-0.5 text-xs text-faint">{t("history.noFieldChanges")}</p>
                  ))}
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-1 text-sm text-faint">{t("history.empty")}</p>
        ))}
    </div>
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
