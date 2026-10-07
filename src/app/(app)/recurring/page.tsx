"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { api, ApiError } from "@/lib/api";
import { useApiError } from "@/lib/api-errors";
import { useSession } from "@/lib/session";
import { periodLabel } from "@/lib/activity-format";
import { formatMoney } from "@/lib/money";
import { DEFAULT_CURRENCY } from "@/lib/currencies";
import { closesOnError, dueDateLabel, monthName, shareMembers, upcomingAcrossRules, type UpcomingRow } from "@/lib/recurring-view";
import type { RecurringExpense, RecurringHistoryItem, RecurringListResponse, RecurringSaveResponse } from "@/lib/types";
import { cn } from "@/components/ui/cn";
import { Button } from "@/components/ui/Button";
import { Card, ReceiptDivider } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { Money } from "@/components/ui/Money";
import { MemberDot } from "@/components/ui/Member";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/Feedback";
import { Skeleton, SkeletonRows } from "@/components/ui/Skeleton";
import { Stamp } from "@/components/ui/Stamp";
import { useToast } from "@/components/ui/Toast";
import { revealDelay } from "@/components/ui/motion";
import { RecurringExpenseFormModal } from "@/components/recurring/RecurringExpenseFormModal";
import { RecurringRuleCard, RecurringTag } from "@/components/recurring/RecurringRuleCard";

type Tab = "rules" | "upcoming" | "posted";
const TAB_ORDER: Tab[] = ["rules", "upcoming", "posted"];

/** The list as loaded for one house — a list from another house is never shown after a switch. */
interface Loaded {
  groupId: number | undefined;
  data: RecurringListResponse | null;
}

