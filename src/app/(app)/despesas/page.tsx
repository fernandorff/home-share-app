"use client";

import { createContext, memo, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { SelectHTMLAttributes } from "react";
import { useFetch } from "@/lib/use-fetch";
import { useTranslations, useLocale } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Card, SectionTitle } from "@/components/ui/Card";
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
import { EXPENSE_CATEGORIES } from "@/lib/categories";
import type { Expense, ExpenseListResponse, ExpenseSortField, Platform, Category } from "@/lib/types";
import { ExpenseFormModal } from "@/components/expenses/ExpenseFormModal";
import { ImportCsvModal } from "@/components/expenses/ImportCsvModal";

type SortDirection = "asc" | "desc";
type ViewMode = "list" | "byPayer";

// Compact ledger field used across the filter bar (smaller than the form Field).
const fieldCls =
  "rounded-md border border-rule bg-card px-2.5 py-1.5 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-1 focus-visible:ring-offset-card";

// Filter select: appearance-none + custom chevron + truncate so a long selected label
// (e.g. "Todas as plataformas" in pt) ellipsizes instead of being cut behind the native arrow.
function FilterSelect({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative min-w-0">
      <select
        className={cn(fieldCls, "w-full cursor-pointer appearance-none truncate pr-8", className)}
        {...props}
      >
        {children}
      </select>
      <span
        aria-hidden
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-faint"
      >
        ▼
      </span>
    </div>
  );
}

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

