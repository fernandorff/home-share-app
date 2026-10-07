"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Card, ReceiptDivider, SectionTitle } from "@/components/ui/Card";
import { Money } from "@/components/ui/Money";
import { MemberDot, MemberChip } from "@/components/ui/Member";
import { Stamp } from "@/components/ui/Stamp";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { EmptyState } from "@/components/ui/Feedback";
import { Skeleton, SkeletonRows } from "@/components/ui/Skeleton";
import { revealDelay } from "@/components/ui/motion";
import { api } from "@/lib/api";
import { useApiError } from "@/lib/api-errors";
import { useSession } from "@/lib/session";
import { useToast } from "@/components/ui/Toast";
import { formatDateLocale } from "@/lib/money";
import { keepLastWordTogether } from "@/lib/activity-format";
import { percentLabel, percentsTo100 } from "@/lib/percent";
import { RecordPaymentModal, type PaymentPrefill } from "@/components/balances/RecordPaymentModal";
import type { BalancesResponse, Payment } from "@/lib/types";

export default function BalancesPage() {
  const t = useTranslations("Balances");
  const ts = useTranslations("Settlements");
  const tc = useTranslations("Common");
  const tcat = useTranslations("Expenses");
  const thh = useTranslations("Household");
  const tacc = useTranslations("Account");
  const apiErr = useApiError();
  const { members, activeGroup } = useSession();
  const toast = useToast();
  const locale = useLocale();
  const [data, setData] = useState<BalancesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const reqId = useRef(0);

  const [payOpen, setPayOpen] = useState(false);
  const [payPrefill, setPayPrefill] = useState<PaymentPrefill | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Payment | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    const id = ++reqId.current;
    try {
      const res = await api.get<BalancesResponse>("/api/balances");
      if (reqId.current === id) setData(res);
    } catch (err) {
      if (reqId.current === id) toast(apiErr(err, t("loadError")), "error");
    } finally {
      if (reqId.current === id) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setLoading(true);
    load();
  }, [activeGroup?.id, load]);

  const colorOf = (userId: number) =>
    members.find((m) => m.id === userId)?.colorIndex ?? 0;

  // Historical name a balance/settlement row's userId resolves to (BL-16/BL-23): a deleted
  // account always shows the fully translated "Deleted user" label (ignores whatever the raw,
  // English-neutral name column holds); an ex-member keeps their real name, just tagged.
  const displayName = (userId: number, fallbackName: string) => {
    const m = members.find((mm) => mm.id === userId);
    if (!m) return fallbackName;
    if (m.deleted) return tacc("deletedUserLabel");
    if (!m.active) return thh("exMemberLabel", { name: m.name });
    return m.name;
  };

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

  // D3: the shared page header, rendered in the loading and unavailable states too.
  const header = (
    <PageHeader title={t("title")} subtitle={t("statement")} />
  );

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        {header}
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
      <div className="flex flex-col gap-6">
        {header}
        <Card>
          <EmptyState title={t("unavailableTitle")} hint={t("unavailableHint")} />
        </Card>
      </div>
    );
  }

  const { balances, settlements, totalExpenses, payments, byCategory, byMonth } = data;
  const hasExpenses = balances.length > 0;
  const allSettled = balances.every((b) => b.balance === 0);
  // Empty bucket -> "uncategorized"; a system-default key -> its translation; a house
  // custom category -> its raw name (was wrongly falling through to "uncategorized").
  const catLabel = (c: string) =>
    !c ? t("uncategorized") : tcat.has(`category.${c}`) ? tcat(`category.${c}`) : c;
  const monthLabel = (ym: string) => {
    const [y, m] = ym.split("-").map(Number);
    const d = new Date(y, (m ?? 1) - 1, 1);
    const name = new Intl.DateTimeFormat(locale, { month: "short" }).format(d);
    return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${y}`;
  };
  const monthsTop = byMonth.slice(0, 6);
  // D8: whole-percent labels via largest-remainder so they sum to exactly 100 (not 99/101 from
  // rounding each row's toFixed(0) independently). D7: both bars/labels use the same scale
  // (% of totalExpenses) — the month bar no longer scales against the largest month.
  const catPercents = percentsTo100(byCategory.map((c) => c.total));
  // Fix round 1 (D7): percentages over the FULL history, then take the visible prefix — each
  // shown month's label must be its share of totalExpenses, not its share of only the 6 shown
  // months (with >6 months of history those diverge, e.g. 10 months x R$100 gave labels
  // 17/17/17/17/16/16 while the bars, correctly, all showed 10%). monthsTop is a prefix of
  // byMonth, so the indices below still line up.
  const monthPercents = percentsTo100(byMonth.map((m) => m.total)).slice(0, 6);

  return (
    <div className="flex flex-col gap-6">
      {header}

      {/* Hero "statement" */}
      <Card className="reveal overflow-hidden">
        {/* I8: stacked below sm — inline, the bold 2xl total left the label too little width and
            it wrapped to 3 lines at 360px; the label now gets the full row to itself. */}
        <div className="flex flex-col gap-1 px-5 py-4 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
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
                    <MemberDot colorIndex={colorOf(b.userId)} name={displayName(b.userId, b.userName)} size={28} />
                    {/* Round 2 (D22 residual): below sm the name wraps to up to 2 lines instead of
                        being cut with an ellipsis. max-sm: and sm: are exact complements, so
                        line-clamp-2 (below sm) and truncate (sm up, unchanged) never apply to the
                        same viewport. */}
                    <span className="min-w-0 flex-1 text-sm text-ink max-sm:line-clamp-2 max-sm:break-words sm:truncate">
                      {displayName(b.userId, b.userName)}
                    </span>
                    {/* The signed value already carries the credit/debt color + sign on mobile;
                        the stamp is decorative there, so it only shows from sm up (keeps the name room).
                        Wrap to control the breakpoint — the Stamp's own `inline-block` base would
                        otherwise override a `hidden` placed on it (project cn() doesn't merge conflicts). */}
                    <span className="sr-only shrink-0 sm:not-sr-only sm:inline-block">
                      {isCredit && <Stamp tone="credit">{t("toReceive")}</Stamp>}
                      {isDebt && <Stamp tone="debt">{t("owes")}</Stamp>}
                      {settled && <Stamp tone="ink">{ts("settled")}</Stamp>}
                    </span>
                    {/* D22: sized by content instead of a fixed w-28/w-32 that reserved more
                        room than most amounts need, cutting long names short. */}
                    <Money
                      signed
                      value={b.balance}
                      className="shrink-0 whitespace-nowrap text-right font-display text-sm font-bold sm:text-base"
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
          {/* flex-wrap + whitespace-nowrap (I8): at 360px the button had room for only its
              longest word ("pagamento"), so it wrapped to 2 lines next to the title; now the
              whole button drops below the title instead of its own text wrapping. */}
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5">
            {/* R3-15: grow (basis auto) — the title still wraps above the button when they don't fit, and its dotted rule gets the free width (it was 0px at 360). */}
            <SectionTitle className="grow">{t("whoPaysWhom")}</SectionTitle>
            {/* R2-13: bordered (secondary), so it reads as a button and its edge sits on the card margin. */}
            <Button size="sm" variant="secondary" className="whitespace-nowrap" onClick={() => openPayment(null)}>
              {ts("recordPayment")}
            </Button>
          </div>

          {settlements.length > 0 ? (
            <ul className="px-5 pt-3 pb-4">
              {settlements.map((s, i) => (
                <li
                  key={`${s.from.id}-${s.to.id}-${i}`}
                  className="reveal py-3"
                  style={revealDelay(i)}
                >
                  {/* sm and up: unchanged single row (fix round 1 only touches the below-sm
                      markup below). */}
                  <div className="hidden items-center gap-2 sm:flex">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <MemberChip colorIndex={colorOf(s.from.id)} name={displayName(s.from.id, s.from.name)} />
                      <span className="px-0.5 text-faint" aria-hidden>→</span>
                      <MemberChip colorIndex={colorOf(s.to.id)} name={displayName(s.to.id, s.to.name)} />
                    </span>
                    <span className="mx-1 flex-1 border-b border-dotted border-rule" aria-hidden />
                    <Money value={s.amount} className="font-display text-sm font-bold sm:text-base" />
                    <Button
                      size="sm"
                      variant="secondary"
                      className="shrink-0"
                      onClick={() => openPayment({ fromUserId: s.from.id, toUserId: s.to.id, amount: s.amount })}
                    >
                      {ts("markPaid")}
                    </Button>
                  </div>
                  {/* Fix round 1 (U5 continued): below sm, the row above no longer fit once the
                      avatar group stopped shrinking — the arrow overlapped the first avatar and
                      the second avatar overlapped the amount at 360-390px, because the group's
                      old `min-w-0` let the flex row squeeze it narrower than its own two 22px
                      avatars + arrow. Split into two rows instead: avatars (now `shrink-0`, so
                      the group can never render narrower than its content) + dotted spacer +
                      amount on row 1; the names line and the button (which no longer has room on
                      row 1) on row 2. The names line is aria-hidden — each MemberChip's dot
                      already carries its name via aria-label/title, so this text would otherwise
                      announce every name twice. */}
                  <div className="flex flex-col gap-1 sm:hidden">
                    <div className="flex items-center gap-2">
                      <span className="flex shrink-0 items-center gap-1.5">
                        <MemberChip colorIndex={colorOf(s.from.id)} name={displayName(s.from.id, s.from.name)} />
                        <span className="px-0.5 text-faint" aria-hidden>→</span>
                        <MemberChip colorIndex={colorOf(s.to.id)} name={displayName(s.to.id, s.to.name)} />
                      </span>
                      <span className="mx-1 flex-1 border-b border-dotted border-rule" aria-hidden />
                      <Money value={s.amount} className="shrink-0 font-display text-sm font-bold" />
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      {/* R2-02: wraps instead of cutting the recipient next to MARK PAID — two people
                          with similar names must stay distinguishable on the row that settles them. */}
                      <p className="min-w-0 flex-1 break-words text-xs text-ink-soft" aria-hidden="true">
                        {displayName(s.from.id, s.from.name)} → {displayName(s.to.id, s.to.name)}
                      </p>
                      <Button
                        size="sm"
                        variant="secondary"
                        className="shrink-0"
                        onClick={() => openPayment({ fromUserId: s.from.id, toUserId: s.to.id, amount: s.amount })}
                      >
                        {ts("markPaid")}
                      </Button>
                    </div>
                  </div>
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
                <div className="py-3">
                  <div className="flex items-start gap-3">
                    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                      <MemberChip colorIndex={colorOf(p.fromUser.id)} name={displayName(p.fromUser.id, p.fromUser.name)} />
                      <span className="px-0.5 text-faint" aria-hidden>→</span>
                      <MemberChip colorIndex={colorOf(p.toUser.id)} name={displayName(p.toUser.id, p.toUser.name)} />
                      <span className="sr-only text-xs text-faint sm:not-sr-only sm:ml-1">{formatDateLocale(p.date)}</span>
                      {/* D15: the "· " separator only makes sense inline; hide it when the note
                          wraps to its own full-width line (sm:w-auto keeps it inline from sm up,
                          where the separator also shows). */}
                      {p.note && (
                        <span className="w-full truncate text-xs text-ink-soft sm:w-auto">
                          <span className="hidden sm:inline">· </span>
                          {p.note}
                        </span>
                      )}
                    </span>
                    {/* R3-14: amount and ✕ ride the avatar line (22px), with or without a note below —
                        they used to center on the whole avatars + note block. The ✕ keeps its 44px hit
                        area, overflowing the line evenly. */}
                    <span className="relative flex h-[22px] shrink-0 items-center gap-3">
                      <Money value={p.amount} className="font-display text-sm font-bold" />
                      <button
                        type="button"
                        aria-label={ts("deletePayment")}
                        onClick={() => setDeleteTarget(p)}
                        // min-h-11 min-w-11: 44px touch floor on mobile (D3 — destructive ✕ was 27x28);
                        // sm:* restores the compact desktop size.
                        className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md px-2 py-1 text-sm text-ink-soft transition-colors hover:bg-panel hover:text-debt md:min-h-0 md:min-w-0"
                      >
                        ✕
                      </button>
                    </span>
                  </div>
                  {/* U5: aria-hidden — each MemberChip's dot already carries its name via aria-label/title, so this phone-only text is a sighted-only duplicate.
                      R2-24: the date lives here on phones, so it never jumps between rows with the amount's width. */}
                  <p className="mt-1 break-words text-xs text-ink-soft sm:hidden" aria-hidden="true">
                    {displayName(p.fromUser.id, p.fromUser.name)} → {displayName(p.toUser.id, p.toUser.name)}
                    <span className="whitespace-nowrap text-faint"> · {formatDateLocale(p.date)}</span>
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Insights — spend by category */}
      {hasExpenses && byCategory.length > 0 && (
        <Card>
          <div className="px-5 pt-5">
            <SectionTitle>{t("byCategory")}</SectionTitle>
          </div>
          <ul className="px-5 pt-2 pb-4">
            {byCategory.map((c, i) => {
              const pct = totalExpenses > 0 ? (c.total / totalExpenses) * 100 : 0;
              return (
                <li key={c.category || "none"} className="reveal py-2" style={revealDelay(i)}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate text-sm text-ink">{catLabel(c.category)}</span>
                    <span className="flex shrink-0 items-baseline gap-2">
                      <span className="label-mono text-faint">{percentLabel(catPercents[i], c.total)}</span>
                      <Money value={c.total} className="tnum font-display text-sm font-bold" />
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-panel">
                    <div className="h-full rounded-full bg-ink" style={{ width: `${pct}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {/* Insights — spend by month */}
      {hasExpenses && monthsTop.length > 0 && (
        <Card>
          <div className="px-5 pt-5">
            <SectionTitle>{t("byMonth")}</SectionTitle>
          </div>
          <ul className="px-5 pt-2 pb-4">
            {monthsTop.map((m, i) => {
              const pct = totalExpenses > 0 ? (m.total / totalExpenses) * 100 : 0;
              return (
                <li key={m.month} className="reveal py-2" style={revealDelay(i)}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="label-mono min-w-0 truncate">{monthLabel(m.month)}</span>
                    <span className="flex shrink-0 items-baseline gap-2">
                      <span className="label-mono text-faint">{percentLabel(monthPercents[i], m.total)}</span>
                      <Money value={m.total} className="tnum font-display text-sm font-bold" />
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-panel">
                    <div className="h-full rounded-full bg-ink" style={{ width: `${pct}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <RecordPaymentModal
        open={payOpen}
        onOpenChange={setPayOpen}
        prefill={payPrefill}
        settlements={data?.settlements ?? []}
        onSaved={load}
      />

      <Modal
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={ts("deletePaymentConfirmTitle")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>{tc("cancel")}</Button>
            <Button variant="danger" loading={deleting} onClick={confirmDeletePayment}>{tc("delete")}</Button>
          </>
        }
      >
        <p className="text-sm text-ink">{ts("deleteConfirm")}</p>
        {/* U17: name the payment being deleted (from → to · amount · date) — same money/date
            formatting the payments list above already uses. */}
        {deleteTarget && (
          <p className="mt-2 text-sm font-semibold text-ink">
            {keepLastWordTogether(displayName(deleteTarget.fromUser.id, deleteTarget.fromUser.name))}
            {" → "}
            {keepLastWordTogether(displayName(deleteTarget.toUser.id, deleteTarget.toUser.name))}
            {" · "}
            {/* R3-34: amount and date travel together — the date no longer drops alone to a line of its own. */}
            <span className="whitespace-nowrap">
              <Money value={deleteTarget.amount} />
              {" · "}
              {formatDateLocale(deleteTarget.date)}
            </span>
          </p>
        )}
        {/* R3-33: the effect and the irreversibility sentence close the body (were a 2-line subtitle). */}
        <p className="mt-2 text-pretty text-sm text-ink">{ts("deleteUndoNote")}</p>
      </Modal>
    </div>
  );
}
