"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import { money } from "@/lib/format";
import type { Expense, ExpenseListResponse } from "@/lib/types";

export interface UseInfiniteExpensesResult {
  items: Expense[];
  total: number;
  totalAmount: number;
  payerTotals: NonNullable<ExpenseListResponse["pagination"]["payerTotals"]>;
  initialLoading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: unknown;
  loadMore: () => void;
  reload: () => void;
}

/**
 * Infinite-scroll pagination over /api/expenses (BL-20/P3 — replaces the old "fetch everything
 * with pageSize=100000" pattern). Re-fetches from page 1 whenever `buildUrl`'s identity changes
 * (the caller must useCallback it, keyed on sort/filters) or the active house changes; `loadMore`
 * appends the next page. A request counter discards stale responses from rapid filter/sort
 * changes — same guard `useFetch` uses, needed here too since this hook accumulates state instead
 * of just replacing it.
 */
export function useInfiniteExpenses(
  buildUrl: (page: number) => string,
  opts: { onError?: (error: unknown) => void; enabled?: boolean } = {}
): UseInfiniteExpensesResult {
  const { activeGroup } = useSession();
  const [items, setItems] = useState<Expense[]>([]);
  const [total, setTotal] = useState(0);
  const [totalAmount, setTotalAmount] = useState(0);
  const [payerTotals, setPayerTotals] = useState<NonNullable<ExpenseListResponse["pagination"]["payerTotals"]>>([]);
  const [page, setPage] = useState(1);
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const reqId = useRef(0);
  const buildUrlRef = useRef(buildUrl);
  buildUrlRef.current = buildUrl;
  const onErrorRef = useRef(opts.onError);
  onErrorRef.current = opts.onError;
  const enabled = opts.enabled ?? true;

  const fetchPage = useCallback(async (targetPage: number, replace: boolean) => {
    const id = ++reqId.current;
    if (replace) setInitialLoading(true);
    else setLoadingMore(true);
    try {
      const res = await api.get<ExpenseListResponse>(buildUrlRef.current(targetPage));
      if (reqId.current !== id) return;
      setItems((prev) => (replace ? res.expenses : [...prev, ...res.expenses]));
      setTotal(res.pagination.total);
      setTotalAmount(money(res.pagination.totalAmount));
      setPayerTotals(res.pagination.payerTotals ?? []);
      setPage(targetPage);
      setError(null);
    } catch (e) {
      if (reqId.current !== id) return;
      setError(e);
      onErrorRef.current?.(e);
    } finally {
      if (reqId.current === id) {
        setInitialLoading(false);
        setLoadingMore(false);
      }
    }
  }, []);

  // Reset + refetch page 1 whenever the query shape (buildUrl identity) or the active house
  // changes — a stale page 2+ from the PREVIOUS filter/sort must never linger in `items`.
  useEffect(() => {
    if (!enabled) return;
    setItems([]);
    setTotal(0);
    setTotalAmount(0);
    setPayerTotals([]);
    setPage(1);
    fetchPage(1, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchPage is stable (empty deps); buildUrl's identity is the caller's signal to refetch
  }, [buildUrl, activeGroup?.id, enabled]);

  const hasMore = items.length < total;

  // Mirrored into a ref (read by the STABLE `loadMore` below) instead of `loadMore` depending on
  // these values directly. A consumer typically wires `loadMore` into an IntersectionObserver —
  // if `loadMore`'s identity changed on every page load, that observer would tear down and
  // reconnect after every fetch, and `.observe()` fires an immediate callback on reconnect. If
  // the sentinel is still within the viewport margin at that moment, that immediate callback
  // would trigger yet another `loadMore`, auto-cascading through pages with no real scroll.
  const stateRef = useRef({ loadingMore, initialLoading, hasMore, page });
  stateRef.current = { loadingMore, initialLoading, hasMore, page };

  const loadMore = useCallback(() => {
    const s = stateRef.current;
    if (s.loadingMore || s.initialLoading || !s.hasMore) return;
    fetchPage(s.page + 1, false);
  }, [fetchPage]);

  const reload = useCallback(() => {
    setPage(1);
    fetchPage(1, true);
  }, [fetchPage]);

  return { items, total, totalAmount, payerTotals, initialLoading, loadingMore, hasMore, error, loadMore, reload };
}
