"use client";

import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useFetch } from "@/lib/use-fetch";
import { useInfiniteExpenses } from "@/lib/use-infinite-expenses";
import { buildExpenseQuery } from "@/lib/expense-query";
import { useTranslations, useLocale } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Money } from "@/components/ui/Money";
import { MemberDot } from "@/components/ui/Member";
import { Tag } from "@/components/ui/Stamp";
import { Modal } from "@/components/ui/Modal";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { EmptyState } from "@/components/ui/Feedback";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { revealDelay } from "@/components/ui/motion";
import { cn } from "@/components/ui/cn";
import { useToast } from "@/components/ui/Toast";
import { useSession } from "@/lib/session";
import { api } from "@/lib/api";
import { useApiError } from "@/lib/api-errors";
import { formatDateLocale } from "@/lib/money";
import { money } from "@/lib/format";
import { memberStyle } from "@/lib/members";
import { toCents } from "@/lib/currency";
import { detectSplitEqually } from "@/lib/split";
import type { Expense, ExpenseListResponse, ExpenseSortField, Platform, Category, PaymentMethod, Member } from "@/lib/types";
import { ExpenseFormModal } from "@/components/expenses/ExpenseFormModal";
import { ExpenseDetailModal } from "@/components/expenses/ExpenseDetailModal";
import { ImportCsvModal } from "@/components/expenses/ImportCsvModal";
import { ExpenseFiltersModal, EMPTY_FILTERS, type ExpenseFilters } from "@/components/expenses/ExpenseFiltersModal";

type SortDirection = "asc" | "desc";
type ViewMode = "list" | "byPayer";

// List view: true infinite scroll (BL-20/P3). By-person still needs the FULL matching set to
// group/total correctly, so it keeps the old "load everything" cap — just server-filtered now,
// and only fetched once that tab is actually opened.
const LIST_PAGE_SIZE = 50;
const BY_PERSON_PAGE_SIZE = 100_000;

// Stable "empty" references (module scope, never mutated) — clearFilters() below resets to
// THESE instead of fresh `[]` literals, so clearing already-empty filters (e.g. on mount, or on
// every house switch via the reset effect) is a true no-op React can bail out of. Without this,
// each `[]` literal is a new reference, so `appliedFilters`'s useMemo sees "changed" deps and
// recomputes, cascading into an extra, unnecessary refetch (the exact "unstable callback → refetch
// loop" footgun already documented elsewhere in this file's history).
const EMPTY_IDS: number[] = [];
const EMPTY_STRINGS: string[] = [];

interface SortableCol {
  field: ExpenseSortField;
  labelKey: string;
  className?: string;
}

const COLUMNS: SortableCol[] = [
  { field: "description", labelKey: "colDescription" },
  { field: "payer", labelKey: "colPayer" },
  { field: "amount", labelKey: "colAmount", className: "text-right" },
];

interface MonthGroup {
  key: string;
  label: string;
  subtotal: number;
  items: Expense[];
}
interface PersonGroup {
  payerId: number;
  name: string;
  colorIndex: number;
  total: number;
  months: MonthGroup[];
}

/** "Junho / 2026" — locale-aware month, capitalized. */
function monthLabel(d: Date, locale: string): string {
  const m = new Intl.DateTimeFormat(locale, { month: "long" }).format(d);
  return `${m.charAt(0).toUpperCase()}${m.slice(1)} / ${d.getFullYear()}`;
}

function SortIndicator({
  active,
  direction,
}: {
  active: boolean;
  direction: SortDirection;
}) {
  if (!active) return <span className="text-faint">↕</span>;
  return <span className="text-stamp">{direction === "asc" ? "▲" : "▼"}</span>;
}

