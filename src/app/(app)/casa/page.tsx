"use client";

import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/components/ui/cn";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { Card, ReceiptDivider, SectionTitle } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { MemberDot } from "@/components/ui/Member";
import { Tag } from "@/components/ui/Stamp";
import { Spinner } from "@/components/ui/Feedback";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { revealDelay } from "@/components/ui/motion";

function roleLabel(role: "ADMIN" | "MEMBER"): string {
  return role === "ADMIN" ? "Admin" : "Membro";
}

export default function CasaPage() {
  const { me, activeGroup, members, membersLoading, refresh, switchGroup } =
    useSession();
  const toast = useToast();

  // Regenerate code (ADMIN)
  const [regenerating, setRegenerating] = useState(false);

  // Switch house
  const [switchingId, setSwitchingId] = useState<number | null>(null);

  // Create new house
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  // Join with code
  const [joinCode, setJoinCode] = useState("");
  const [joining, setJoining] = useState(false);

  if (!me || !activeGroup) return null;

  const isAdmin = activeGroup.role === "ADMIN";
  const code = activeGroup.joinCode;

  async function copyCode() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      toast("Código copiado", "success");
    } catch {
      toast("Não foi possível copiar o código", "error");
    }
  }

  async function regenerateCode() {
    setRegenerating(true);
    try {
      await api.post("/api/groups/active/regenerate-code");
      await refresh();
      toast("Novo código gerado", "success");
    } catch (err) {
      toast(
        err instanceof ApiError ? err.message : "Erro ao gerar novo código",
        "error"
      );
    } finally {
      setRegenerating(false);
    }
  }

  async function onSwitch(groupId: number) {
    if (!activeGroup || groupId === activeGroup.id) return;
    setSwitchingId(groupId);
    try {
      await switchGroup(groupId);
      toast("Casa ativa alterada", "success");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Erro ao trocar de casa", "error");
    } finally {
      setSwitchingId(null);
    }
  }

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      await api.post("/api/groups", { name });
      await refresh();
      setNewName("");
      setCreateOpen(false);
      toast("Casa criada", "success");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Erro ao criar casa", "error");
    } finally {
      setCreating(false);
    }
  }

  async function onJoin(e: React.FormEvent) {
    e.preventDefault();
    const c = joinCode.trim().toUpperCase();
    if (c.length !== 6) return;
    setJoining(true);
    try {
      await api.post("/api/groups/join", { code: c });
      await refresh();
      setJoinCode("");
      toast("Você entrou na casa", "success");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Erro ao entrar na casa", "error");
    } finally {
      setJoining(false);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      {/* 1 — Header: active house + role */}
      <section className="flex flex-col gap-4">
        <SectionTitle>Casa</SectionTitle>
        <Card className="reveal flex items-center gap-3 p-4">
          <MemberDot
            colorIndex={activeGroup.colorIndex}
            name={activeGroup.name}
            size={40}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate font-display text-lg font-bold text-ink">
                {activeGroup.name}
              </h1>
              <Tag>{roleLabel(activeGroup.role)}</Tag>
            </div>
            <p className="label-mono mt-0.5">Casa ativa</p>
          </div>
        </Card>
      </section>

      {/* 2 — Invite / join code */}
      <section className="flex flex-col gap-4">
        <SectionTitle>Convite</SectionTitle>
        <Card className="reveal p-4">
          {isAdmin && code ? (
            <div className="flex flex-col gap-4">
              <div>
                <p className="label-mono mb-2">Código de entrada — Ref.</p>
                <div className="rule-dashed flex items-baseline gap-3 pb-3">
                  <span className="font-mono text-3xl font-bold uppercase tracking-[0.35em] text-ink tnum">
                    {code}
                  </span>
                </div>
                <p className="mt-2 text-sm text-faint">
                  Compartilhe este código para alguém entrar nesta casa.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" onClick={copyCode}>
                  Copiar
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  loading={regenerating}
                  onClick={regenerateCode}
                >
                  Regenerar código
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-faint">
              Apenas administradores gerenciam o código de entrada desta casa.
            </p>
          )}
        </Card>
      </section>

      {/* 3 — Members */}
      <section className="flex flex-col gap-4">
        <SectionTitle right={<span className="label-mono">{members.length}</span>}>
          Membros
        </SectionTitle>
        <Card className="reveal p-2">
          {membersLoading ? (
            <SkeletonRows rows={3} className="px-2" />
          ) : members.length === 0 ? (
            <p className="px-2 py-6 text-sm text-faint">Nenhum membro encontrado.</p>
          ) : (
            <ul>
              {members.map((m, i) => (
                <li key={m.id} className="reveal" style={revealDelay(i)}>
                  {i > 0 && <ReceiptDivider />}
                  <div className="flex items-center gap-3 px-2 py-3">
                    <MemberDot colorIndex={m.colorIndex} name={m.name} size={32} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-ink">{m.name}</p>
                      <p className="truncate text-xs text-faint">@{m.username}</p>
                    </div>
                    <Tag>{roleLabel(m.role)}</Tag>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      {/* 4 — Your houses / switch */}
      <section className="flex flex-col gap-4">
        <SectionTitle
          right={
            <Button size="sm" variant="secondary" onClick={() => setCreateOpen(true)}>
              + Nova casa
            </Button>
          }
        >
          Suas casas
        </SectionTitle>
        <Card className="reveal p-2">
          <ul>
            {me.user.groups.map((g, i) => {
              const active = g.id === activeGroup.id;
              return (
                <li key={g.id} className="reveal" style={revealDelay(i)}>
                  {i > 0 && <ReceiptDivider />}
                  <button
                    type="button"
                    disabled={active || switchingId != null}
                    onClick={() => onSwitch(g.id)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-md px-2 py-3 text-left transition-colors",
                      active
                        ? "cursor-default bg-panel"
                        : "hover:bg-panel disabled:opacity-60"
                    )}
                  >
                    <MemberDot colorIndex={g.colorIndex} name={g.name} size={32} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-ink">{g.name}</p>
                      <p className="label-mono mt-0.5">{roleLabel(g.role)}</p>
                    </div>
                    {switchingId === g.id ? (
                      <Spinner />
                    ) : active ? (
                      <span className="text-sm text-stamp">✓ ativa</span>
                    ) : (
                      <span className="label-mono">trocar</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>
      </section>

      {/* 5 — Join with code */}
      <section className="flex flex-col gap-4">
        <SectionTitle>Entrar com código</SectionTitle>
        <Card className="reveal p-4">
          <form onSubmit={onJoin} className="flex flex-col gap-3">
            <Field
              label="Código de 6 caracteres"
              htmlFor="join-code"
              hint="Peça o código ao administrador da casa."
            >
              <Input
                id="join-code"
                value={joinCode}
                onChange={(e) =>
                  setJoinCode(e.target.value.toUpperCase().slice(0, 6))
                }
                maxLength={6}
                autoCapitalize="characters"
                autoComplete="off"
                placeholder="ABC123"
                className="font-mono uppercase tracking-[0.35em]"
              />
            </Field>
            <Button
              type="submit"
              loading={joining}
              disabled={joinCode.trim().length !== 6}
              className="w-full"
            >
              Entrar na casa
            </Button>
          </form>
        </Card>
      </section>

      {/* Create house modal */}
      <Modal
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="Nova casa"
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCreateOpen(false)}
            >
              Cancelar
            </Button>
            <Button
              size="sm"
              form="create-house-form"
              type="submit"
              loading={creating}
              disabled={!newName.trim()}
            >
              Criar
            </Button>
          </>
        }
      >
        <form id="create-house-form" onSubmit={onCreate}>
          <Field label="Nome da casa" htmlFor="house-name">
            <Input
              id="house-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              maxLength={80}
              autoFocus
              required
              placeholder="Ex.: Apartamento 42"
            />
          </Field>
        </form>
      </Modal>
    </div>
  );
}
