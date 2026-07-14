"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { api } from "@/lib/api";
import { useApiError } from "@/lib/api-errors";
import { useSession } from "@/lib/session";
import { formatDateLocale, formatMoney } from "@/lib/money";
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
  onClose,
  onSaved,
}: {
  item: ShoppingItem | null;
  onClose: () => void;
  onSaved: (item: ShoppingItem) => void;
}) {
  const t = useTranslations("Shopping");
  const locale = useLocale();
  const { activeGroup } = useSession();
  const apiError = useApiError();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ShoppingLinkedExpense[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    if (!item) return;
    setQuery("");
    setResults([]);
    setSelected(new Set(item.linkedExpenses.map((expense) => expense.publicId)));
  }, [item]);

  const loadExpenses = useCallback(async (search: string) => {
    const id = ++requestId.current;
    setLoading(true);
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
      }
    } catch (error) {
      if (requestId.current === id) toast(apiError(error, t("linkLoadError")), "error");
    } finally {
      if (requestId.current === id) setLoading(false);
    }
  }, [apiError, t, toast]);

  useEffect(() => {
    if (!item) return;
    const timer = window.setTimeout(() => void loadExpenses(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [item, loadExpenses, query]);

  const visibleExpenses = useMemo(() => {
    if (!item || query.trim()) return results;
    const ids = new Set(results.map((expense) => expense.publicId));
    return [...item.linkedExpenses.filter((expense) => !ids.has(expense.publicId)), ...results];
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
          <Button variant="secondary" size="sm" onClick={onClose}>{t("skipLinks")}</Button>
          <Button size="sm" loading={saving} onClick={() => void save()}>
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

        {loading && visibleExpenses.length === 0 ? (
          <div className="grid min-h-32 place-items-center text-faint"><Spinner /></div>
        ) : visibleExpenses.length === 0 ? (
          <EmptyState title={t("noExpensesFound")} icon="⌕" />
        ) : (
          <div className="max-h-[48dvh] overflow-y-auto rounded-md border border-rule">
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
                    <span className="block truncate text-sm text-ink">{expense.description}</span>
                    <span className="block text-xs text-faint tnum">{formatDateLocale(expense.date)}</span>
                  </span>
                  <span className="shrink-0 text-sm font-semibold text-ink tnum">
                    {formatMoney(expense.amount, currency, locale)}
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}