export default function DespesasPage() {
  const { activeGroup, members, me } = useSession();
  const toast = useToast();
  const t = useTranslations("Expenses");
  const tc = useTranslations("Common");
  const apiErr = useApiError();
  const locale = useLocale();

  const [sortField, setSortField] = useState<ExpenseSortField>("date");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [view, setView] = useState<ViewMode>("list");
  const [personTab, setPersonTab] = useState<number | null>(null);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);

  // Filters are applied server-side (BL-20/P3) so infinite scroll only fetches what matches.
  // Tag filters hold one default-key-or-custom-name.
  const [query, setQuery] = useState("");
  const [payerFilters, setPayerFilters] = useState<number[]>(EMPTY_IDS);
  const [platformFilters, setPlatformFilters] = useState<string[]>(EMPTY_STRINGS);
  const [categoryFilters, setCategoryFilters] = useState<string[]>(EMPTY_STRINGS);
  const [paymentFilters, setPaymentFilters] = useState<string[]>(EMPTY_STRINGS);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Checkboxes are hidden until the user enters selection mode (the "Selecionar" button).
  const [selectionMode, setSelectionMode] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [viewing, setViewing] = useState<Expense | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [filterModalOpen, setFilterModalOpen] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<Expense | null>(null);
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let active = true;
    api
      .get<{ platforms: Platform[] }>("/api/platforms")
      .then((res) => active && setPlatforms(res.platforms))
      .catch(() => active && setPlatforms([]));
    api
      .get<{ categories: Category[] }>("/api/categories")
      .then((res) => active && setCategories(res.categories))
      .catch(() => active && setCategories([]));
    api
      .get<{ paymentMethods: PaymentMethod[] }>("/api/payment-methods")
      .then((res) => active && setPaymentMethods(res.paymentMethods))
      .catch(() => active && setPaymentMethods([]));
    return () => {
      active = false;
    };
  }, [activeGroup?.id]);

  // Switching houses must not leak the previous house's filters / person tab / selection
  // (they reference member ids and publicIds that don't exist in the new house).
  useEffect(() => {
    clearFilters();
    setPersonTab(null);
    setSelected(new Set());
    setSelectionMode(false);
  }, [activeGroup?.id]);

  const activeFilterCount =
    (query.trim() !== "" ? 1 : 0) +
    payerFilters.length +
    platformFilters.length +
    categoryFilters.length +
    paymentFilters.length +
    (fromDate !== "" ? 1 : 0) +
    (toDate !== "" ? 1 : 0);
  const filtersActive = activeFilterCount > 0;

  function clearFilters() {
    setQuery("");
    setPayerFilters(EMPTY_IDS);
    setPlatformFilters(EMPTY_STRINGS);
    setCategoryFilters(EMPTY_STRINGS);
    setPaymentFilters(EMPTY_STRINGS);
    setFromDate("");
    setToDate("");
  }

  // The currently-applied filters, as one object — the modal's starting draft.
  const appliedFilters = useMemo<ExpenseFilters>(
    () => ({
      query,
      payers: payerFilters,
      platforms: platformFilters,
      categories: categoryFilters,
      payments: paymentFilters,
      fromDate,
      toDate,
    }),
    [query, payerFilters, platformFilters, categoryFilters, paymentFilters, fromDate, toDate]
  );

  // Commit a draft from the modal (the only path that runs a search, besides chip removal).
  function applyFilters(f: ExpenseFilters) {
    setQuery(f.query);
    setPayerFilters(f.payers);
    setPlatformFilters(f.platforms);
    setCategoryFilters(f.categories);
    setPaymentFilters(f.payments);
    setFromDate(f.fromDate);
    setToDate(f.toDate);
  }

  // ===== List view: true infinite scroll, server-sorted/filtered (BL-20/P3). =====
  const buildListUrl = useCallback(
    (page: number) => buildExpenseQuery({ page, pageSize: LIST_PAGE_SIZE, sortField, sortDirection, filters: appliedFilters }),
    [sortField, sortDirection, appliedFilters]
  );
  const listState = useInfiniteExpenses(buildListUrl, {
    onError: (err) => toast(apiErr(err, t("loadError")), "error"),
  });

  // ===== By-person view: needs the full matching set to group/total correctly, so it loads
  // everything (like the old model) — but only once the tab is actually opened, and it respects
  // the same server-side filters as the list. =====
  const [byPersonRequested, setByPersonRequested] = useState(false);
  useEffect(() => {
    if (view === "byPayer") setByPersonRequested(true);
  }, [view]);
  const byPersonUrl = useMemo(
    () => buildExpenseQuery({ page: 1, pageSize: BY_PERSON_PAGE_SIZE, sortField: "date", sortDirection: "desc", filters: appliedFilters }),
    [appliedFilters]
  );
  const { data: byPersonData, loading: byPersonLoading, reload: reloadByPerson } = useFetch<ExpenseListResponse>(
    byPersonUrl,
    { enabled: byPersonRequested, onError: (err) => toast(apiErr(err, t("loadError")), "error") }
  );

  // True house total, used only to tell "no expenses at all" apart from "no results for this
  // filter". When NO filter is active, `listState.total` already IS the real house total, so we
  // skip this fetch entirely (perf: dropped a redundant round trip on the common unfiltered load).
  // Only when a filter is active do we need a dedicated pageSize=1 probe — reusing the filtered
  // `listState.total` there would say 0 for "no matches" without telling us if the house is empty.
  const houseTotalUrl = useMemo(
    () => buildExpenseQuery({ page: 1, pageSize: 1, sortField: "date", sortDirection: "desc", filters: EMPTY_FILTERS }),
    []
  );
  const { data: houseTotalData, reload: reloadHouseTotal } = useFetch<ExpenseListResponse>(
    houseTotalUrl,
    { enabled: filtersActive }
  );
  const unfilteredTotal = filtersActive ? (houseTotalData?.pagination.total ?? null) : listState.total;

  function reloadAll() {
    listState.reload();
    if (byPersonRequested) reloadByPerson();
    if (filtersActive) reloadHouseTotal();
  }

  // Infinite-scroll sentinel — loads the next page once it enters the viewport. A callback ref
  // (not useRef+useEffect) because the sentinel <div> only exists in the DOM while `hasMore` is
  // true — React invokes this exactly when that div mounts/unmounts, so the observer is always
  // attached to the CURRENT element. (An effect keyed on `loadMore`'s — now stable — identity
  // would only run once at the initial mount, when `hasMore` still starts false and the div
  // isn't there yet, and would never reattach once it actually appears.)
  const sentinelObserverRef = useRef<IntersectionObserver | null>(null);
  const sentinelRef = useCallback((el: HTMLDivElement | null) => {
    sentinelObserverRef.current?.disconnect();
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) listState.loadMore();
      },
      { rootMargin: "400px" }
    );
    observer.observe(el);
    sentinelObserverRef.current = observer;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only `loadMore` (stable); re-runs per DOM mount/unmount, not per render
  }, [listState.loadMore]);

  // Built-in tag keys translate; custom names render as-is.
  const tagLabel = (ns: string, v: string) => (t.has(`${ns}.${v}`) ? t(`${ns}.${v}`) : v);
  const brDate = (iso: string) => iso.split("-").reverse().join("/");
  // Applied filters as removable chips — one per selected value (each × clears just that one).
  const filterChips: { key: string; label: string; value: string; remove: () => void }[] = [];
  if (query.trim()) filterChips.push({ key: "q", label: t("searchLabel"), value: query.trim(), remove: () => setQuery("") });
  payerFilters.forEach((id) =>
    filterChips.push({ key: `payer-${id}`, label: t("colPayer"), value: members.find((m) => m.id === id)?.name ?? String(id), remove: () => setPayerFilters((prev) => prev.filter((x) => x !== id)) })
  );
  platformFilters.forEach((p) =>
    filterChips.push({ key: `plat-${p}`, label: t("platformLabel"), value: tagLabel("platform", p), remove: () => setPlatformFilters((prev) => prev.filter((x) => x !== p)) })
  );
  categoryFilters.forEach((c) =>
    filterChips.push({ key: `cat-${c}`, label: t("categoryLabel"), value: tagLabel("category", c), remove: () => setCategoryFilters((prev) => prev.filter((x) => x !== c)) })
  );
  paymentFilters.forEach((p) =>
    filterChips.push({ key: `pay-${p}`, label: t("paymentLabel"), value: tagLabel("payment", p), remove: () => setPaymentFilters((prev) => prev.filter((x) => x !== p)) })
  );
  if (fromDate) filterChips.push({ key: "from", label: t("filterFrom"), value: brDate(fromDate), remove: () => setFromDate("") });
  if (toDate) filterChips.push({ key: "to", label: t("filterTo"), value: brDate(toDate), remove: () => setToDate("") });

  const byPersonExpenses = useMemo(() => byPersonData?.expenses ?? [], [byPersonData]);

  // By person → grouped by month (newest first).
  const byPerson = useMemo<PersonGroup[]>(() => {
    return members.map((m) => {
      const monthsMap = new Map<string, MonthGroup>();
      let total = 0;
      for (const e of byPersonExpenses) {
        if (e.payerId !== m.id) continue;
        const amt = money(e.amount);
        total += amt;
        const d = new Date(e.date);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        let mg = monthsMap.get(key);
        if (!mg) {
          mg = { key, label: monthLabel(d, locale), subtotal: 0, items: [] };
          monthsMap.set(key, mg);
        }
        mg.subtotal += amt;
        mg.items.push(e);
      }
      const monthsArr = Array.from(monthsMap.values()).sort((a, b) =>
        b.key.localeCompare(a.key)
      );
      return { payerId: m.id, name: m.name, colorIndex: m.colorIndex, total, months: monthsArr };
    });
  }, [byPersonExpenses, members, locale]);

  const byPersonEmpty = byPerson.every((p) => p.months.length === 0);
  // Mobile by-person shows one person at a time (desktop keeps both columns).
  // Default to the logged-in user when they're a member, else the first member.
  const meId = me?.user.id;
  const selectedPersonId =
    personTab ?? (members.some((m) => m.id === meId) ? meId : members[0]?.id) ?? null;
  const selectedCount = selected.size;
  const allSelected = listState.items.length > 0 && listState.items.every((e) => selected.has(e.publicId));

  function toggleSort(field: ExpenseSortField) {
    if (field === sortField) setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortField(field);
      setSortDirection("desc");
    }
  }

  // useCallback so memo'd <ExpenseRow>/<ExpenseCard> get stable handler identities and a
  // checkbox toggle re-renders only the affected row (not all ~300).
  const toggleRow = useCallback((publicId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(publicId)) next.delete(publicId);
      else next.add(publicId);
      return next;
    });
  }, []);

  function toggleSelectAll() {
    setSelected(allSelected ? new Set() : new Set(listState.items.map((e) => e.publicId)));
  }

  function openCreate() {
    setEditing(null);
    setFormOpen(true);
  }
  const openEdit = useCallback((expense: Expense) => {
    setEditing(expense);
    setFormOpen(true);
  }, []);
  const openView = useCallback((expense: Expense) => setViewing(expense), []);

  // O(1) payerId → colorIndex (was a per-row members.find).
  const colorByPayer = useMemo(() => {
    const m = new Map<number, number>();
    members.forEach((mm) => m.set(mm.id, mm.colorIndex));
    return m;
  }, [members]);

  // Provided to the row checkboxes; new identity only when the selection actually changes.
  const selectionValue = useMemo(() => ({ selected, toggle: toggleRow }), [selected, toggleRow]);

  // Render the row elements once and reuse them — note: NOT keyed on `selected`. So toggling
  // selection doesn't even re-create/diff 300 elements; React bails out of the row subtree and
  // only the context-subscribed checkboxes update.
  const desktopRows = useMemo(
    () => listState.items.map((e, i) => (
      <ExpenseRow key={e.publicId} expense={e} rowNumber={i + 1} colorIndex={colorByPayer.get(e.payerId) ?? 0}
        members={members} selectionMode={selectionMode} onView={openView} onEdit={openEdit} onDelete={setDeleteTarget} />
    )),
    [listState.items, colorByPayer, members, selectionMode, openView, openEdit]
  );
  const mobileCards = useMemo(
    () => listState.items.map((e) => (
      <ExpenseCard key={e.publicId} expense={e} colorIndex={colorByPayer.get(e.payerId) ?? 0}
        members={members} selectionMode={selectionMode} onView={openView} onEdit={openEdit} onDelete={setDeleteTarget} onToggle={toggleRow} />
    )),
    [listState.items, colorByPayer, members, selectionMode, openView, openEdit, toggleRow]
  );

  async function confirmDeleteOne() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.del(`/api/expenses/${deleteTarget.publicId}`);
      toast(t("toastDeleted"), "success");
      setDeleteTarget(null);
      reloadAll();
    } catch (err) {
      toast(apiErr(err, t("deleteError")), "error");
    } finally {
      setDeleting(false);
    }
  }

  async function confirmBulkDelete() {
    const publicIds = Array.from(selected);
    if (publicIds.length === 0) return;
    setDeleting(true);
    try {
      const res = await api.post<{ deleted: number }>("/api/expenses/bulk-delete", { publicIds });
      toast(t("toastBulkDeleted", { count: res.deleted }), "success");
      setBulkConfirm(false);
      setSelected(new Set());
      reloadAll();
    } catch (err) {
      toast(apiErr(err, t("bulkDeleteError")), "error");
    } finally {
      setDeleting(false);
    }
  }

  const total = listState.total;

  return (
    <div className="flex flex-col gap-5">
      {/* Header — a real <h1> (was a SectionTitle/h2) so every page shares the same title tag
          (U7/BL-33); kept at the same compact size since, unlike other pages, this row also
          carries the CSV/New-expense actions and a 2xl title risks overflowing on mobile (the
          same class of bug fixed in BL-12). */}
      <div className="flex items-center gap-3">
        <h1 className="font-display text-sm font-bold uppercase tracking-wider text-ink whitespace-nowrap">
          {t("title")}{" "}
          {!listState.initialLoading && (
            <span className="font-normal text-faint">({total})</span>
          )}
        </h1>
        <span className="flex-1 border-t border-dashed border-rule" aria-hidden />
        <div className="flex items-center gap-2">
          <Menu
            align="end"
            trigger={
              <button className="inline-flex items-center gap-1.5 rounded-md border border-ink bg-card px-3 py-2 text-[0.7rem] font-display font-bold uppercase tracking-wider text-ink transition-colors hover:bg-panel">
                CSV <span className="text-faint">▾</span>
              </button>
            }
          >
            <MenuItem onSelect={() => setImportOpen(true)}>{t("importCsv")}</MenuItem>
            <MenuSeparator />
            <MenuItem>
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- API download endpoint, not a page route */}
              <a href="/api/expenses/export" className="flex w-full items-center">
                {t("exportCsv")}
              </a>
            </MenuItem>
          </Menu>
          <Button size="sm" onClick={openCreate}>
            {t("newExpense")}
          </Button>
        </div>
      </div>

      {/* View toggle + selection toggle */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {(
            [
              { id: "list", label: t("viewList") },
              { id: "byPayer", label: t("viewByPayer") },
            ] as const
          ).map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => {
                setView(v.id);
                if (v.id !== "list") {
                  setSelectionMode(false);
                  setSelected(new Set());
                }
              }}
              className={cn(
                // ring-inset (not offset): the offset ring was clipped by the rounded group so the
                // toggle showed no keyboard focus at all (a11y WCAG 2.4.7).
                "rounded-md border px-3 py-1.5 text-[0.7rem] font-display font-bold uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-stamp",
                view === v.id
                  ? "border-ink bg-ink text-paper"
                  : "border-rule bg-card text-ink-soft hover:bg-panel"
              )}
            >
              {v.label}
            </button>
          ))}
        </div>
        {view === "list" && total > 0 && (
          <Button
            variant={selectionMode ? "secondary" : "ghost"}
            size="sm"
            onClick={() => {
              if (selectionMode) {
                setSelectionMode(false);
                setSelected(new Set());
              } else {
                setSelectionMode(true);
              }
            }}
          >
            {selectionMode ? tc("cancel") : t("select")}
          </Button>
        )}
      </div>

      {/* Filter toolbar — opens the modal; applied filters show as removable chips. */}
      {!listState.initialLoading && total > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => setFilterModalOpen(true)}>
              <span className="inline-flex items-center gap-1.5">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M3 5h18l-7 8v6l-4-2v-6Z" />
                </svg>
                {t("filter")}{filtersActive ? ` · ${activeFilterCount}` : ""}
              </span>
            </Button>
            {filtersActive && (
              <button
                type="button"
                onClick={clearFilters}
                className="label-mono shrink-0 rounded-md px-2 py-1.5 text-stamp transition-colors hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
              >
                {t("clearFilters")}
              </button>
            )}
            {filterChips.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={c.remove}
                aria-label={`${c.label}: ${c.value} — ${t("clearFilters")}`}
                className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-rule bg-panel px-2 py-1 text-xs text-ink transition-colors hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
              >
                <span className="label-mono text-faint">{c.label}</span>
                <span className="min-w-0 truncate">{c.value}</span>
                <span aria-hidden className="text-faint">✕</span>
              </button>
            ))}
          </div>
          {filtersActive && (
            <div className="flex items-center justify-between gap-3 rounded-md border border-dotted border-rule bg-panel/40 px-3 py-1.5">
              <span className="label-mono">{t("filteredCount", { count: total })}</span>
              <span className="flex items-baseline gap-1.5">
                <span className="label-mono text-faint">{t("filteredTotal")}</span>
                <Money value={listState.totalAmount} className="font-display text-sm font-bold" />
              </span>
            </div>
          )}
        </div>
      )}

      {/* Bulk action bar — visible whenever selection mode is on (list only). */}
      {view === "list" && selectionMode && (
        <div className="sticky top-20 z-10 flex items-center justify-between gap-3 rounded-md border border-ink bg-panel px-4 py-2.5">
          <span className="label-mono">{t("selectedCount", { count: selectedCount })}</span>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={selectedCount === 0}
              onClick={() => setSelected(new Set())}
            >
              {t("clear")}
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={selectedCount === 0}
              onClick={() => setBulkConfirm(true)}
            >
              {t("deleteSelected")}
            </Button>
          </div>
        </div>
      )}

      {(view === "byPayer" ? byPersonData === null || byPersonLoading : listState.initialLoading) ? (
        view === "byPayer" ? (
          <div className="grid gap-5 lg:grid-cols-2">
            <Card className="p-2"><SkeletonRows rows={6} /></Card>
            <Card className="p-2"><SkeletonRows rows={6} /></Card>
          </div>
        ) : (
          <Card className="overflow-hidden"><SkeletonRows rows={8} inset /></Card>
        )
      ) : unfilteredTotal === 0 ? (
        <Card>
          <EmptyState
            title={t("emptyTitle")}
            hint={t("emptyHint")}
            icon="¤"
            action={<Button onClick={openCreate}>{t("newExpense")}</Button>}
          />
        </Card>
      ) : filtersActive && total === 0 ? (
        <Card>
          <EmptyState
            title={t("noResultsTitle")}
            hint={t("noResultsHint")}
            icon="¤"
            action={<Button variant="ghost" onClick={clearFilters}>{t("clearFilters")}</Button>}
          />
        </Card>
      ) : view === "byPayer" ? (
        /* ===== BY PERSON ===== */
        byPersonEmpty ? (
          <Card>
            <EmptyState title={t("emptyTitle")} hint={t("emptyHint")} icon="¤" />
          </Card>
        ) : (
          <>
          {/* Mobile: pick one person to view; desktop shows both columns side by side. */}
          <div className="mb-4 flex gap-2 overflow-x-auto pb-1 lg:hidden">
            {byPerson.map((person) => {
              const s = memberStyle(person.colorIndex);
              const active = person.payerId === selectedPersonId;
              return (
                <button
                  key={person.payerId}
                  type="button"
                  onClick={() => setPersonTab(person.payerId)}
                  aria-pressed={active}
                  className={cn(
                    "flex min-w-[8.5rem] flex-1 items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors",
                    active ? "" : "border-rule bg-card hover:bg-panel"
                  )}
                  style={active ? { background: `${s.bg}1f`, borderColor: s.bg } : undefined}
                >
                  <MemberDot colorIndex={person.colorIndex} name={person.name} size={24} />
                  <span className="min-w-0">
                    <span className={cn("block truncate text-sm font-bold", active ? "text-ink" : "text-ink-soft")}>
                      {person.name}
                    </span>
                    <Money value={person.total} className="block text-xs tnum text-ink-soft" />
                  </span>
                </button>
              );
            })}
          </div>
          {/* grid-cols-1 (= minmax(0,1fr)) stops grid items from expanding to their
              min-content width on mobile — without it, a long no-wrap description blows the row out. */}
          <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-2">
            {byPerson.map((person, pi) => {
              const s = memberStyle(person.colorIndex);
              return (
                <div
                  key={person.payerId}
                  className={cn("reveal min-w-0", person.payerId !== selectedPersonId && "hidden lg:block")}
                  style={revealDelay(pi)}
                >
                  <Card className="overflow-hidden">
                    <div
                      className="flex items-center justify-between gap-3 border-b border-rule px-4 py-3"
                      style={{ background: `${s.bg}1a`, borderColor: `${s.bg}55` }}
                    >
                      <span className="flex min-w-0 items-center gap-2.5">
                        <MemberDot colorIndex={person.colorIndex} name={person.name} size={26} />
                        <span className="truncate font-display text-base font-bold text-ink">
                          {person.name}
                        </span>
                      </span>
                      <Money value={person.total} className="font-display text-base font-bold" />
                    </div>

                    {person.months.length === 0 ? (
                      <p className="px-4 py-8 text-center text-sm text-faint">{t("emptyTitle")}</p>
                    ) : (
                      person.months.map((mg) => (
                        <div key={mg.key}>
                          <div className="flex items-center justify-between gap-3 border-t border-dashed border-rule bg-panel/40 px-4 py-2">
                            <span className="label-mono">▦ {mg.label}</span>
                            <Money value={mg.subtotal} className="text-ink-soft" />
                          </div>
                          <table className="hidden w-full table-fixed md:table">
                            <thead>
                              <tr className="border-t border-dotted border-rule">
                                <th className="w-6 px-2 py-1.5" aria-hidden />
                                <th className="label-mono px-4 py-1.5 text-left">{t("colDescription")}</th>
                                <th className="label-mono w-[86px] px-2 py-1.5 text-left">{t("colDate")}</th>
                                <th className="label-mono w-[116px] px-2 py-1.5 text-right max-md:w-36">{t("colAmount")}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {mg.items.map((e, i) => {
                                const ratio = splitRatio(e, members);
                                return (
                                <tr key={e.publicId} onClick={() => openView(e)} className="group cursor-pointer border-t border-dotted border-rule align-top transition-colors hover:bg-panel/30">
                                  <td className="px-2 py-2 text-xs leading-5 text-faint tnum" aria-hidden>{i + 1}</td>
                                  <td className="px-4 py-2 text-sm text-ink">
                                    <span className="break-words">{e.description}</span>
                                    <ExpenseTags expense={e} className="mt-1" />
                                  </td>
                                  <td className="whitespace-nowrap px-2 py-2 text-xs text-ink-soft">
                                    {formatDateLocale(e.date)}
                                  </td>
                                  <td className="relative whitespace-nowrap px-2 py-2 text-right max-md:pr-12 pointer-coarse:pr-12">
                                    <Money value={e.amount} />
                                    {ratio && <span className="block text-[0.7rem] text-faint tnum" title={t("customSplit")}>⊟ {ratio}</span>}
                                    {/* Desktop: ⋯ floats in on hover; touch/narrow: stays in the reserved right padding. */}
                                    <span onClick={(ev) => ev.stopPropagation()} className="absolute inset-y-0 right-0.5 flex items-center bg-gradient-to-l from-card via-card to-transparent pl-6 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 max-md:opacity-100 pointer-coarse:opacity-100">
                                      <RowMenu onEdit={() => openEdit(e)} onDelete={() => setDeleteTarget(e)} />
                                    </span>
                                  </td>
                                </tr>
                                );
                              })}
                            </tbody>
                          </table>
                          {/* Mobile: same card model as the list view (no cramped columns). */}
                          <ul className="md:hidden">
                            {mg.items.map((e) => (
                              <ExpenseCard
                                key={e.publicId}
                                expense={e}
                                colorIndex={person.colorIndex}
                                members={members}
                                selectionMode={false}
                                onView={openView}
                                onEdit={openEdit}
                                onDelete={setDeleteTarget}
                                hidePayer
                              />
                            ))}
                          </ul>
                        </div>
                      ))
                    )}
                  </Card>
                </div>
              );
            })}
          </div>
          </>
        )
      ) : (
        /* ===== LIST VIEW (all rows, scroll) ===== */
        <SelectionContext.Provider value={selectionValue}>
        <Card className="overflow-hidden">
          {/* Desktop ledger table */}
          <table className="hidden w-full md:table">
            <thead className="bg-card">
              <tr className="border-b border-dashed border-rule text-left">
                <th className="w-8 px-2 py-2.5" aria-hidden />
                {selectionMode && (
                  <th className="w-10 px-4 py-2.5">
                    <input
                      type="checkbox"
                      aria-label={t("selectAll")}
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      className="h-4 w-4 accent-ink"
                    />
                  </th>
                )}
                {COLUMNS.map((col) => (
                  <th key={col.field} className={cn("px-4 py-2.5", col.className)}>
                    <button
                      type="button"
                      onClick={() => toggleSort(col.field)}
                      className={cn(
                        "label-mono inline-flex items-center gap-1.5 hover:text-ink",
                        col.className === "text-right" && "flex-row-reverse"
                      )}
                    >
                      {t(col.labelKey)}
                      <SortIndicator active={sortField === col.field} direction={sortDirection} />
                    </button>
                  </th>
                ))}
                <th className="px-4 py-2.5">
                  <button
                    type="button"
                    onClick={() => toggleSort("date")}
                    className="label-mono inline-flex items-center gap-1.5 hover:text-ink"
                  >
                    {t("colDate")}
                    <SortIndicator active={sortField === "date"} direction={sortDirection} />
                  </button>
                </th>
                <th className="w-10 px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>{desktopRows}</tbody>
          </table>

          {/* Mobile stacked cards */}
          <div className="flex flex-col md:hidden">
            {selectionMode && (
              <label className="flex items-center gap-2 border-b border-dashed border-rule px-4 py-2.5 text-xs text-ink-soft">
                <input
                  type="checkbox"
                  aria-label={t("selectAll")}
                  checked={allSelected}
                  onChange={toggleSelectAll}
                  className="h-4 w-4 accent-ink"
                />
                <span className="label-mono">{t("selectAll")}</span>
              </label>
            )}
            <ul>
              {mobileCards}
            </ul>
          </div>
        </Card>
        {/* Infinite-scroll sentinel (BL-20/P3) — loads the next page once it's in view. */}
        {listState.hasMore && (
          <div ref={sentinelRef} className="flex items-center justify-center py-4">
            {listState.loadingMore && <span className="label-mono text-faint">{t("loadingMore")}</span>}
          </div>
        )}
        </SelectionContext.Provider>
      )}

      {/* Create / edit modal */}
      <ExpenseFormModal
        open={formOpen}
        onOpenChange={setFormOpen}
        expense={editing}
        platforms={platforms}
        categories={categories}
        paymentMethods={paymentMethods}
        onSaved={reloadAll}
      />

      {/* Read-only detail view (click a row) with Edit / Delete actions. */}
      <ExpenseDetailModal
        expense={viewing}
        onOpenChange={(o) => !o && setViewing(null)}
        onEdit={() => {
          const e = viewing;
          setViewing(null);
          if (e) openEdit(e);
        }}
        onDelete={() => {
          const e = viewing;
          setViewing(null);
          if (e) setDeleteTarget(e);
        }}
      />

      {/* Import modal */}
      <ImportCsvModal open={importOpen} onOpenChange={setImportOpen} platforms={platforms} onImported={reloadAll} />

      <ExpenseFiltersModal
        open={filterModalOpen}
        onClose={() => setFilterModalOpen(false)}
        initial={appliedFilters}
        members={members}
        platforms={platforms}
        categories={categories}
        paymentMethods={paymentMethods}
        onApply={applyFilters}
      />

      {/* Delete one confirm */}
      <Modal
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={t("deleteTitle")}
        description={t("deleteUndoNote")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              {tc("cancel")}
            </Button>
            <Button variant="danger" loading={deleting} onClick={confirmDeleteOne}>
              {tc("delete")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink">
          {t("deletePrompt")}{" "}
          <span className="font-display font-bold">{deleteTarget?.description}</span>?
        </p>
      </Modal>

      {/* Bulk delete confirm */}
      <Modal
        open={bulkConfirm}
        onOpenChange={setBulkConfirm}
        title={t("deleteSelected")}
        description={t("deleteUndoNote")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setBulkConfirm(false)}>
              {tc("cancel")}
            </Button>
            <Button variant="danger" loading={deleting} onClick={confirmBulkDelete}>
              {t("deleteCount", { count: selectedCount })}
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink">{t("bulkDeletePrompt", { count: selectedCount })}</p>
      </Modal>
    </div>
  );
}

