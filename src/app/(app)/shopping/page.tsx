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
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/Feedback";
import { Tag } from "@/components/ui/Stamp";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { useToast } from "@/components/ui/Toast";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { revealDelay } from "@/components/ui/motion";
import { ExpenseLinkModal } from "@/components/shopping/ExpenseLinkModal";

const NAME_MAX = 200;

export default function ShoppingPage() {
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
  // justPurchased tells ExpenseLinkModal which flow opened it (B8): the footer's secondary
  // button reads "Skip for now" right after marking an item purchased, "Cancel" when editing
  // links from the item menu — the item's own data can't tell the two flows apart (an item can
  // reach the menu's "Link expenses" action with zero links too).
  const [linking, setLinking] = useState<{ item: ShoppingItem; justPurchased: boolean } | null>(null);

  const errMsg = useCallback(
    (e: unknown) => apiErr(e, t("genericError")),
    [apiErr, t]
  );

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
  }, [errMsg, toast]);

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
      const { item: updated } = await api.patch<{ item: ShoppingItem }>(
        `/api/shopping-items/${item.publicId}/toggle`
      );
      if (!item.isPurchased && updated.isPurchased) setLinking({ item: updated, justPurchased: true });
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
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

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
          <EmptyState title={t("emptyTitle")} hint={t("emptyHint")} icon="[ ]" />
        </Card>
      ) : (
        <div className="flex flex-col gap-6">
          {/* To buy */}
          <section className="flex flex-col gap-3">
            <SectionTitle right={<span className="label-mono">{toBuy.length}</span>}>
              {t("toBuy")}
            </SectionTitle>
            {toBuy.length === 0 ? (
              /* R3-33: no px-1 — the line starts on the cards' edge (was 4px in). */
              <p className="text-sm text-faint">{t("allBought")}</p>
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
                        onLink={() => setLinking({ item, justPurchased: false })}
                      />
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </section>

          {/* Purchased */}
          {purchased.length > 0 && (
            <section className="flex flex-col gap-3">
              {/* R3-16: bordered like R2-13's text buttons — its edge sits on the cards' edge (ghost padding ended the text 12px short). */}
              <SectionTitle
                right={
                  <Button
                    variant="secondary"
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
                        onLink={() => setLinking({ item, justPurchased: false })}
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
            <Button variant="ghost" onClick={() => setEditing(null)}>
              {tc("cancel")}
            </Button>
            <Button
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

      <ExpenseLinkModal
        item={linking?.item ?? null}
        justPurchased={linking?.justPurchased ?? false}
        onClose={() => setLinking(null)}
        onSaved={(updated) => {
          setItems((previous) => previous.map((item) => item.publicId === updated.publicId ? updated : item));
          setLinking(null);
        }}
      />

      {/* Delete confirm modal */}
      <Modal
        open={confirmDelete !== null}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
        title={t("deleteTitle")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
              {tc("cancel")}
            </Button>
            <Button
              variant="danger"
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
        title={t("clearPurchasedConfirmTitle")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmClear(false)}>
              {tc("cancel")}
            </Button>
            <Button
              variant="danger"
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
  onLink,
}: {
  item: ShoppingItem;
  busy: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onLink: () => void;
}) {
  const t = useTranslations("Shopping");
  const tc = useTranslations("Common");
  // B9: an item unchecked after being linked still has links — keep "Link expenses" so the
  // "N expenses" chip never points at links nobody can see or remove.
  const canLink = item.isPurchased || item.linkedExpenses.length > 0;
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
          item.isPurchased ? "text-stamp-text" : "text-ink-soft hover:text-ink"
        )}
      >
        {/* Fixed-width, centered box (D10): on the Bolitas skin --font-mono is a proportional
            font, so "[x]" and "[ ]" render at different natural widths (18px vs 14px) and
            misalign the rows below. The `ch` unit is set by the font's "0" glyph, so the box
            stays the same size no matter which glyph is inside. */}
        <span className="inline-block w-[3ch] text-center">{item.isPurchased ? "[x]" : "[ ]"}</span>
      </button>

      <div className="min-w-0 flex-1">
        <p
          className={cn(
            // U4 → R3-01: up to 3 lines before the ellipsis (was 2) — same rule as the expense cards.
            "line-clamp-3 break-words text-pretty text-sm",
            item.isPurchased ? "text-faint line-through" : "text-ink"
          )}
        >
          {item.name}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {/* D14: date first so it's never the sole item wrapped onto its own trailing line —
              it always shares the first line of the wrap with at least the next chip. */}
          <span className="text-xs text-faint tnum sm:hidden">
            {formatDateLocale(item.createdAt)}
          </span>
          {item.addedBy && <Tag>{t("addedBy", { name: item.addedBy.name })}</Tag>}
          {item.linkedExpenses.length > 0 && (
            <Tag tone="platform">{t("linkedExpenseCount", { count: item.linkedExpenses.length })}</Tag>
          )}
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
            // min-h-11 min-w-11: 44px touch floor on mobile (D3 — was 31x26); sm:* restores compact desktop.
            className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-sm px-2 py-1 text-lg leading-none text-faint transition-colors hover:bg-panel hover:text-ink disabled:opacity-50 md:min-h-0 md:min-w-0"
          >
            ⋯
          </button>
        }
      >
        {canLink && <MenuItem onSelect={onLink}>{t("linkExpensesAction")}</MenuItem>}
        {canLink && <MenuSeparator />}
        <MenuItem onSelect={onEdit}>{tc("edit")}</MenuItem>
        <MenuSeparator />
        <MenuItem danger onSelect={onDelete}>
          {tc("delete")}
        </MenuItem>
      </Menu>
    </div>
  );
}
