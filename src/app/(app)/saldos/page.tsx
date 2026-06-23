"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Card, ReceiptDivider, SectionTitle } from "@/components/ui/Card";
import { Money } from "@/components/ui/Money";
import { MemberDot, MemberChip } from "@/components/ui/Member";
import { Stamp } from "@/components/ui/Stamp";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { EmptyState } from "@/components/ui/Feedback";
import { Skeleton, SkeletonRows } from "@/components/ui/Skeleton";
import { revealDelay } from "@/components/ui/motion";
import { cn } from "@/components/ui/cn";
import { api } from "@/lib/api";
import { useApiError } from "@/lib/api-errors";
import { useSession } from "@/lib/session";
import { useToast } from "@/components/ui/Toast";
import { formatDateLocale } from "@/lib/money";
import { RecordPaymentModal, type PaymentPrefill } from "@/components/balances/RecordPaymentModal";
import type { BalancesResponse, Payment } from "@/lib/types";

export default function SaldosPage() {
  const t = useTranslations("Balances");
  const ts = useTranslations("Settlements");
  const tc = useTranslations("Common");
  const apiErr = useApiError();
  const { members, activeGroup } = useSession();
  const toast = useToast();
  const locale = useLocale();
  const [data, setData] = useState<BalancesResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const [payOpen, setPayOpen] = useState(false);
  const [payPrefill, setPayPrefill] = useState<PaymentPrefill | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Payment | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<BalancesResponse>("/api/balances");
      setData(res);
    } catch (err) {
      toast(apiErr(err, t("loadError")), "error");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setLoading(true);
    load();
  }, [activeGroup?.id, load]);

  const colorOf = (userId: number) =>
    members.find((m) => m.id === userId)?.colorIndex ?? 0;

  function openPayment(prefill: PaymentPrefill | null) {
    setPayPrefill(prefill);
    setPayOpen(true);
  }

  async function confirmDeletePayment() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.del(`/api/settlements/${deleteTarget.publicId}`);
      toast(ts("deleted"), "success");
      setDeleteTarget(null);
      load();
    } catch (err) {
      toast(apiErr(err, ts("deleteError")), "error");
    } finally {
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <Card>
          <div className="flex items-center justify-between gap-4 px-5 py-5">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-8 w-24" />
          </div>
        </Card>
        <Card>
          <div className="px-5 pt-5 pb-2">
            <Skeleton className="h-4 w-24" />
          </div>
          <div className="px-5 pb-4">
            <SkeletonRows rows={3} />
          </div>
        </Card>
      </div>
    );
  }

  if (!data) {
    return (
      <Card>
        <EmptyState title={t("unavailableTitle")} hint={t("unavailableHint")} />
      </Card>
    );
  }

  const { balances, settlements, totalExpenses, payments } = data;
  const hasExpenses = balances.length > 0;
  const allSettled = balances.every((b) => b.balance === 0);

  return (
    <div className="flex flex-col gap-6">
      {/* Hero "extrato" */}
      <Card className="reveal overflow-hidden">
        <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-4">
          <div>
            <p className="label-mono text-faint">{t("statement")}</p>
            <h1 className="font-display text-2xl font-bold tracking-tight text-ink">
              {t("title")}
            </h1>
          </div>
          <Stamp tone="ink" className="mt-1 shrink-0">
            {t("account")}
          </Stamp>
        </div>

        <ReceiptDivider />

        <div className="flex items-baseline justify-between gap-4 px-5 py-4">
          <span className="label-mono text-faint">{t("totalExpenses")}</span>
          <Money value={totalExpenses} className="font-display text-2xl font-bold" />
        </div>
      </Card>

      {/* Balances per person */}
      <Card>
        <div className="px-5 pt-5">
          <SectionTitle>{t("perPerson")}</SectionTitle>
        </div>

        {hasExpenses ? (
          <ul className="px-5 pt-2 pb-4">
            {balances.map((b, i) => {
              const isCredit = b.balance > 0;
              const isDebt = b.balance < 0;
              const settled = b.balance === 0;
              return (
                <li key={b.userId} className="reveal" style={revealDelay(i)}>
                  {i > 0 && <ReceiptDivider />}
                  <div className="flex items-center gap-3 py-3">
                    <MemberDot colorIndex={colorOf(b.userId)} name={b.userName} size={28} />
                    <span className="min-w-0 flex-1 truncate text-sm text-ink">
                      {b.userName}
                    </span>
                    {isCredit && <Stamp tone="credit">{t("toReceive")}</Stamp>}
                    {isDebt && <Stamp tone="debt">{t("owes")}</Stamp>}
                    {settled && <Stamp tone="ink">{ts("settled")}</Stamp>}
                    <Money
                      signed
                      value={b.balance}
                      className="w-28 text-right font-display text-sm font-bold sm:w-32 sm:text-base"
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState title={t("noExpensesTitle")} hint={t("noExpensesHint")} />
        )}
      </Card>

      {/* Settlements — who pays whom */}
      {hasExpenses && (
        <Card>
          <div className="flex items-center justify-between gap-3 px-5 pt-5">
            <SectionTitle>{t("whoPaysWhom")}</SectionTitle>
            <Button size="sm" variant="ghost" onClick={() => openPayment(null)}>
              {ts("recordPayment")}
            </Button>
          </div>

          {settlements.length > 0 ? (
            <ul className="px-5 pt-3 pb-4">
              {settlements.map((s, i) => (
                <li
                  key={`${s.from.id}-${s.to.id}-${i}`}
                  className="reveal flex items-center gap-2 py-3"
                  style={revealDelay(i)}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <MemberChip colorIndex={colorOf(s.from.id)} name={s.from.name} />
                    <span className="px-0.5 text-faint" aria-hidden>→</span>
                    <MemberChip colorIndex={colorOf(s.to.id)} name={s.to.name} />
                  </span>
                  <span className="mx-1 flex-1 border-b border-dotted border-rule" aria-hidden />
                  <Money value={s.amount} className="font-display text-sm font-bold sm:text-base" />
                  <Button
                    size="sm"
                    variant="ghost"
                    className="shrink-0"
                    onClick={() => openPayment({ fromUserId: s.from.id, toUserId: s.to.id, amount: s.amount })}
                  >
                    {ts("markPaid")}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              title={t("allSettledTitle")}
              hint={allSettled ? t("allSettledHint") : t("noTransfersHint")}
            />
          )}
        </Card>
      )}

      {/* Recorded payments history */}
      {payments.length > 0 && (
        <Card>
          <div className="px-5 pt-5">
            <SectionTitle>{ts("history")}</SectionTitle>
          </div>
          <ul className="px-5 pt-2 pb-4">
            {payments.map((p, i) => (
              <li key={p.publicId} className="reveal" style={revealDelay(i)}>
                {i > 0 && <ReceiptDivider />}
                <div className="flex items-center gap-3 py-3">
                  <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                    <MemberChip colorIndex={colorOf(p.fromUser.id)} name={p.fromUser.name} />
                    <span className="px-0.5 text-faint" aria-hidden>→</span>
                    <MemberChip colorIndex={colorOf(p.toUser.id)} name={p.toUser.name} />
                    <span className="ml-1 text-xs text-faint">{formatDateLocale(p.date, locale)}</span>
                    {p.note && <span className="w-full truncate text-xs text-ink-soft sm:w-auto">· {p.note}</span>}
                  </span>
                  <Money value={p.amount} className="font-display text-sm font-bold" />
                  <button
                    type="button"
                    aria-label={ts("deletePayment")}
                    onClick={() => setDeleteTarget(p)}
                    className="shrink-0 rounded-md px-2 py-1 text-sm text-ink-soft transition-colors hover:bg-panel hover:text-debt"
                  >
                    ✕
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <RecordPaymentModal open={payOpen} onOpenChange={setPayOpen} prefill={payPrefill} onSaved={load} />

      <Modal
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={ts("deletePayment")}
        description={ts("deleteUndoNote")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>{tc("cancel")}</Button>
            <Button variant="danger" loading={deleting} onClick={confirmDeletePayment}>{tc("delete")}</Button>
          </>
        }
      >
        <p className="text-sm text-ink">{ts("deleteConfirm")}</p>
      </Modal>
    </div>
  );
}