// Selection lives in context so flipping it never re-renders the (memoized) rows — only the tiny
// leaf checkboxes below subscribe. The row's selected highlight is pure CSS (has-[:checked]).
// This is what makes "select all" over 300 rows instant.
const SelectionContext = createContext<{ selected: Set<string>; toggle: (publicId: string) => void }>({
  selected: new Set(),
  toggle: () => {},
});

function RowCheckbox({ publicId, label, className }: { publicId: string; label: string; className: string }) {
  const { selected, toggle } = useContext(SelectionContext);
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={selected.has(publicId)}
      onChange={() => toggle(publicId)}
      className={className}
    />
  );
}

/** Chips for an expense's three tag dimensions (categories + platforms + payment methods). */
function ExpenseTags({ expense: e, className }: { expense: Expense; className?: string }) {
  const t = useTranslations("Expenses");
  const lbl = (ns: string, v: string) => (t.has(`${ns}.${v}`) ? t(`${ns}.${v}`) : v);
  if (e.categories.length === 0 && e.platforms.length === 0 && e.paymentMethods.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {e.categories.map((c) => <Tag key={`c-${c}`} tone="category">{lbl("category", c)}</Tag>)}
      {e.platforms.map((p) => <Tag key={`p-${p}`} tone="platform">{lbl("platform", p)}</Tag>)}
      {e.paymentMethods.map((m) => (
        <Tag key={`m-${m}`} tone="payment">{lbl("payment", m)}</Tag>
      ))}
    </div>
  );
}

