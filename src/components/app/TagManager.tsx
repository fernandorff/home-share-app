"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { api, ApiError } from "@/lib/api";
import { useApiError } from "@/lib/api-errors";
import { useFetch } from "@/lib/use-fetch";
import { useToast } from "@/components/ui/Toast";
import { Card, ReceiptDivider } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Menu, MenuItem } from "@/components/ui/Menu";
import { Tag, type TagTone } from "@/components/ui/Stamp";
import { cn } from "@/components/ui/cn";
import { SkeletonRows } from "@/components/ui/Skeleton";
import type { NamedTag } from "@/lib/types";

/** Maps a dimension's response key to its Tag tone + a left-accent border for custom rows. */
const TONE_BY_KEY: Record<"categories" | "platforms" | "paymentMethods", TagTone> = {
  categories: "category",
  platforms: "platform",
  paymentMethods: "payment",
};
const ROW_ACCENT: Record<TagTone, string> = {
  default: "border-l-rule",
  category: "border-l-cat",
  platform: "border-l-plat",
  payment: "border-l-pay",
};

/** Error codes from POST create that belong under the name field, not in a toast (U11):
 *  duplicate/system-default collisions and any name-validation code from the route. */
function isNameFieldError(code: string): boolean {
  return code === "DUPLICATE_NAME" || code === "SYSTEM_DEFAULT_COLLISION" || code.startsWith("NAME_");
}

/** Manages one tag dimension (category / platform / payment method): system defaults (read-only)
 *  + the house's custom entries (create / delete). Used three times on the Catalogs page. */
export function TagManager({
  label,
  kind,
  apiBase,
  responseKey,
  defaultKeys,
  defaultLabel,
  nameMax,
}: {
  label: string;
  /** Singular, lowercase form of `label` (e.g. "category", not "Categories") — used in the
   *  Add/Delete dialog titles so they don't read "Add categories" for a single new row (U8/BL-33). */
  kind: string;
  apiBase: string;
  responseKey: "categories" | "platforms" | "paymentMethods";
  defaultKeys: readonly string[];
  defaultLabel: (key: string) => string;
  nameMax: number;
}) {
  const t = useTranslations("Catalogs");
  const tc = useTranslations("Common");
  const tone = TONE_BY_KEY[responseKey];
  const toast = useToast();
  const apiErr = useApiError();

  const { data, loading, reload } = useFetch<Record<string, NamedTag[]>>(
    `${apiBase}?counts=true`,
    { onError: (e) => toast(apiErr(e, t("loadError")), "error") }
  );
  const items = data?.[responseKey] ?? [];

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<NamedTag | null>(null);
  const [removing, setRemoving] = useState(false);

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    setSaving(true);
    setNameError(null);
    try {
      await api.post(apiBase, { name: n });
      // R3-18: the toast names what was added/deleted ("Category added") — three sections share this component.
      toast(t("createdToast", { kind: responseKey }), "success");
      setCreating(false);
      await reload();
    } catch (err) {
      if (err instanceof ApiError && err.code && isNameFieldError(err.code)) {
        setNameError(apiErr(err, t("saveError")));
      } else {
        toast(apiErr(err, t("saveError")), "error");
      }
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setRemoving(true);
    try {
      await api.del(`${apiBase}/${deleting.publicId}`);
      toast(t("deletedToast", { kind: responseKey }), "success");
      setDeleting(null);
      await reload();
    } catch (err) {
      toast(apiErr(err, t("deleteError")), "error");
    } finally {
      setRemoving(false);
    }
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-rule bg-panel/40 px-4 py-3">
        {/* Real <h2> per section (was a <span>) + a section-scoped accessible name on the add
            button, so a screen reader doesn't read three identical "Add" buttons (a11y). */}
        <h2 className="font-display text-sm font-bold uppercase tracking-wide text-ink">{label}</h2>
        <Button size="sm" onClick={() => { setName(""); setNameError(null); setCreating(true); }} aria-label={`${t("new")} — ${label}`}>
          {t("new")}
        </Button>
      </div>

      {/* System defaults — always available, read-only */}
      <div className="border-b border-dashed border-rule px-4 py-3">
        <span className="label-mono mb-2 block">{t("systemTitle")}</span>
        <div className="flex flex-wrap gap-2">
          {defaultKeys.map((k) => (
            <Tag key={k} tone={tone}>{defaultLabel(k)}</Tag>
          ))}
        </div>
      </div>

      {/* House custom */}
      <div className="px-4 pt-3">
        <span className="label-mono">{t("customTitle")}</span>
      </div>
      {loading ? (
        <div className="p-2">
          <SkeletonRows rows={2} />
        </div>
      ) : items.length === 0 ? (
        <p className="px-4 py-4 text-sm text-faint">{t("emptyHint")}</p>
      ) : (
        <ul className="py-1">
          {items.map((c, i) => (
            <li key={c.publicId}>
              {i > 0 && <ReceiptDivider />}
              <div className={cn("flex items-center gap-3 border-l-2 px-4 py-2.5", ROW_ACCENT[tone])}>
                <span className="min-w-0 flex-1 break-words text-sm font-medium text-ink">{c.name}</span>
                <Tag className="tnum min-w-[6.5rem] shrink-0 justify-center">
                  {t("expenseCount", { count: c._count?.expenses ?? 0 })}
                </Tag>
                <Menu
                  trigger={
                    <button
                      aria-label={t("actionsFor", { name: c.name })}
                      // min-h-11 min-w-11: 44px touch floor on mobile (A3 — was 31x26); md:* restores compact desktop.
                      className="grid min-h-11 min-w-11 shrink-0 place-items-center rounded-md px-2 py-1 text-lg leading-none text-faint transition-colors hover:bg-panel hover:text-ink md:min-h-0 md:min-w-0"
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

      <Modal
        open={creating}
        onOpenChange={(o) => !o && !saving && setCreating(false)}
        title={t("createTitle", { kind })}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)} disabled={saving}>
              {tc("cancel")}
            </Button>
            <Button type="submit" form="tag-form" loading={saving} disabled={!name.trim()}>
              {t("createButton")}
            </Button>
          </>
        }
      >
        <form id="tag-form" onSubmit={submitCreate}>
          <Field label={t("nameLabel")} htmlFor="tag-name" error={nameError}>
            <Input
              id="tag-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (nameError) setNameError(null);
              }}
              maxLength={nameMax}
              required
              autoFocus
              placeholder={t("namePlaceholder")}
              aria-invalid={!!nameError}
            />
          </Field>
        </form>
      </Modal>

      <Modal
        open={deleting !== null}
        onOpenChange={(o) => !o && !removing && setDeleting(null)}
        title={t("deleteTitle", { kind })}
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
          {t("deleteExplanation", { name: deleting?.name ?? "", count: deleting?._count?.expenses ?? 0 })}
        </p>
      </Modal>
    </Card>
  );
}
