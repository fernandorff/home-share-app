"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Card, ReceiptDivider, SectionTitle } from "@/components/ui/Card";
import { Money } from "@/components/ui/Money";
import { MemberDot, MemberChip } from "@/components/ui/Member";
import { Stamp } from "@/components/ui/Stamp";
import { EmptyState } from "@/components/ui/Feedback";
import { Skeleton, SkeletonRows } from "@/components/ui/Skeleton";
import { revealDelay } from "@/components/ui/motion";
import { cn } from "@/components/ui/cn";
import { api } from "@/lib/api";
import { useApiError } from "@/lib/api-errors";
import { useSession } from "@/lib/session";
import { useToast } from "@/components/ui/Toast";
import type { BalancesResponse } from "@/lib/types";

export default function SaldosPage() {
  const t = useTranslations("Balances");
  const apiErr = useApiError();
  const { members, activeGroup } = useSession();
  const toast = useToast();
  const [data, setData] = useState<BalancesResponse | null>(null);
  const [loading, setLoading] = useState(true);

  // Re-fetch on mount AND whenever the active house changes (otherwise balances go stale
  // after switching houses). toast/t are read via stable closures, so they're not deps.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const res = await api.get<BalancesResponse>("/api/balances");
        if (alive) setData(res);
      } catch (err) {
        toast(apiErr(err, t("loadError")), "error");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeGroup?.id]);

  // userId → colorIndex (fallback 0 when the member isn't in the active group list).
  const colorOf = (userId: number) =>
    members.find((m) => m.id === userId)?.colorIndex ?? 0;

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
        <EmptyState
          title={t("unavailableTitle")}
          hint={t("unavailableHint")}
        />
      </Card>
    );
  }

  const { balances, settlements, totalExpenses } = data;
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
          <EmptyState
            title={t("noExpensesTitle")}
            hint={t("noExpensesHint")}
          />
        )}
      </Card>

      {/* Settlements — who pays whom */}
      {hasExpenses && (
        <Card>
          <div className="px-5 pt-5">
            <SectionTitle>{t("whoPaysWhom")}</SectionTitle>
          </div>

          {settlements.length > 0 ? (
            <ul className="px-5 pt-3 pb-4">
              {settlements.map((s, i) => (
                <li
                  key={`${s.from.id}-${s.to.id}-${i}`}
                  className={cn("reveal flex items-center gap-2 py-3")}
                  style={revealDelay(i)}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <MemberChip colorIndex={colorOf(s.from.id)} name={s.from.name} />
                    <span className="px-0.5 text-faint" aria-hidden>
                      →
                    </span>
                    <MemberChip colorIndex={colorOf(s.to.id)} name={s.to.name} />
                  </span>
                  {/* dotted leader */}
                  <span
                    className="mx-1 flex-1 border-b border-dotted border-rule"
                    aria-hidden
                  />
                  <Money
                    value={s.amount}
                    className={cn("font-display text-sm font-bold sm:text-base")}
                  />
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
    </div>
  );
}