/** "60/40"-style ratio when the split isn't equal; null when it is (or no amount). */
function splitRatio(e: Expense, members: Member[]): string | null {
  if (detectSplitEqually(e, members)) return null;
  const total = toCents(e.amount);
  if (total <= 0 || e.participants.length === 0) return null;
  // Largest-remainder rounding so the displayed parts always sum to exactly 100
  // (rounding each independently could show 60/41 or 33/33/33).
  const raw = e.participants.map((p) => (toCents(p.amount) / total) * 100);
  const parts = raw.map((r) => Math.floor(r));
  let remainder = 100 - parts.reduce((a, b) => a + b, 0);
  const byFraction = raw
    .map((r, i) => ({ frac: r - Math.floor(r), i }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < byFraction.length && remainder > 0; k++, remainder--) {
    parts[byFraction[k].i]++;
  }
  return parts.join("/");
}

interface ExpenseRowProps {
  expense: Expense;
  rowNumber?: number; // display-only position in the current (sorted/filtered) list — not an id
  colorIndex: number;
  members: Member[];
  selectionMode: boolean;
  onView: (expense: Expense) => void;
  onEdit: (expense: Expense) => void;
  onDelete: (expense: Expense) => void;
  onToggle?: (publicId: string) => void; // toggle selection (card body tap in selection mode)
  hidePayer?: boolean; // by-person cards omit the payer (it's the card's person)
}

/** Desktop ledger row — memoized so toggling one checkbox re-renders only that row. */
const ExpenseRow = memo(function ExpenseRow({
  expense: e, rowNumber, colorIndex, members, selectionMode, onView, onEdit, onDelete,
}: ExpenseRowProps) {
  const t = useTranslations("Expenses");
  const thh = useTranslations("Household");
  const tacc = useTranslations("Account");
  const handleView = useCallback(() => onView(e), [onView, e]);
  const handleEdit = useCallback(() => onEdit(e), [onEdit, e]);
  const handleDelete = useCallback(() => onDelete(e), [onDelete, e]);
  const onRowKey = (ev: React.KeyboardEvent) => {
    if (selectionMode) return;
    if (ev.target !== ev.currentTarget) return; // ignore keys bubbling from the ⋯ menu / checkbox
    if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); handleView(); }
  };
  const ratio = splitRatio(e, members);
  // Same ex-member/deleted-account treatment as saldos/atividade/ExpenseDetailModal (BL-16/BL-23).
  const payer = members.find((m) => m.id === e.payerId);
  const payerName = payer?.deleted
    ? tacc("deletedUserLabel")
    : payer && !payer.active
    ? thh("exMemberLabel", { name: payer.name })
    : e.payer.name;
  return (
    <tr
      onClick={selectionMode ? undefined : handleView}
      onKeyDown={selectionMode ? undefined : onRowKey}
      tabIndex={selectionMode ? undefined : 0}
      role={selectionMode ? undefined : "button"}
      aria-label={selectionMode ? undefined : e.description}
      className={cn(
        "border-b border-dotted border-rule align-top transition-colors last:border-b-0 hover:bg-panel/30 has-[:checked]:bg-panel/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink",
        !selectionMode && "cursor-pointer"
      )}
    >
      <td className="px-2 py-3 text-xs leading-5 text-faint tnum" aria-hidden>{rowNumber}</td>
      {selectionMode && (
        <td className="px-4 py-3">
          <RowCheckbox
            publicId={e.publicId}
            label={t("selectRow", { description: e.description })}
            className="h-4 w-4 accent-ink"
          />
        </td>
      )}
      <td className="px-4 py-3 text-sm text-ink">
        {e.description}
        <ExpenseTags expense={e} className="mt-1" />
      </td>
      <td className="px-4 py-3">
        <span className="flex min-w-0 items-center gap-2">
          <MemberDot colorIndex={colorIndex} name={payerName} size={22} />
          <span className="truncate text-sm text-ink">{payerName}</span>
        </span>
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-right">
        <Money value={e.amount} />
        {ratio && <span className="mt-0.5 block text-xs text-faint tnum" title={t("customSplit")}>⊟ {ratio}</span>}
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-sm text-ink-soft">
        {formatDateLocale(e.date)}
      </td>
      <td className="px-4 py-3 text-right" onClick={(ev) => ev.stopPropagation()}>
        <RowMenu onEdit={handleEdit} onDelete={handleDelete} />
      </td>
    </tr>
  );
});