/** Recurring expenses (spec 008, task 19; criteria 4, 14, 15, 17, 21). */
export default function RecurringPage() {
  const t = useTranslations("Recurring");
  const te = useTranslations("Expenses");
  const tc = useTranslations("Common");
  const apiErr = useApiError();
  const toast = useToast();
  const locale = useLocale();
  const { activeGroup } = useSession();
  const groupId = activeGroup?.id;
  const currency = activeGroup?.currency ?? DEFAULT_CURRENCY;

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const reqId = useRef(0);
  const [tab, setTab] = useState<Tab>("rules");
  // The form remounts (new key) on every open, so it always starts from the rule it edits.
  const [form, setForm] = useState<{ open: boolean; key: number; rule: RecurringExpense | null }>({ open: false, key: 0, rule: null });
  const [deleteTarget, setDeleteTarget] = useState<RecurringExpense | null>(null);
  const [deleting, setDeleting] = useState(false);
  // Rules with a request in flight (their buttons are disabled); the ref is the synchronous double-tap guard.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const busyRef = useRef(new Set<string>());

  const load = useCallback(async () => {
    const id = ++reqId.current;
    try {
      const data = await api.get<RecurringListResponse>("/api/recurring-expenses");
      if (reqId.current === id) setLoaded({ groupId, data });
    } catch (e) {
      if (reqId.current !== id) return;
      toast(apiErr(e, t("loadError")), "error");
      // Keep this house's last good list on a failed refresh; nothing to show for a house never loaded.
      setLoaded((previous) => ({ groupId, data: previous && previous.groupId === groupId ? previous.data : null }));
    }
  }, [groupId, apiErr, t, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const current = loaded?.groupId === groupId ? loaded : null;
  const data = current?.data ?? null;
  const rules = data?.rules ?? [];
  const upcomingRows = upcomingAcrossRules(rules);

  const openForm = (rule: RecurringExpense | null) => setForm((f) => ({ open: true, key: f.key + 1, rule }));

  async function run(rule: RecurringExpense, action: () => Promise<void>) {
    if (busyRef.current.has(rule.publicId)) return;
    busyRef.current.add(rule.publicId);
    setBusy(new Set(busyRef.current));
    try {
      await action();
    } catch (e) {
      toast(apiErr(e, t("actionError")), "error");
    } finally {
      busyRef.current.delete(rule.publicId);
      setBusy(new Set(busyRef.current));
      // Summary, upcoming and history all move with any change (and a 404/403 resyncs the screen).
      void load();
    }
  }

  const setPaused = (rule: RecurringExpense, paused: boolean) =>
    run(rule, async () => {
      const res = await api.patch<RecurringSaveResponse>(`/api/recurring-expenses/${rule.publicId}`, { paused, expectedGroupId: activeGroup?.id });
      const name = res.rule.description;
      toast(
        paused ? t("toast.paused", { name }) : res.postedNow > 0 ? t("toast.resumedPostedToday", { name }) : t("toast.resumed", { name }),
        "success"
      );
    });

  const setSkipped = (rule: RecurringExpense, period: string, skip: boolean) =>
    run(rule, async () => {
      const path = `/api/recurring-expenses/${rule.publicId}/skips/${period}`;
      if (skip) {
        await api.put(path);
        toast(t("toast.skipped", { name: rule.description, month: periodLabel(period, locale) }), "success");
      } else {
        await api.del(path);
        const dueOn = rule.upcoming.find((u) => u.period === period)?.dueOn;
        toast(t("toast.unskipped", { name: rule.description, date: dueOn ? dueDateLabel(dueOn) : periodLabel(period, locale) }), "success");
      }
    });

  async function confirmDelete() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      await api.del(`/api/recurring-expenses/${deleteTarget.publicId}`);
      toast(t("toast.deleted"), "success");
      setDeleteTarget(null);
    } catch (e) {
      toast(apiErr(e, t("actionError")), "error");
      // Deleted elsewhere (404) or no longer the viewer's (403): confirming again cannot work.
      if (e instanceof ApiError && closesOnError(e.code)) setDeleteTarget(null);
    } finally {
      setDeleting(false);
      void load();
    }
  }

  // Arrow keys move between the tabs (WAI-ARIA tabs pattern); only the selected tab is in the Tab order.
  function onTabKey(e: KeyboardEvent<HTMLButtonElement>) {
    const i = TAB_ORDER.indexOf(tab);
    const next =
      e.key === "ArrowRight" ? TAB_ORDER[(i + 1) % TAB_ORDER.length]
      : e.key === "ArrowLeft" ? TAB_ORDER[(i + TAB_ORDER.length - 1) % TAB_ORDER.length]
      : e.key === "Home" ? TAB_ORDER[0]
      : e.key === "End" ? TAB_ORDER[TAB_ORDER.length - 1]
      : null;
    if (!next) return;
    e.preventDefault();
    setTab(next);
    document.getElementById(`recurring-tab-${next}`)?.focus();
  }

  const tabs = [
    { id: "rules", label: t("tabs.rules") },
    { id: "upcoming", label: `${t("tabs.upcoming")} (${upcomingRows.length})` },
    { id: "posted", label: t("tabs.posted") },
  ] as const;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      {current === null ? (
        <div className="flex flex-col gap-5" aria-hidden>
          <Card className="flex flex-col gap-2 px-5 py-4">
            <Skeleton className="w-28" />
            <Skeleton className="w-40" />
            <Skeleton className="w-36" />
          </Card>
          <Card className="overflow-hidden">
            <SkeletonRows rows={4} inset />
          </Card>
        </div>
      ) : data === null ? (
        <Card>
          <EmptyState title={t("loadError")} icon="↻" />
        </Card>
      ) : rules.length === 0 ? (
        <Card className="reveal">
          <EmptyState
            title={t("empty")}
            hint={t("emptyHint")}
            icon="↻"
            action={<Button onClick={() => openForm(null)}>{t("newRule")}</Button>}
          />
        </Card>
      ) : (
        <>
          {/* Summary: what the unpaused rules post every month, and the viewer's part of it. */}
          <Card className="reveal px-5 py-4">
            <p className="label-mono text-faint">{t("monthlyTotal")}</p>
            <Money value={data.summary.monthlyTotal} className="mt-1 block font-display text-2xl font-bold" />
            <p className="mt-1 text-xs text-faint">
              {t("counts", { active: data.summary.activeCount, paused: data.summary.pausedCount })}
            </p>
            <ReceiptDivider className="my-3" />
            <p className="text-sm text-ink-soft">
              {t.rich("yourShare", {
                amount: formatMoney(data.summary.myMonthlyShare, currency, locale),
                b: (chunks) => <b className="whitespace-nowrap font-bold text-ink tnum tabular-nums">{chunks}</b>,
              })}
            </p>
          </Card>

          <Button onClick={() => openForm(null)} className="w-full md:w-auto md:self-start">
            {t("newRule")}
          </Button>

          <div role="tablist" aria-label={t("title")} className="grid grid-cols-3 gap-1 md:flex">
            {tabs.map(({ id, label }) => (
              <button
                key={id}
                id={`recurring-tab-${id}`}
                type="button"
                role="tab"
                aria-selected={tab === id}
                aria-controls={`recurring-panel-${id}`}
                tabIndex={tab === id ? 0 : -1}
                onClick={() => setTab(id)}
                onKeyDown={onTabKey}
                className={cn(
                  // ring-inset: an offset ring is clipped by the neighbours (same as the other segmented toggles).
                  "min-h-11 rounded-md border px-2 py-1.5 text-xs font-display font-bold uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-stamp md:min-h-0 md:px-3",
                  tab === id ? "border-ink bg-ink text-paper" : "border-rule bg-card text-ink-soft hover:bg-panel"
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {/* tabIndex 0 on every panel (WAI-ARIA tabs): Posted, and Upcoming for a non-manager, hold nothing focusable. */}
          <section id="recurring-panel-rules" role="tabpanel" aria-labelledby="recurring-tab-rules" tabIndex={0} hidden={tab !== "rules"}>
            <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {rules.map((rule, i) => (
                <li key={rule.publicId} className="reveal" style={revealDelay(i)}>
                  <RecurringRuleCard
                    rule={rule}
                    busy={busy.has(rule.publicId)}
                    onSkip={(period) => void setSkipped(rule, period, true)}
                    onUnskip={(period) => void setSkipped(rule, period, false)}
                    onPause={() => void setPaused(rule, true)}
                    onResume={() => void setPaused(rule, false)}
                    onEdit={() => openForm(rule)}
                    onDelete={() => setDeleteTarget(rule)}
                  />
                </li>
              ))}
            </ul>
          </section>

          <section id="recurring-panel-upcoming" role="tabpanel" aria-labelledby="recurring-tab-upcoming" tabIndex={0} hidden={tab !== "upcoming"}>
            {upcomingRows.length === 0 ? (
              <Card>
                <p className="px-4 py-8 text-center text-sm text-faint">{t("upcoming.empty")}</p>
              </Card>
            ) : (
              <Card>
                <ul>
                  {upcomingRows.map((row, i) => (
                    <li key={`${row.rule.publicId}:${row.period}`} className="reveal" style={revealDelay(i)}>
                      {i > 0 && <ReceiptDivider />}
                      <UpcomingItem
                        row={row}
                        busy={busy.has(row.rule.publicId)}
                        onToggle={() => void setSkipped(row.rule, row.period, !row.skipped)}
                      />
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </section>

          <section id="recurring-panel-posted" role="tabpanel" aria-labelledby="recurring-tab-posted" tabIndex={0} hidden={tab !== "posted"}>
            {data.history.length === 0 ? (
              <Card>
                <p className="px-4 py-8 text-center text-sm text-faint">{t("posted.empty")}</p>
              </Card>
            ) : (
              <Card>
                <ul>
                  {data.history.map((item, i) => (
                    <li key={`${item.rule.publicId}:${item.period}`} className="reveal" style={revealDelay(i)}>
                      {i > 0 && <ReceiptDivider />}
                      <PostedItem item={item} />
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </section>
        </>
      )}

      <RecurringExpenseFormModal
        key={form.key}
        open={form.open}
        onOpenChange={(open) => setForm((f) => ({ ...f, open }))}
        rule={form.rule}
        onChanged={() => void load()}
      />

      {/* Delete: question title, statement body closed by the irreversibility sentence (R3-33). */}
      <Modal
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={t("deleteTitle")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              {tc("cancel")}
            </Button>
            <Button variant="danger" loading={deleting} onClick={confirmDelete}>
              {t("delete")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink">
          {t("deleteBody")} {te("deleteUndoNote")}
        </p>
        {deleteTarget && (
          <p className="mt-3 flex items-baseline justify-between gap-3 rounded-md border border-dashed border-rule bg-panel/40 p-3 text-sm">
            <span className="min-w-0 break-words text-ink">{deleteTarget.description}</span>
            <Money value={deleteTarget.amount} className="shrink-0 text-ink-soft" />
          </p>
        )}
      </Modal>
    </div>
  );
}

/** Day + short month of a due date; the full date is read out instead of the two pieces. */
function DateBlock({ date }: { date: string }) {
  const locale = useLocale();
  return (
    <span className="flex w-11 shrink-0 flex-col items-center rounded-md border border-rule bg-panel/40 py-1">
      <span aria-hidden className="font-display text-base font-bold leading-tight text-ink tnum">{date.slice(8, 10)}</span>
      <span aria-hidden className="text-xs uppercase leading-tight text-faint">{monthName(date.slice(0, 7), locale, "short")}</span>
      <span className="sr-only">{dueDateLabel(date)}</span>
    </span>
  );
}

function UpcomingItem({ row, busy, onToggle }: { row: UpcomingRow; busy: boolean; onToggle: () => void }) {
  const t = useTranslations("Recurring");
  const locale = useLocale();
  const { members } = useSession();
  // Same-month rows would all read "Skip November": the button is described by its rule's name.
  const descriptionId = useId();
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <DateBlock date={row.dueOn} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span id={descriptionId} className="break-words text-sm font-medium text-ink">{row.rule.description}</span>
            <RecurringTag label={t("posted.recurringTag")} />
          </p>
          <Money value={row.rule.amount} className="shrink-0 font-bold" />
        </div>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
          {row.skipped ? (
            <Stamp tone="ink">{t("upcoming.skipped")}</Stamp>
          ) : (
            <span className="text-xs text-faint">{t("upcoming.auto", { count: shareMembers(row.rule, members).count })}</span>
          )}
          {row.rule.canManage && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={onToggle} aria-describedby={descriptionId}>
              {row.skipped ? t("undoSkip") : t("skipMonth", { month: monthName(row.period, locale) })}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function PostedItem({ item }: { item: RecurringHistoryItem }) {
  const t = useTranslations("Recurring");
  const { members } = useSession();
  const payer = item.expense ? members.find((m) => m.id === item.expense?.payerId) : undefined;
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <DateBlock date={item.dueOn} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="break-words text-sm font-medium text-ink">{item.rule.description}</span>
            {item.status === "SKIPPED" ? <Stamp tone="ink">{t("upcoming.skipped")}</Stamp> : <RecurringTag label={t("posted.recurringTag")} />}
          </p>
          {item.expense ? (
            <Money value={item.expense.amount} className="shrink-0 font-bold" />
          ) : (
            <span className="shrink-0 text-sm text-faint" aria-hidden>—</span>
          )}
        </div>
        <p className="mt-1 flex items-center gap-1.5 text-xs text-faint">
          {item.status === "SKIPPED" ? (
            t("posted.skippedNothing")
          ) : item.expense ? (
            <>
              <MemberDot colorIndex={payer?.colorIndex ?? 0} name={payer?.name ?? ""} size={18} />
              {t("upcoming.auto", { count: item.expense.participantCount })}
            </>
          ) : (
            t("posted.expenseDeleted")
          )}
        </p>
      </div>
    </div>
  );
}
