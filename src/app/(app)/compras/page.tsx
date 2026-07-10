"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api";
import { useApiError } from "@/lib/api-errors";
import { useSession } from "@/lib/session";
import { formatDateLocale } from "@/lib/money";
import type { ShoppingItem } from "@/lib/types";
import { cn } from "@/components/ui/cn";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { Card, ReceiptDivider, SectionTitle } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { EmptyState } from "@/components/ui/Feedback";
import { Tag } from "@/components/ui/Stamp";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { useToast } from "@/components/ui/Toast";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { revealDelay } from "@/components/ui/motion";

const NAME_MAX = 200;

export default function ComprasPage() {
  const t = useTranslations("Shopping");
  const tc = useTranslations("Common");
  const apiErr = useApiError();
  const toast = useToast();
  const { activeGroup } = useSession();

  const [items, setItems] = useState<ShoppingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const reqId = useRef(0);

  // quick-add
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  // Ref (not just the `adding` state) so a fast double-click/double-Enter can't re-enter add()
  // before React re-renders — state reads inside the closure aren't a synchronous guard.
  const addingRef = useRef(false);

  // per-item async guards (publicIds in flight)
  const [busy, setBusy] = useState<Set<string>>(new Set());

  // rename modal
  const [editing, setEditing] = useState<ShoppingItem | null>(null);
  const [editName, setEditName] = useState("");
  const [saving, setSaving] = useState(false);

  // delete confirm (publicId pending confirmation)
  const [confirmDelete, setConfirmDelete] = useState<ShoppingItem | null>(null);
  const [clearingPurchased, setClearingPurchased] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const errMsg = (e: unknown) => apiErr(e, t("genericError"));

  const setItemBusy = (publicId: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(publicId);
      else next.delete(publicId);
      return next;
    });

  const load = useCallback(async () => {
    const id = ++reqId.current;
    try {
      const { items } = await api.get<{ items: ShoppingItem[] }>("/api/shopping-items");
      if (reqId.current === id) setItems(items);
    } catch (e) {
      if (reqId.current === id) toast(errMsg(e), "error");
    } finally {
      if (reqId.current === id) setLoading(false);
    }
  }, [toast]);

  // Reload whenever the active house changes (and on mount); reqId drops stale responses.
  useEffect(() => {
    setLoading(true);
    void load();
  }, [activeGroup?.id, load]);

  const add = async () => {
    const name = draft.trim();
    if (!name || addingRef.current) return;
    addingRef.current = true;
    setAdding(true);
    try {
      await api.post<{ item: ShoppingItem }>("/api/shopping-items", { name });
      setDraft("");
      await load();
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      addingRef.current = false;
      setAdding(false);
    }
  };

  // Optimistic toggle: flip locally, revert on error.
  const toggle = async (item: ShoppingItem) => {
    if (busy.has(item.publicId)) return;
    setItemBusy(item.publicId, true);
    setItems((prev) =>
      prev.map((it) =>
        it.publicId === item.publicId ? { ...it, isPurchased: !it.isPurchased } : it
      )
    );
    try {
      await api.patch<{ item: ShoppingItem }>(
        `/api/shopping-items/${item.publicId}/toggle`
      );
      // resync ordering (server reorders purchased to bottom)
      await load();
    } catch (e) {
      // revert
      setItems((prev) =>
        prev.map((it) =>
          it.publicId === item.publicId ? { ...it, isPurchased: item.isPurchased } : it
        )
      );
      toast(errMsg(e), "error");
    } finally {
      setItemBusy(item.publicId, false);
    }
  };

  const openEdit = (item: ShoppingItem) => {
    setEditing(item);
    setEditName(item.name);
  };

  const saveEdit = async () => {
    if (!editing) return;
    const name = editName.trim();
    if (!name || saving) return;
    if (name === editing.name) {
      setEditing(null);
      return;
    }
    setSaving(true);
    try {
      const { item } = await api.put<{ item: ShoppingItem }>(
        `/api/shopping-items/${editing.publicId}`,
        { name }
      );
      setItems((prev) =>
        prev.map((it) => (it.publicId === item.publicId ? item : it))
      );
      setEditing(null);
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (item: ShoppingItem) => {
    setConfirmDelete(null);
    setItemBusy(item.publicId, true);
    try {
      await api.del<{ success: true }>(`/api/shopping-items/${item.publicId}`);
      setItems((prev) => prev.filter((it) => it.publicId !== item.publicId));
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setItemBusy(item.publicId, false);
    }
  };

  const clearPurchased = async () => {
    if (clearingPurchased) return;
    setClearingPurchased(true);
    try {
      const { deleted } = await api.del<{ deleted: number }>(
        "/api/shopping-items/clear-purchased"
      );
      setItems((prev) => prev.filter((it) => !it.isPurchased));
      toast(t("cleared", { count: deleted }), "success");
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setClearingPurchased(false);
      setConfirmClear(false);
    }
  };

  const toBuy = items.filter((it) => !it.isPurchased);
  const purchased = items.filter((it) => it.isPurchased);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-2xl font-bold tracking-tight text-ink">
          {t("title")}
        </h1>
        <p className="text-sm text-faint">{t("subtitle")}</p>
      </header>

      {/* Quick-add bar */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
        className="flex gap-2"
      >
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t("addPlaceholder")}
          maxLength={NAME_MAX}
          aria-label={t("nameLabel")}
          autoComplete="off"
        />
        <Button type="submit" loading={adding} disabled={!draft.trim()}>
          {t("addButton")}
        </Button>
      </form>

      {loading ? (
        <SkeletonRows rows={5} />
      ) : items.length === 0 ? (
        <Card>
          <EmptyState title={t("emptyTitle")} hint={t("emptyHint")} icon="🛒" />
        </Card>
      ) : (
        <div className="flex flex-col gap-6">
          {/* A comprar */}
          <section className="flex flex-col gap-3">
            <SectionTitle right={<span className="label-mono">{toBuy.length}</span>}>
              {t("toBuy")}
            </SectionTitle>
            {toBuy.length === 0 ? (
              <p className="px-1 text-sm text-faint">{t("allBought")}</p>
            ) : (
              <Card>
                <ul>
                  {toBuy.map((item, i) => (
                    <li key={item.publicId} className="reveal" style={revealDelay(i)}>
                      {i > 0 && <ReceiptDivider />}
                      <ItemRow
                        item={item}
                        busy={busy.has(item.publicId)}
                        onToggle={() => void toggle(item)}
                        onEdit={() => openEdit(item)}
                        onDelete={() => setConfirmDelete(item)}
                      />
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </section>

          {/* Comprados */}
          {purchased.length > 0 && (
            <section className="flex flex-col gap-3">
              <SectionTitle
                right={
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={clearingPurchased}
                    onClick={() => setConfirmClear(true)}
                  >
                    {t("clearPurchased")}
                  </Button>
                }
              >
                {t("purchased")}
              </SectionTitle>
              <Card>
                <ul>
                  {purchased.map((item, i) => (
                    <li key={item.publicId} className="reveal" style={revealDelay(i)}>
                      {i > 0 && <ReceiptDivider />}
                      <ItemRow
                        item={item}
                        busy={busy.has(item.publicId)}
                        onToggle={() => void toggle(item)}
                        onEdit={() => openEdit(item)}
                        onDelete={() => setConfirmDelete(item)}
                      />
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          )}
        </div>
      )}

      {/* Rename modal */}
      <Modal
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        title={t("editTitle")}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setEditing(null)}>
              {tc("cancel")}
            </Button>
            <Button
              size="sm"
              loading={saving}
              disabled={!editName.trim()}
              onClick={saveEdit}
            >
              {tc("save")}
            </Button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void saveEdit();
          }}
        >
          <Input
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            placeholder={t("nameLabel")}
            maxLength={NAME_MAX}
            aria-label={t("nameLabel")}
            autoFocus
          />
        </form>
      </Modal>

      {/* Delete confirm modal */}
      <Modal
        open={confirmDelete !== null}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
        title={t("deleteTitle")}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setConfirmDelete(null)}>
              {tc("cancel")}
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => confirmDelete && void remove(confirmDelete)}
            >
              {tc("delete")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink">
          {t.rich("deleteConfirm", {
            name: confirmDelete?.name ?? "",
            strong: (chunks) => <span className="font-semibold">{chunks}</span>,
          })}
        </p>
      </Modal>

      {/* Clear purchased confirm — bulk, irreversible (BL-14/B4) */}
      <Modal
        open={confirmClear}
        onOpenChange={(o) => !o && setConfirmClear(false)}
        title={t("clearPurchased")}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setConfirmClear(false)}>
              {tc("cancel")}
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={clearingPurchased}
              onClick={() => void clearPurchased()}
            >
              {t("clearPurchased")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink">{t("clearConfirm", { count: purchased.length })}</p>
      </Modal>
    </div>
  );
}

function ItemRow({
  item,
  busy,
  onToggle,
  onEdit,
  onDelete,
}: {
  item: ShoppingItem;
  busy: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations("Shopping");
  const tc = useTranslations("Common");
  return (
    <div className={cn("flex items-center gap-3 px-4 py-3", busy && "opacity-60")}>
      {/* Checkbox-style toggle — [ ] / [x] in mono */}
      <button
        type="button"
        onClick={onToggle}
        disabled={busy}
        aria-pressed={item.isPurchased}
        aria-label={item.isPurchased ? t("markNotPurchased") : t("markPurchased")}
        className={cn(
          // -m-4 cancels the p-4 for layout purposes, so the glyph stays visually put while the
          // actual hit area grows to ~44x44+ (D8/BL-21 — was 29x16px).
          "-m-4 shrink-0 select-none p-4 font-mono text-base leading-none transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-card rounded-sm",
          item.isPurchased ? "text-stamp" : "text-ink-soft hover:text-ink"
        )}
      >
        {item.isPurchased ? "[x]" : "[ ]"}
      </button>

      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "truncate text-sm",
            item.isPurchased ? "text-faint line-through" : "text-ink"
          )}
        >
          {item.name}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {item.addedBy && <Tag>{t("addedBy", { name: item.addedBy.name })}</Tag>}
          {/* Desktop shows the date in its own right-aligned column; surface it here on mobile. */}
          <span className="text-xs text-faint tnum sm:hidden">
            {formatDateLocale(item.createdAt)}
          </span>
        </div>
      </div>

      <span className="hidden shrink-0 text-xs text-faint tnum sm:inline">
        {formatDateLocale(item.createdAt)}
      </span>

      <Menu
        trigger={
          <button
            type="button"
            aria-label={t("itemActions")}
            disabled={busy}
            className="shrink-0 rounded-sm px-2 py-1 text-lg leading-none text-faint transition-colors hover:bg-panel hover:text-ink disabled:opacity-50"
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
    </div>
  );
}