/** Mobile stacked card — memoized (same rationale as ExpenseRow). */
const ExpenseCard = memo(function ExpenseCard({
  expense: e, colorIndex, members, selectionMode, onView, onEdit, onDelete, onToggle, hidePayer,
}: ExpenseRowProps) {
  const t = useTranslations("Expenses");
  const thh = useTranslations("Household");
  const tacc = useTranslations("Account");
  const handleView = useCallback(() => onView(e), [onView, e]);
  const handleEdit = useCallback(() => onEdit(e), [onEdit, e]);
  const handleDelete = useCallback(() => onDelete(e), [onDelete, e]);
  const handleBody = () => (selectionMode ? onToggle?.(e.publicId) : handleView());
  const onCardKey = (ev: React.KeyboardEvent) => {
    if (ev.target !== ev.currentTarget) return; // ignore keys bubbling from the ⋯ menu / checkbox
    if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); handleBody(); }
  };
  const ratio = splitRatio(e, members);
  // Same ex-member/deleted-account treatment as saldos/atividade/ExpenseDetailModal (BL-16/BL-23).
  const payer = members.find((m) => m.id === e.payerId);
  const payerName = payer?.deleted
    ? tacc("deletedUserLabel")
    : payer && !payer.active
    ? thh("exMemberLabel", { name: payer.name })
    : e.payer.name;
  return (
    <li className="flex gap-3 border-b border-dotted border-rule px-4 py-3 last:border-b-0 has-[:checked]:bg-panel/60">
      {selectionMode && (
        <RowCheckbox
          publicId={e.publicId}
          label={t("selectRow", { description: e.description })}
          className="mt-1 h-4 w-4 shrink-0 accent-ink"
        />
      )}
      <div
        onClick={handleBody}
        onKeyDown={onCardKey}
        role="button"
        tabIndex={0}
        aria-label={e.description}
        className="min-w-0 flex-1 cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
      >
        <div className="flex items-start justify-between gap-2">
          <span className="truncate text-sm font-medium text-ink">{e.description}</span>
          <div className="shrink-0 text-right">
            <Money value={e.amount} />
            {ratio && <span className="block text-[0.7rem] text-faint tnum" title={t("customSplit")}>⊟ {ratio}</span>}
          </div>
        </div>
        <div className="mt-1.5 flex items-center gap-2 text-xs text-faint">
          {!hidePayer && (
            <>
              <span className="flex min-w-0 items-center gap-1.5">
                <MemberDot colorIndex={colorIndex} name={payerName} size={18} />
                <span className="truncate">{payerName}</span>
              </span>
              <span aria-hidden>·</span>
            </>
          )}
          <span className="shrink-0 tnum">{formatDateLocale(e.date)}</span>
        </div>
        <ExpenseTags expense={e} className="mt-1.5" />
      </div>
      <div className="shrink-0">
        <RowMenu onEdit={handleEdit} onDelete={handleDelete} />
      </div>
    </li>
  );
});

/** Per-row actions menu (⋯). Memoized with stable callbacks so toggling selection (which
 *  re-renders every row) never re-renders these 300 dropdowns — that was the "select all" freeze. */
const RowMenu = memo(function RowMenu({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  const t = useTranslations("Expenses");
  const tc = useTranslations("Common");
  return (
    <Menu
      align="end"
      trigger={
        <button
          aria-label={t("rowActions")}
          // min-h-11 min-w-11: 44px touch floor on mobile (D3 — was 31x26); sm:* restores compact desktop.
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md px-2 py-1 text-lg leading-none text-ink-soft transition-colors hover:bg-panel hover:text-ink sm:min-h-0 sm:min-w-0"
        >
          ⋯
        </button>
      }
    >
      <MenuItem onSelect={onEdit}>{tc("edit")}</MenuItem>
      <MenuSeparator />
      <MenuItem danger onSelect={onDelete}>
        {tc("delete")}
      </MenuItem>
    </Menu>
  );
});
