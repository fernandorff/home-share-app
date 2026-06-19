"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
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

  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [loading, setLoading] = useState(true);

  // Create / rename modal
  const [edit, setEdit] = useState<EditState>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  // Delete modal
  const [deleting, setDeleting] = useState<Platform | null>(null);
  const [replacementId, setReplacementId] = useState("");
  const [removing, setRemoving] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ platforms: Platform[] }>(
        "/api/platforms?counts=true"
      );
      setPlatforms(data.platforms);
    } catch (err) {
      toast(
        err instanceof ApiError ? err.message : "Erro ao carregar plataformas",
        "error"
      );
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

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
        toast("Plataforma criada!", "success");
      } else {
        await api.patch(`/api/platforms/${edit.platform.publicId}`, {
          name: trimmed,
        });
        toast("Plataforma renomeada!", "success");
      }
      setEdit(null);
      await load();
    } catch (err) {
      toast(
        err instanceof ApiError ? err.message : "Erro ao salvar plataforma",
        "error"
      );
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
      toast("Plataforma excluída!", "success");
      setDeleting(null);
      await load();
    } catch (err) {
      toast(
        err instanceof ApiError ? err.message : "Erro ao excluir plataforma",
        "error"
      );
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
            Nova plataforma
          </Button>
        }
      >
        Plataformas
      </SectionTitle>

      {loading ? (
        <SkeletonRows rows={4} />
      ) : platforms.length === 0 ? (
        <Card>
          <EmptyState
            title="Nenhuma plataforma"
            hint="Crie a primeira forma de pagamento."
            action={<Button onClick={openCreate}>Nova plataforma</Button>}
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
                  <Tag className="tnum shrink-0">
                    {p._count?.expenses ?? 0} despesas
                  </Tag>
                  <Menu
                    trigger={
                      <button
                        aria-label={`Ações para ${p.name}`}
                        className="shrink-0 rounded-md px-2 py-1 text-lg leading-none text-faint transition-colors hover:bg-panel hover:text-ink"
                      >
                        ⋯
                      </button>
                    }
                  >
                    <MenuItem onSelect={() => openRename(p)}>Renomear</MenuItem>
                    <MenuItem danger onSelect={() => openDelete(p)}>
                      Excluir
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
        title={edit?.mode === "rename" ? "Renomear plataforma" : "Nova plataforma"}
        description="Formas de pagamento usadas nas despesas (ex: cartão, Pix, dinheiro)."
        footer={
          <>
            <Button variant="ghost" onClick={closeEdit} disabled={saving}>
              Cancelar
            </Button>
            <Button
              type="submit"
              form="platform-form"
              loading={saving}
              disabled={!name.trim()}
            >
              {edit?.mode === "rename" ? "Salvar" : "Criar"}
            </Button>
          </>
        }
      >
        <form id="platform-form" onSubmit={submitEdit}>
          <Field label="Nome" htmlFor="platform-name">
            <Input
              id="platform-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={NAME_MAX}
              required
              autoFocus
              placeholder="Ex: Cartão Nubank"
            />
          </Field>
        </form>
      </Modal>

      {/* Delete modal */}
      <Modal
        open={deleting !== null}
        onOpenChange={(o) => !o && closeDelete()}
        title="Excluir plataforma"
        footer={
          onlyOne ? (
            <Button variant="secondary" onClick={closeDelete}>
              Fechar
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={closeDelete} disabled={removing}>
                Cancelar
              </Button>
              <Button
                variant="danger"
                loading={removing}
                disabled={!replacementId}
                onClick={confirmDelete}
              >
                Excluir
              </Button>
            </>
          )
        }
      >
        {onlyOne ? (
          <p className="text-sm text-ink-soft">
            Você não pode excluir a única plataforma. Crie outra plataforma antes
            de excluir esta.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-ink-soft">
              As despesas de{" "}
              <span className="font-bold text-ink">{deleting?.name}</span>
              {deleting?._count?.expenses ? (
                <>
                  {" "}
                  (<span className="tnum">{deleting._count.expenses}</span>{" "}
                  despesas)
                </>
              ) : null}{" "}
              serão movidas para outra plataforma. Escolha qual:
            </p>
            <Field
              label="Mover despesas para"
              htmlFor="replacement"
              hint="Obrigatório — esta plataforma herdará as despesas."
            >
              <Select
                id="replacement"
                value={replacementId}
                onChange={(e) => setReplacementId(e.target.value)}
              >
                <option value="" disabled>
                  Selecione uma plataforma…
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
