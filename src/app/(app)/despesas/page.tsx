"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card, ReceiptDivider, SectionTitle } from "@/components/ui/Card";
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
import { api, ApiError } from "@/lib/api";
import { formatDateBR, money } from "@/lib/format";
import type {
  Expense,
  ExpenseListResponse,
  ExpenseSortField,
  Platform,
} from "@/lib/types";
import { ExpenseFormModal } from "@/components/expenses/ExpenseFormModal";
import { ImportCsvModal } from "@/components/expenses/ImportCsvModal";

type SortDirection = "asc" | "desc";
type ViewMode = "list" | "byPayer";

const PAGE_SIZE = 10;

interface SortableCol {
  field: ExpenseSortField;
  label: string;
  className?: string;
}

const COLUMNS: SortableCol[] = [
  { field: "description", label: "Descrição" },
  { field: "payer", label: "Pagador" },
  { field: "amount", label: "Valor", className: "text-right" },
];

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

  const [data, setData] = useState<ExpenseListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [sortField, setSortField] = useState<ExpenseSortField>("date");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [view, setView] = useState<ViewMode>("list");
  const [platforms, setPlatforms] = useState<Platform[]>([]);

  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<Expense | null>(null);
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const fetchExpenses = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
        sortField,
        sortDirection,
      });
      const res = await api.get<ExpenseListResponse>(`/api/expenses?${qs}`);
      setData(res);
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : "Erro ao carregar despesas";
      toast(message, "error");
    } finally {
      setLoading(false);
    }
  }, [page, sortField, sortDirection, toast]);

  useEffect(() => {
    fetchExpenses();
  }, [fetchExpenses]);

  // Platforms (for the form + import selects). Refetch when the house changes.
  useEffect(() => {
    let active = true;
    api
      .get<{ platforms: Platform[] }>("/api/platforms")
      .then((res) => {
        if (active) setPlatforms(res.platforms);
      })
      .catch(() => {
        if (active) setPlatforms([]);
      });
    return () => {
      active = false;
    };
  }, [activeGroup?.id]);

  const expenses = data?.expenses ?? [];
  const pagination = data?.pagination;

  // Selection is scoped to the current page.
  useEffect(() => {
    setSelected(new Set());
  }, [page, sortField, sortDirection]);

  function toggleSort(field: ExpenseSortField) {
    if (field === sortField) {
      setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDirection("desc");
    }
    setPage(1);
  }

  function toggleRow(publicId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(publicId)) next.delete(publicId);
      else next.add(publicId);
      return next;
    });
  }

  const allOnPageSelected =
    expenses.length > 0 && expenses.every((e) => selected.has(e.publicId));

  function toggleSelectAll() {
    setSelected((prev) => {
      if (allOnPageSelected) return new Set();
      const next = new Set(prev);
      expenses.forEach((e) => next.add(e.publicId));
      return next;
    });
  }

  function openCreate() {
    setEditing(null);
    setFormOpen(true);
  }

  function openEdit(expense: Expense) {
    setEditing(expense);
    setFormOpen(true);
  }

  function memberColorFor(payerId: number): number {
    return members.find((m) => m.id === payerId)?.colorIndex ?? 0;
  }

  async function confirmDeleteOne() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.del(`/api/expenses/${deleteTarget.publicId}`);
      toast("Despesa excluída", "success");
      setDeleteTarget(null);
      // If we just removed the last row on a page > 1, step back a page.
      if (expenses.length === 1 && page > 1) setPage((p) => p - 1);
      else fetchExpenses();
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : "Erro ao excluir despesa";
      toast(message, "error");
    } finally {
      setDeleting(false);
    }
  }

  async function confirmBulkDelete() {
    const publicIds = Array.from(selected);
    if (publicIds.length === 0) return;
    setDeleting(true);
    try {
      const res = await api.post<{ deleted: number }>(
        "/api/expenses/bulk-delete",
        { publicIds }
      );
      toast(
        `${res.deleted} despesa${res.deleted === 1 ? "" : "s"} excluída${
          res.deleted === 1 ? "" : "s"
        }`,
        "success"
      );
      setBulkConfirm(false);
      setSelected(new Set());
      if (expenses.length === publicIds.length && page > 1) setPage((p) => p - 1);
      else fetchExpenses();
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : "Erro ao excluir despesas";
      toast(message, "error");
    } finally {
      setDeleting(false);
    }
  }

  // Grouped view: group current page's expenses by payer with a subtotal.
  const byPayer = useMemo(() => {
    const groups = new Map<
      number,
      { payerId: number; name: string; colorIndex: number; items: Expense[]; subtotal: number }
    >();
    for (const e of expenses) {
      const g = groups.get(e.payerId);
      if (g) {
        g.items.push(e);
        g.subtotal += money(e.amount);
      } else {
        const colorIndex =
          members.find((m) => m.id === e.payerId)?.colorIndex ?? 0;
        groups.set(e.payerId, {
          payerId: e.payerId,
          name: e.payer.name,
          colorIndex,
          items: [e],
          subtotal: money(e.amount),
        });
      }
    }
    return Array.from(groups.values());
  }, [expenses, members]);

  const selectedCount = selected.size;

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
              <MenuItem onSelect={() => setImportOpen(true)}>Importar CSV</MenuItem>
              <MenuSeparator />
              <MenuItem>
                <a
                  href="/api/expenses/export"
                  className="flex w-full items-center"
                >
                  Exportar CSV
                </a>
              </MenuItem>
            </Menu>
            <Button size="sm" onClick={openCreate}>
              Nova despesa
            </Button>
          </div>
        }
      >
        Despesas
      </SectionTitle>

      {/* View toggle */}
      <div className="flex items-center gap-1">
        {(
          [
            { id: "list", label: "Lista" },
            { id: "byPayer", label: "Por pessoa" },
          ] as const
        ).map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => setView(v.id)}
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

      {/* Bulk bar */}
      {selectedCount > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-ink bg-panel px-4 py-2.5">
          <span className="label-mono">
            {selectedCount} selecionada{selectedCount === 1 ? "" : "s"}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelected(new Set())}
            >
              Limpar
            </Button>
            <Button variant="danger" size="sm" onClick={() => setBulkConfirm(true)}>
              Excluir selecionadas
            </Button>
          </div>
        </div>
      )}

      <Card className="overflow-hidden">
        {loading ? (
          <SkeletonRows rows={6} />
        ) : expenses.length === 0 ? (
          <EmptyState
            title="Nenhuma despesa ainda"
            hint="Adicione a primeira."
            icon="₪"
            action={<Button onClick={openCreate}>Nova despesa</Button>}
          />
        ) : view === "byPayer" ? (
          /* ===== GROUPED BY PAYER ===== */
          <div className="flex flex-col">
            {byPayer.map((group, gi) => (
              <div key={group.payerId}>
                {gi > 0 && <ReceiptDivider />}
                <div className="flex items-center justify-between gap-3 bg-panel/40 px-4 py-2.5">
                  <span className="flex items-center gap-2 min-w-0">
                    <MemberDot
                      colorIndex={group.colorIndex}
                      name={group.name}
                      size={22}
                    />
                    <span className="truncate font-display text-sm font-bold uppercase tracking-wide text-ink">
                      {group.name}
                    </span>
                    <span className="text-xs text-faint">
                      ({group.items.length})
                    </span>
                  </span>
                  <Money value={group.subtotal} />
                </div>
                <ul>
                  {group.items.map((e) => (
                    <li
                      key={e.publicId}
                      className="flex items-center justify-between gap-3 border-t border-dotted border-rule px-4 py-2.5"
                    >
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-sm text-ink">
                          {e.description}
                        </span>
                        <span className="flex items-center gap-2 text-xs text-faint">
                          {formatDateBR(e.date)}
                          {e.platform && <Tag>{e.platform.name}</Tag>}
                        </span>
                      </span>
                      <div className="flex items-center gap-2">
                        <Money value={e.amount} />
                        <RowMenu
                          onEdit={() => openEdit(e)}
                          onDelete={() => setDeleteTarget(e)}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : (
          /* ===== LIST VIEW ===== */
          <>
            {/* Desktop ledger table */}
            <table className="hidden w-full md:table">
              <thead>
                <tr className="border-b border-dashed border-rule text-left">
                  <th className="w-10 px-4 py-2.5">
                    <input
                      type="checkbox"
                      aria-label="Selecionar todas"
                      checked={allOnPageSelected}
                      onChange={toggleSelectAll}
                      className="h-4 w-4 accent-ink"
                    />
                  </th>
                  {COLUMNS.map((col) => (
                    <th
                      key={col.field}
                      className={cn("px-4 py-2.5", col.className)}
                    >
                      <button
                        type="button"
                        onClick={() => toggleSort(col.field)}
                        className={cn(
                          "label-mono inline-flex items-center gap-1.5 hover:text-ink",
                          col.className === "text-right" && "flex-row-reverse"
                        )}
                      >
                        {col.label}
                        <SortIndicator
                          active={sortField === col.field}
                          direction={sortDirection}
                        />
                      </button>
                    </th>
                  ))}
                  <th className="px-4 py-2.5">
                    <span className="label-mono">Plataforma</span>
                  </th>
                  <th className="px-4 py-2.5">
                    <button
                      type="button"
                      onClick={() => toggleSort("date")}
                      className="label-mono inline-flex items-center gap-1.5 hover:text-ink"
                    >
                      Data
                      <SortIndicator
                        active={sortField === "date"}
                        direction={sortDirection}
                      />
                    </button>
                  </th>
                  <th className="w-10 px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {expenses.map((e, i) => (
                  <tr
                    key={e.publicId}
                    className={cn(
                      "reveal border-b border-dotted border-rule last:border-b-0 transition-colors",
                      selected.has(e.publicId) ? "bg-panel/60" : "hover:bg-panel/30"
                    )}
                    style={revealDelay(i)}
                  >
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        aria-label={`Selecionar ${e.description}`}
                        checked={selected.has(e.publicId)}
                        onChange={() => toggleRow(e.publicId)}
                        className="h-4 w-4 accent-ink"
                      />
                    </td>
                    <td className="px-4 py-3 text-sm text-ink">
                      {e.description}
                    </td>
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-2 min-w-0">
                        <MemberDot
                          colorIndex={memberColorFor(e.payerId)}
                          name={e.payer.name}
                          size={22}
                        />
                        <span className="truncate text-sm text-ink">
                          {e.payer.name}
                        </span>
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Money value={e.amount} />
                    </td>
                    <td className="px-4 py-3">
                      {e.platform ? <Tag>{e.platform.name}</Tag> : <span className="text-faint">—</span>}
                    </td>
                    <td className="px-4 py-3 text-sm text-ink-soft whitespace-nowrap">
                      {formatDateBR(e.date)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <RowMenu
                        onEdit={() => openEdit(e)}
                        onDelete={() => setDeleteTarget(e)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Mobile stacked cards */}
            <div className="flex flex-col md:hidden">
              {/* select-all on mobile */}
              <label className="flex items-center gap-2 border-b border-dashed border-rule px-4 py-2.5 text-xs text-ink-soft">
                <input
                  type="checkbox"
                  aria-label="Selecionar todas"
                  checked={allOnPageSelected}
                  onChange={toggleSelectAll}
                  className="h-4 w-4 accent-ink"
                />
                <span className="label-mono">Selecionar todas</span>
              </label>
              <ul>
                {expenses.map((e, i) => (
                  <li
                    key={e.publicId}
                    className={cn(
                      "reveal flex gap-3 border-b border-dotted border-rule px-4 py-3 last:border-b-0",
                      selected.has(e.publicId) && "bg-panel/60"
                    )}
                    style={revealDelay(i)}
                  >
                    <input
                      type="checkbox"
                      aria-label={`Selecionar ${e.description}`}
                      checked={selected.has(e.publicId)}
                      onChange={() => toggleRow(e.publicId)}
                      className="mt-1 h-4 w-4 shrink-0 accent-ink"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <span className="truncate text-sm font-medium text-ink">
                          {e.description}
                        </span>
                        <Money value={e.amount} className="shrink-0" />
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-faint">
                        <span className="flex items-center gap-1.5">
                          <MemberDot
                            colorIndex={memberColorFor(e.payerId)}
                            name={e.payer.name}
                            size={18}
                          />
                          {e.payer.name}
                        </span>
                        <span aria-hidden>·</span>
                        <span>{formatDateBR(e.date)}</span>
                        {e.platform && <Tag>{e.platform.name}</Tag>}
                      </div>
                    </div>
                    <div className="shrink-0">
                      <RowMenu
                        onEdit={() => openEdit(e)}
                        onDelete={() => setDeleteTarget(e)}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}

        {/* Pagination footer */}
        {!loading && pagination && pagination.total > 0 && (
          <div className="flex items-center justify-between gap-3 border-t border-dashed border-rule px-4 py-3">
            <span className="label-mono">
              página {pagination.page} de {pagination.totalPages || 1}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                ← Anterior
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= (pagination.totalPages || 1)}
                onClick={() => setPage((p) => p + 1)}
              >
                Próxima →
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* Create / edit modal */}
      <ExpenseFormModal
        open={formOpen}
        onOpenChange={setFormOpen}
        expense={editing}
        platforms={platforms}
        onSaved={fetchExpenses}
      />

      {/* Import modal */}
      <ImportCsvModal
        open={importOpen}
        onOpenChange={setImportOpen}
        platforms={platforms}
        onImported={fetchExpenses}
      />

      {/* Delete one confirm */}
      <Modal
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title="Excluir despesa"
        description="Esta ação não pode ser desfeita."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              Cancelar
            </Button>
            <Button variant="danger" loading={deleting} onClick={confirmDeleteOne}>
              Excluir
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink">
          Excluir{" "}
          <span className="font-display font-bold">
            {deleteTarget?.description}
          </span>
          ?
        </p>
      </Modal>

      {/* Bulk delete confirm */}
      <Modal
        open={bulkConfirm}
        onOpenChange={setBulkConfirm}
        title="Excluir selecionadas"
        description="Esta ação não pode ser desfeita."
        footer={
          <>
            <Button variant="ghost" onClick={() => setBulkConfirm(false)}>
              Cancelar
            </Button>
            <Button variant="danger" loading={deleting} onClick={confirmBulkDelete}>
              Excluir {selectedCount}
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink">
          Excluir {selectedCount} despesa{selectedCount === 1 ? "" : "s"}{" "}
          selecionada{selectedCount === 1 ? "" : "s"}?
        </p>
      </Modal>
    </div>
  );
}

/** Per-row actions menu (⋯). */
function RowMenu({
  onEdit,
  onDelete,
}: {
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <Menu
      align="end"
      trigger={
        <button
          aria-label="Ações"
          className="rounded-md px-2 py-1 text-lg leading-none text-ink-soft transition-colors hover:bg-panel hover:text-ink"
        >
          ⋯
        </button>
      }
    >
      <MenuItem onSelect={onEdit}>Editar</MenuItem>
      <MenuSeparator />
      <MenuItem danger onSelect={onDelete}>
        Excluir
      </MenuItem>
    </Menu>
  );
}
