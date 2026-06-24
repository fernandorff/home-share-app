"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api";
import { useApiError } from "@/lib/api-errors";
import { useFetch } from "@/lib/use-fetch";
import { useToast } from "@/components/ui/Toast";
import { Card, ReceiptDivider, SectionTitle } from "@/components/ui/Card";
import { Field, Input, Select } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Menu, MenuItem } from "@/components/ui/Menu";
import { Tag } from "@/components/ui/Stamp";
import { EmptyState } from "@/components/ui/Feedback";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { revealDelay } from "@/components/ui/motion";
import type { Platform } from "@/lib/types";

const NAME_MAX = 80;

type EditState =
  | { mode: "create" }
  | { mode: "rename"; platform: Platform }
  | null;

export default function PlataformasPage() {
  const toast = useToast();
  const t = useTranslations("Platforms");
  const tc = useTranslations("Common");
  const apiErr = useApiError();

  const { data, loading, reload } = useFetch<{ platforms: Platform[] }>(
    "/api/platforms?counts=true",
    { onError: (err) => toast(apiErr(err, t("loadError")), "error") }
  );
  const platforms = data?.platforms ?? [];

  // Create / rename modal
  const [edit, setEdit] = useState<EditState>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  // Delete modal
  const [deleting, setDeleting] = useState<Platform | null>(null);
  const [replacementId, setReplacementId] = useState("");
  const [removing, setRemoving] = useState(false);

  // ---- Create / rename ----
  function openCreate() {
    setName("");
    setEdit({ mode: "create" });
  }

  function openRename(platform: Platform) {
    setName(platform.name);
    setEdit({ mode: "rename", platform });
  }

  function closeEdit() {
    if (saving) return;
    setEdit(null);
  }

  async function submitEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!edit) return;
    const trimmed = name.trim();
    if (!trimmed) return;

    setSaving(true);
    try {
      if (edit.mode === "create") {
        await api.post("/api/platforms", { name: trimmed });
        toast(t("createdToast"), "success");
      } else {
        await api.patch(`/api/platforms/${edit.platform.publicId}`, {
          name: trimmed,
        });
        toast(t("renamedToast"), "success");
      }
      setEdit(null);
      await reload();
    } catch (err) {
      toast(apiErr(err, t("saveError")), "error");
    } finally {
      setSaving(false);
    }
  }

  // ---- Delete ----
  function openDelete(platform: Platform) {
    setReplacementId("");
    setDeleting(platform);
  }

  function closeDelete() {
    if (removing) return;
    setDeleting(null);
  }

  async function confirmDelete() {
    if (!deleting || !replacementId) return;
    setRemoving(true);
    try {
      await api.del(`/api/platforms/${deleting.publicId}`, { replacementId });
      toast(t("deletedToast"), "success");
      setDeleting(null);
      await reload();
    } catch (err) {
      toast(apiErr(err, t("deleteError")), "error");
    } finally {
      setRemoving(false);
    }
  }

  const others = deleting
    ? platforms.filter((p) => p.publicId !== deleting.publicId)
    : [];
  const onlyOne = platforms.length === 1;

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

      {loading ? (
        <SkeletonRows rows={4} />
      ) : platforms.length === 0 ? (
        <Card>
          <EmptyState
            title={t("emptyTitle")}
            hint={t("emptyHint")}
            action={<Button onClick={openCreate}>{t("new")}</Button>}
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul>
            {platforms.map((p, i) => (
              <li key={p.publicId} className="reveal" style={revealDelay(i)}>
                {i > 0 && <ReceiptDivider />}
                <div className="flex items-center gap-3 px-4 py-3">
                  <span className="min-w-0 flex-1 truncate font-display text-sm font-bold text-ink">
                    {p.name}
                  </span>
                  <Tag className="tnum shrink-0 min-w-[6.5rem] justify-center">
                    {t("expenseCount", { count: p._count?.expenses ?? 0 })}
                  </Tag>
                  <Menu
                    trigger={
                      <button
                        aria-label={t("actionsFor", { name: p.name })}
                        className="shrink-0 rounded-md px-2 py-1 text-lg leading-none text-faint transition-colors hover:bg-panel hover:text-ink"
                      >
                        ⋯
                      </button>
                    }
                  >
                    <MenuItem onSelect={() => openRename(p)}>{t("rename")}</MenuItem>
                    <MenuItem danger onSelect={() => openDelete(p)}>
                      {t("delete")}
                    </MenuItem>
                  </Menu>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Create / rename modal */}
      <Modal
        open={edit !== null}
        onOpenChange={(o) => !o && closeEdit()}
        title={edit?.mode === "rename" ? t("renameTitle") : t("createTitle")}
        description={t("modalDescription")}
        footer={
          <>
            <Button variant="ghost" onClick={closeEdit} disabled={saving}>
              {tc("cancel")}
            </Button>
            <Button
              type="submit"
              form="platform-form"
              loading={saving}
              disabled={!name.trim()}
            >
              {edit?.mode === "rename" ? tc("save") : t("createButton")}
            </Button>
          </>
        }
      >
        <form id="platform-form" onSubmit={submitEdit}>
          <Field label={t("nameLabel")} htmlFor="platform-name">
            <Input
              id="platform-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={NAME_MAX}
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
        onOpenChange={(o) => !o && closeDelete()}
        title={t("deleteTitle")}
        footer={
          onlyOne ? (
            <Button variant="secondary" onClick={closeDelete}>
              {tc("close")}
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={closeDelete} disabled={removing}>
                {tc("cancel")}
              </Button>
              <Button
                variant="danger"
                loading={removing}
                disabled={!replacementId}
                onClick={confirmDelete}
              >
                {t("delete")}
              </Button>
            </>
          )
        }
      >
        {onlyOne ? (
          <p className="text-sm text-ink-soft">{t("cannotDeleteOnly")}</p>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-ink-soft">
              {t.rich("deleteExplanation", {
                count: deleting?._count?.expenses ?? 0,
                name: () => (
                  <span className="font-bold text-ink">{deleting?.name}</span>
                ),
                num: (chunks) => <span className="tnum">{chunks}</span>,
              })}
            </p>
            <Field
              label={t("moveLabel")}
              htmlFor="replacement"
              hint={t("moveHint")}
            >
              <Select
                id="replacement"
                value={replacementId}
                onChange={(e) => setReplacementId(e.target.value)}
              >
                <option value="" disabled>
                  {t("selectPlaceholder")}
                </option>
                {others.map((p) => (
                  <option key={p.publicId} value={p.publicId}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
      </Modal>
    </div>
  );
}
