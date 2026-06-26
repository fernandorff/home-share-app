"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api";
import { useApiError } from "@/lib/api-errors";
import { useFetch } from "@/lib/use-fetch";
import { useToast } from "@/components/ui/Toast";
import { Card, ReceiptDivider, SectionTitle } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Menu, MenuItem } from "@/components/ui/Menu";
import { Tag } from "@/components/ui/Stamp";
import { EmptyState } from "@/components/ui/Feedback";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { revealDelay } from "@/components/ui/motion";
import { EXPENSE_CATEGORIES } from "@/lib/categories";
import { LIMITS } from "@/lib/constants";
import type { Category } from "@/lib/types";

export default function CategoriasPage() {
  const toast = useToast();
  const t = useTranslations("Categories");
  const tCat = useTranslations("Expenses");
  const tc = useTranslations("Common");
  const apiErr = useApiError();

  const { data, loading, reload } = useFetch<{ categories: Category[] }>(
    "/api/categories?counts=true",
    { onError: (err) => toast(apiErr(err, t("loadError")), "error") }
  );
  const categories = data?.categories ?? [];

  // Create modal
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  // Delete modal
  const [deleting, setDeleting] = useState<Category | null>(null);
  const [removing, setRemoving] = useState(false);

  function openCreate() {
    setName("");
    setCreating(true);
  }

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      await api.post("/api/categories", { name: trimmed });
      toast(t("createdToast"), "success");
      setCreating(false);
      await reload();
    } catch (err) {
      toast(apiErr(err, t("saveError")), "error");
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setRemoving(true);
    try {
      await api.del(`/api/categories/${deleting.publicId}`);
      toast(t("deletedToast"), "success");
      setDeleting(null);
      await reload();
    } catch (err) {
      toast(apiErr(err, t("deleteError")), "error");
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <SectionTitle
        right={
          <Button size="sm" onClick={openCreate}>
            {t("new")}
          </Button>
        }
      >
        {t("title")}
      </SectionTitle>

      {/* System defaults — always available, not editable */}
      <Card className="overflow-hidden">
        <div className="border-b border-dashed border-rule bg-panel/40 px-4 py-2.5">
          <span className="label-mono">{t("systemTitle")}</span>
        </div>
        <ul className="flex flex-wrap gap-2 p-4">
          {EXPENSE_CATEGORIES.map((key) => (
            <Tag key={key}>{tCat(`category.${key}`)}</Tag>
          ))}
        </ul>
      </Card>

      {/* House custom categories */}
      <Card className="overflow-hidden">
        <div className="border-b border-dashed border-rule bg-panel/40 px-4 py-2.5">
          <span className="label-mono">{t("customTitle")}</span>
        </div>
        {loading ? (
          <div className="p-2">
            <SkeletonRows rows={3} />
          </div>
        ) : categories.length === 0 ? (
          <EmptyState
            title={t("emptyTitle")}
            hint={t("emptyHint")}
            action={<Button onClick={openCreate}>{t("new")}</Button>}
          />
        ) : (
          <ul>
            {categories.map((c, i) => (
              <li key={c.publicId} className="reveal" style={revealDelay(i)}>
                {i > 0 && <ReceiptDivider />}
                <div className="flex items-center gap-3 px-4 py-3">
                  <span className="min-w-0 flex-1 break-words font-display text-sm font-bold text-ink">
                    {c.name}
                  </span>
                  <Tag className="tnum min-w-[6.5rem] shrink-0 justify-center">
                    {t("expenseCount", { count: c._count?.expenses ?? 0 })}
                  </Tag>
                  <Menu
                    trigger={
                      <button
                        aria-label={t("actionsFor", { name: c.name })}
                        className="shrink-0 rounded-md px-2 py-1 text-lg leading-none text-faint transition-colors hover:bg-panel hover:text-ink"
                      >
                        ⋯
                      </button>
                    }
                  >
                    <MenuItem danger onSelect={() => setDeleting(c)}>
                      {t("delete")}
                    </MenuItem>
                  </Menu>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Create modal */}
      <Modal
        open={creating}
        onOpenChange={(o) => !o && !saving && setCreating(false)}
        title={t("createTitle")}
        description={t("modalDescription")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)} disabled={saving}>
              {tc("cancel")}
            </Button>
            <Button type="submit" form="category-form" loading={saving} disabled={!name.trim()}>
              {t("createButton")}
            </Button>
          </>
        }
      >
        <form id="category-form" onSubmit={submitCreate}>
          <Field label={t("nameLabel")} htmlFor="category-name">
            <Input
              id="category-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={LIMITS.CATEGORY_NAME}
              required
              autoFocus
              placeholder={t("namePlaceholder")}
            />
          </Field>
        </form>
      </Modal>

      {/* Delete modal */}
      <Modal
        open={deleting !== null}
        onOpenChange={(o) => !o && !removing && setDeleting(null)}
        title={t("deleteTitle")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)} disabled={removing}>
              {tc("cancel")}
            </Button>
            <Button variant="danger" loading={removing} onClick={confirmDelete}>
              {t("delete")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-soft">
          {t.rich("deleteExplanation", {
            count: deleting?._count?.expenses ?? 0,
            name: () => <span className="font-bold text-ink">{deleting?.name}</span>,
            num: (chunks) => <span className="tnum">{chunks}</span>,
          })}
        </p>
      </Modal>
    </div>
  );
}