function compareExpenses(
  a: Expense,
  b: Expense,
  field: ExpenseSortField,
  locale: string
): number {
  let cmp = 0;
  switch (field) {
    case "amount":
      cmp = money(a.amount) - money(b.amount);
      break;
    case "description":
      cmp = a.description.localeCompare(b.description, locale);
      break;
    case "payer":
      cmp = a.payer.name.localeCompare(b.payer.name, locale);
      break;
    case "platformId":
      cmp = (a.platform?.name ?? "").localeCompare(b.platform?.name ?? "", locale);
      break;
    case "createdAt":
      cmp = a.createdAt.localeCompare(b.createdAt);
      break;
    default:
      cmp = a.date.localeCompare(b.date);
  }
  return cmp !== 0 ? cmp : a.date.localeCompare(b.date);
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
  const { activeGroup, members } = useSession();
  const toast = useToast();
  const t = useTranslations("Expenses");
  const tc = useTranslations("Common");
  const apiErr = useApiError();
  const locale = useLocale();

  // Everything is loaded once and scrolled (no pagination). useFetch keys on the active
  // house and reloads after mutations; reqId/ref guards avoid the old refetch-loop footgun.
  const { data: allData, loading, reload } = useFetch<ExpenseListResponse>(
    "/api/expenses?page=1&pageSize=100000&sortField=date&sortDirection=desc",
    { onError: (err) => toast(apiErr(err, t("loadError")), "error") }
  );
  const [sortField, setSortField] = useState<ExpenseSortField>("date");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [view, setView] = useState<ViewMode>("list");
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);

  // Filters (client-side; fit the load-all model).
  const [query, setQuery] = useState("");
  const [payerFilter, setPayerFilter] = useState<number | "">("");
  const [platformFilter, setPlatformFilter] = useState<number | "">("");
  const [categoryFilter, setCategoryFilter] = useState<string>("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Checkboxes are hidden until the user enters selection mode (the "Selecionar" button).
  const [selectionMode, setSelectionMode] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [importOpen, setImportOpen] = useState(false);

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
    return () => {
      active = false;
    };
  }, [activeGroup?.id]);

  const all = useMemo(() => allData?.expenses ?? [], [allData]);

  // Filters applied BEFORE sort & grouping, so List and By-person see the same set.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((e) => {
      if (payerFilter !== "" && e.payerId !== payerFilter) return false;
      if (platformFilter !== "" && (e.platform?.id ?? -1) !== platformFilter) return false;
      if (categoryFilter !== "" && (e.category ?? "") !== categoryFilter) return false;
      const day = e.date.slice(0, 10);
      if (fromDate && day < fromDate) return false;
      if (toDate && day > toDate) return false;
      if (q) {
        const hay = `${e.description} ${e.notes ?? ""} ${e.payer.name} ${e.platform?.name ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [all, query, payerFilter, platformFilter, categoryFilter, fromDate, toDate]);

  const activeFilterCount = [
    query.trim() !== "", payerFilter !== "", platformFilter !== "", categoryFilter !== "", fromDate !== "", toDate !== "",
  ].filter(Boolean).length;
  const filtersActive = activeFilterCount > 0;
  const filteredTotal = useMemo(() => filtered.reduce((s, e) => s + money(e.amount), 0), [filtered]);

  function clearFilters() {
    setQuery("");
    setPayerFilter("");
    setPlatformFilter("");
    setCategoryFilter("");
    setFromDate("");
    setToDate("");
  }

  // List view: client-side sorted (all rows, infinite scroll).
  const listItems = useMemo(() => {
    const dir = sortDirection === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => compareExpenses(a, b, sortField, locale) * dir);
  }, [filtered, sortField, sortDirection, locale]);

  // By person → grouped by month (newest first).
  const byPerson = useMemo<PersonGroup[]>(() => {
    return members.map((m) => {
      const monthsMap = new Map<string, MonthGroup>();
      let total = 0;
      for (const e of filtered) {
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
  }, [filtered, members, locale]);

  const byPersonEmpty = byPerson.every((p) => p.months.length === 0);
  const selectedCount = selected.size;
  const allSelected = listItems.length > 0 && listItems.every((e) => selected.has(e.publicId));

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
    setSelected(allSelected ? new Set() : new Set(listItems.map((e) => e.publicId)));
  }

  function openCreate() {
    setEditing(null);
    setFormOpen(true);
  }
  const openEdit = useCallback((expense: Expense) => {
    setEditing(expense);
    setFormOpen(true);
  }, []);

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
    () => listItems.map((e) => (
      <ExpenseRow key={e.publicId} expense={e} colorIndex={colorByPayer.get(e.payerId) ?? 0}
        locale={locale} selectionMode={selectionMode} onEdit={openEdit} onDelete={setDeleteTarget} />
    )),
    [listItems, colorByPayer, locale, selectionMode, openEdit]
  );
  const mobileCards = useMemo(
    () => listItems.map((e) => (
      <ExpenseCard key={e.publicId} expense={e} colorIndex={colorByPayer.get(e.payerId) ?? 0}
        locale={locale} selectionMode={selectionMode} onEdit={openEdit} onDelete={setDeleteTarget} />
    )),
    [listItems, colorByPayer, locale, selectionMode, openEdit]
  );

  async function confirmDeleteOne() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.del(`/api/expenses/${deleteTarget.publicId}`);
      toast(t("toastDeleted"), "success");
      setDeleteTarget(null);
      reload();
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
      reload();
    } catch (err) {
      toast(apiErr(err, t("bulkDeleteError")), "error");
    } finally {
      setDeleting(false);
    }
  }

  const total = allData?.pagination.total ?? listItems.length;

  return (
    <div className="flex flex-col gap-5">
      {/* Header */}
      <SectionTitle
        right={
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
                <a href="/api/expenses/export" className="flex w-full items-center">
                  {t("exportCsv")}
                </a>
              </MenuItem>
            </Menu>
            <Button size="sm" onClick={openCreate}>
              {t("newExpense")}
            </Button>
          </div>
        }
      >
        {t("title")}{" "}
        {!loading && <span className="font-normal text-faint">({total})</span>}
      </SectionTitle>

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
                "rounded-md border px-3 py-1.5 text-[0.7rem] font-display font-bold uppercase tracking-wider transition-colors",
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

      {/* Filter bar */}
      {!loading && total > 0 && (
        <Card className="px-3 py-2.5">
          <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("searchPlaceholder")}
              aria-label={t("searchPlaceholder")}
              className={cn(fieldCls, "min-w-0 flex-1 placeholder:text-faint lg:min-w-[200px]")}
            />
            <div className="grid grid-cols-2 gap-2 lg:flex lg:flex-wrap lg:items-center">
              <FilterSelect
                value={payerFilter}
                onChange={(e) => setPayerFilter(e.target.value ? Number(e.target.value) : "")}
                aria-label={t("colPayer")}
              >
                <option value="">{t("filterAllPeople")}</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </FilterSelect>
              <FilterSelect
                value={platformFilter}
                onChange={(e) => setPlatformFilter(e.target.value ? Number(e.target.value) : "")}
                aria-label={t("colPlatform")}
              >
                <option value="">{t("filterAllPlatforms")}</option>
                {platforms.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </FilterSelect>
              <FilterSelect
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                aria-label={t("categoryLabel")}
              >
                <option value="">{t("filterAllCategories")}</option>
                {EXPENSE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>{t(`category.${c}`)}</option>
                ))}
                {categories.map((c) => (
                  <option key={c.publicId} value={c.name}>{c.name}</option>
                ))}
              </FilterSelect>
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                aria-label={t("filterFrom")}
                className={cn(fieldCls, "tnum")}
              />
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                aria-label={t("filterTo")}
                className={cn(fieldCls, "tnum")}
              />
            </div>
            {filtersActive && (
              <button
                type="button"
                onClick={clearFilters}
                className="label-mono shrink-0 rounded-md px-2 py-1.5 text-stamp transition-colors hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
              >
                {t("clearFilters")} ({activeFilterCount})
              </button>
            )}
          </div>
          {filtersActive && (
            <div className="mt-2 flex items-center justify-between gap-3 border-t border-dotted border-rule pt-2">
              <span className="label-mono">{t("filteredCount", { count: filtered.length })}</span>
              <span className="flex items-baseline gap-1.5">
                <span className="label-mono text-faint">{t("filteredTotal")}</span>
                <Money value={filteredTotal} className="font-display text-sm font-bold" />
              </span>
            </div>
          )}
        </Card>
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

      {loading || allData === null ? (
        view === "byPayer" ? (
          <div className="grid gap-5 lg:grid-cols-2">
            <Card className="p-2"><SkeletonRows rows={6} /></Card>
            <Card className="p-2"><SkeletonRows rows={6} /></Card>
          </div>
        ) : (
          <Card className="overflow-hidden"><SkeletonRows rows={8} inset /></Card>
        )
      ) : total === 0 ? (
        <Card>
          <EmptyState
            title={t("emptyTitle")}
            hint={t("emptyHint")}
            icon="¤"
            action={<Button onClick={openCreate}>{t("newExpense")}</Button>}
          />
        </Card>
      ) : filtersActive && filtered.length === 0 ? (
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
          <div className="grid items-start gap-5 lg:grid-cols-2">
            {byPerson.map((person, pi) => {
              const s = memberStyle(person.colorIndex);
              return (
                <div key={person.payerId} className="reveal" style={revealDelay(pi)}>
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
                          <table className="w-full table-fixed">
                            <thead>
                              <tr className="border-t border-dotted border-rule">
                                <th className="label-mono px-4 py-1.5 text-left">{t("colDescription")}</th>
                                <th className="label-mono hidden w-28 px-2 py-1.5 text-left sm:table-cell">{t("colPlatform")}</th>
                                <th className="label-mono w-[86px] px-2 py-1.5 text-left">{t("colDate")}</th>
                                <th className="label-mono w-[116px] px-2 py-1.5 text-right max-md:w-36">{t("colAmount")}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {mg.items.map((e) => (
                                <tr key={e.publicId} className="group border-t border-dotted border-rule align-top transition-colors hover:bg-panel/30">
                                  <td className="px-4 py-2 text-sm text-ink">
                                    <span className="break-words">{e.description}</span>
                                    {e.category && (
                                      <span className="mt-0.5 block text-xs text-faint">▘ {t.has(`category.${e.category}`) ? t(`category.${e.category}`) : e.category}</span>
                                    )}
                                  </td>
                                  <td className="hidden px-2 py-2 sm:table-cell">
                                    {e.platform ? (
                                      <span className="block break-words text-xs text-faint">{e.platform.name}</span>
                                    ) : (
                                      <span className="text-faint">—</span>
                                    )}
                                  </td>
                                  <td className="whitespace-nowrap px-2 py-2 text-xs text-ink-soft">
                                    {formatDateLocale(e.date, locale)}
                                  </td>
                                  <td className="relative whitespace-nowrap px-2 py-2 text-right max-md:pr-12 pointer-coarse:pr-12">
                                    <Money value={e.amount} />
                                    {/* Desktop: ⋯ floats in on hover (gradient masks the value), no reserved column.
                                        Touch / narrow: no hover exists, so the trigger stays visible in the reserved right padding. */}
                                    <span className="absolute inset-y-0 right-0.5 flex items-center bg-gradient-to-l from-card via-card to-transparent pl-6 opacity-0 transition-opacity group-hover:opacity-100 max-md:opacity-100 pointer-coarse:opacity-100">
                                      <RowMenu onEdit={() => openEdit(e)} onDelete={() => setDeleteTarget(e)} />
                                    </span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ))
                    )}
                  </Card>
                </div>
              );
            })}
          </div>
        )
      ) : (
        /* ===== LIST VIEW (all rows, scroll) ===== */
        <SelectionContext.Provider value={selectionValue}>
        <Card className="overflow-hidden">
          {/* Desktop ledger table */}
          <table className="hidden w-full md:table">
            <thead className="bg-card">
              <tr className="border-b border-dashed border-rule text-left">
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
                  <span className="label-mono">{t("colPlatform")}</span>
                </th>
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
        </SelectionContext.Provider>
      )}

      {/* Create / edit modal */}
      <ExpenseFormModal
        open={formOpen}
        onOpenChange={setFormOpen}
        expense={editing}
        platforms={platforms}
        categories={categories}
        onSaved={reload}
      />

      {/* Import modal */}
      <ImportCsvModal open={importOpen} onOpenChange={setImportOpen} platforms={platforms} onImported={reload} />

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

interface ExpenseRowProps {
  expense: Expense;
  colorIndex: number;
  locale: string;
  selectionMode: boolean;
  onEdit: (expense: Expense) => void;
  onDelete: (expense: Expense) => void;
}

/** Desktop ledger row — memoized so toggling one checkbox re-renders only that row. */
const ExpenseRow = memo(function ExpenseRow({
  expense: e, colorIndex, locale, selectionMode, onEdit, onDelete,
}: ExpenseRowProps) {
  const t = useTranslations("Expenses");
  const handleEdit = useCallback(() => onEdit(e), [onEdit, e]);
  const handleDelete = useCallback(() => onDelete(e), [onDelete, e]);
  return (
    <tr className="border-b border-dotted border-rule transition-colors last:border-b-0 hover:bg-panel/30 has-[:checked]:bg-panel/60">
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
        {e.category && (
          <span className="mt-0.5 block text-xs text-faint">▘ {t.has(`category.${e.category}`) ? t(`category.${e.category}`) : e.category}</span>
        )}
      </td>
      <td className="px-4 py-3">
        <span className="flex min-w-0 items-center gap-2">
          <MemberDot colorIndex={colorIndex} name={e.payer.name} size={22} />
          <span className="truncate text-sm text-ink">{e.payer.name}</span>
        </span>
      </td>
      <td className="px-4 py-3 text-right">
        <Money value={e.amount} />
      </td>
      <td className="px-4 py-3">
        {e.platform ? <Tag>{e.platform.name}</Tag> : <span className="text-faint">—</span>}
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-sm text-ink-soft">
        {formatDateLocale(e.date, locale)}
      </td>
      <td className="px-4 py-3 text-right">
        <RowMenu onEdit={handleEdit} onDelete={handleDelete} />
      </td>
    </tr>
  );
});

/** Mobile stacked card — memoized (same rationale as ExpenseRow). */
const ExpenseCard = memo(function ExpenseCard({
  expense: e, colorIndex, locale, selectionMode, onEdit, onDelete,
}: ExpenseRowProps) {
  const t = useTranslations("Expenses");
  const handleEdit = useCallback(() => onEdit(e), [onEdit, e]);
  const handleDelete = useCallback(() => onDelete(e), [onDelete, e]);
  return (
    <li className="flex gap-3 border-b border-dotted border-rule px-4 py-3 last:border-b-0 has-[:checked]:bg-panel/60">
      {selectionMode && (
        <RowCheckbox
          publicId={e.publicId}
          label={t("selectRow", { description: e.description })}
          className="mt-1 h-4 w-4 shrink-0 accent-ink"
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <span className="truncate text-sm font-medium text-ink">{e.description}</span>
          <Money value={e.amount} className="shrink-0" />
        </div>
        <div className="mt-1.5 flex items-center gap-2 text-xs text-faint">
          <span className="flex min-w-0 items-center gap-1.5">
            <MemberDot colorIndex={colorIndex} name={e.payer.name} size={18} />
            <span className="truncate">{e.payer.name}</span>
          </span>
          <span aria-hidden>·</span>
          <span className="shrink-0 tnum">{formatDateLocale(e.date, locale)}</span>
        </div>
        {(e.platform || e.category) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-faint">
            {e.platform && <Tag>{e.platform.name}</Tag>}
            {e.category && (
              <span className="text-faint">▘ {t.has(`category.${e.category}`) ? t(`category.${e.category}`) : e.category}</span>
            )}
          </div>
        )}
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
          className="rounded-md px-2 py-1 text-lg leading-none text-ink-soft transition-colors hover:bg-panel hover:text-ink"
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
