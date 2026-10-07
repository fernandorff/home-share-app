"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "@/lib/api";
import { useApiError } from "@/lib/api-errors";
import { useSession } from "@/lib/session";
import { formatDateLocale, formatMoney } from "@/lib/money";
import { orderLinkedFirst } from "@/lib/shopping-link-order";
import type { ExpenseListResponse, ShoppingItem, ShoppingLinkedExpense } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Modal";
import { EmptyState, Spinner } from "@/components/ui/Feedback";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/components/ui/cn";

const PAGE_SIZE = 50;

export function ExpenseLinkModal({
  item,
  justPurchased,
  onClose,
  onSaved,
}: {
  item: ShoppingItem | null;
  /** Which flow opened the modal (B8): right after marking the item purchased, or editing its
   * links from the item menu. The item's own data can't tell these apart — an item can reach the
   * menu's "Link expenses" action with zero links too — so the caller passes it explicitly. */
  justPurchased: boolean;
  onClose: () => void;
  onSaved: (item: ShoppingItem) => void;
}) {
  const t = useTranslations("Shopping");
  const tc = useTranslations("Common");
  const locale = useLocale();
  const { activeGroup } = useSession();
  const apiError = useApiError();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ShoppingLinkedExpense[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    if (!item) return;
    setQuery("");
    setResults([]);
    setTotal(0);
    setSelected(new Set(item.linkedExpenses.map((expense) => expense.publicId)));
  }, [item]);

  const loadExpenses = useCallback(async (search: string) => {
    const id = ++requestId.current;
    setLoading(true);
    // Reset up front so a superseded/failed request can't leave a stale `total` behind for the
    // 50-cap notice below — it only gets restored (in the success branch) once the matching
    // response actually lands.
    setTotal(0);
    try {
      const params = new URLSearchParams({
        page: "1",
        pageSize: String(PAGE_SIZE),
        sortField: "date",
        sortDirection: "desc",
      });
      if (search) params.set("query", search);
      const response = await api.get<ExpenseListResponse>(`/api/expenses?${params}`);
      if (requestId.current === id) {
        setResults(response.expenses.map(({ publicId, description, amount, date }) => ({
          publicId,
          description,
          amount: String(amount),
          date,
        })));
        setTotal(response.pagination.total);
      }
    } catch (error) {
      if (requestId.current === id) {
        toast(apiError(error, t("linkLoadError")), "error");
        setTotal(0);
      }
    } finally {
      if (requestId.current === id) setLoading(false);
    }
  }, [apiError, t, toast]);

  useEffect(() => {
    if (!item) return;
    const timer = window.setTimeout(() => void loadExpenses(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [item, loadExpenses, query]);

  // Linked-first grouping only applies to the unfiltered page (B8) — a search is the person
  // hunting for one specific expense, so plain date order is more useful there.
  const { expenses: visibleExpenses, linkedCount } = useMemo(() => {
    if (!item || query.trim()) return { expenses: results, linkedCount: 0 };
    return orderLinkedFirst(results, item.linkedExpenses);
  }, [item, query, results]);

  const toggle = (publicId: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(publicId)) next.delete(publicId);
      else next.add(publicId);
      return next;
    });
  };

  const save = async () => {
    if (!item || !activeGroup || saving) return;
    setSaving(true);
    try {
      const response = await api.put<{ item: ShoppingItem }>(
        `/api/shopping-items/${item.publicId}/expenses`,
        { expenseIds: [...selected], expectedGroupId: activeGroup.id }
      );
      onSaved(response.item);
      toast(t("linksSaved"), "success");
    } catch (error) {
      toast(apiError(error, t("linkSaveError")), "error");
    } finally {
      setSaving(false);
    }
  };

  const currency = activeGroup?.currency ?? "BRL";

  return (
    <Modal
      open={item !== null}
      onOpenChange={(open) => !open && onClose()}
      title={t("linkExpensesTitle")}
      description={item ? t("linkExpensesDescription", { item: item.name }) : undefined}
      className="sm:max-w-xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {justPurchased ? t("skipLinks") : tc("cancel")}
          </Button>
          <Button loading={saving} onClick={() => void save()}>
            {t("saveLinks", { count: selected.size })}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("searchExpenses")}
          aria-label={t("searchExpenses")}
          autoComplete="off"
        />
        <p className="label-mono">{t("selectedExpenses", { count: selected.size })}</p>

        {/* U16: every branch gets the same FIXED height (not min/max) so the sheet's overall size
            never changes between loading/empty/populated states or as a search narrows the list.
            svh (not dvh) so it also stays put if the mobile browser chrome or keyboard shows. */}
        {loading && visibleExpenses.length === 0 ? (
          <div className="grid h-[40svh] place-items-center text-faint"><Spinner /></div>
        ) : visibleExpenses.length === 0 ? (
          <div className="grid h-[40svh] place-items-center">
            <EmptyState title={t("noExpensesFound")} icon="⌕" />
          </div>
        ) : (
          <div className="h-[40svh] overflow-y-auto rounded-md border border-rule">
            {linkedCount > 0 && (
              <p className="label-mono border-b border-dotted border-rule bg-panel/60 px-3 py-1.5">
                {t("linkedSection")}
              </p>
            )}
            {visibleExpenses.map((expense, index) => {
              const checked = selected.has(expense.publicId);
              return (
                <label
                  key={expense.publicId}
                  className={cn(
                    "flex min-h-14 cursor-pointer items-center gap-3 px-3 py-2 transition-colors",
                    index > 0 && "border-t border-dotted border-rule",
                    checked ? "bg-panel" : "hover:bg-panel/60"
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(expense.publicId)}
                    className="h-5 w-5 shrink-0 accent-ink"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block line-clamp-2 break-words text-sm text-ink">{expense.description}</span>
                    <span className="block text-xs text-faint tnum">{formatDateLocale(expense.date)}</span>
                  </span>
                  <span className="shrink-0 text-sm font-semibold text-ink tnum">
                    {formatMoney(expense.amount, currency, locale)}
                  </span>
                </label>
              );
            })}
            {/* B8 (fix round 2): rendered as the last row INSIDE the scroll container — not
                below it — so it scrolls with the list instead of changing the fixed h-[40svh]
                sheet height when a search hides it. Plain <p> (no checkbox/label), so it can't
                be picked up as an extra selectable option. Uses the API's exact
                `pagination.total` (not `results.length`, which is always <= PAGE_SIZE) so a
                house with exactly PAGE_SIZE expenses doesn't see a false "more results" notice. */}
            {!loading && !query.trim() && total > PAGE_SIZE && (
              <p className="border-t border-dotted border-rule px-3 py-3 text-center text-xs text-faint">
                {t("linkResultsCapped", { count: PAGE_SIZE })}
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
