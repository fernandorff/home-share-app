"use client";

import { useState } from "react";
import { useSession } from "@/lib/session";
import { api, ApiError } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { Card } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";

export function Onboarding() {
  const { me, refresh } = useSession();
  const toast = useToast();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);

  async function createCasa(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      await api.post("/api/groups", { name: name.trim() });
      toast("Casa criada!", "success");
      await refresh(); // shell re-renders into the app once groups exist
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Erro ao criar casa", "error");
      setCreating(false);
    }
  }

  async function joinCasa(e: React.FormEvent) {
    e.preventDefault();
    setJoining(true);
    try {
      await api.post("/api/groups/join", { code: code.trim().toUpperCase() });
      toast("Você entrou na casa!", "success");
      await refresh();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Código inválido", "error");
      setJoining(false);
    }
  }

  const logout = async () => {
    try {
      await api.post("/api/auth/logout");
    } finally {
      window.location.href = "/auth/login";
    }
  };

  return (
    <main className="paper-grain min-h-dvh px-4 py-10">
      <div className="mx-auto max-w-2xl">
        <header className="mb-8 text-center">
          <h1 className="font-display text-2xl font-bold tracking-tight text-ink">
            HOME<span className="text-stamp">SHARE</span>
          </h1>
          <p className="mt-2 text-sm text-ink-soft">
            Olá, {me?.user.name}. Você ainda não está em nenhuma casa.
          </p>
          <p className="label-mono mt-1">crie uma ou entre com um código</p>
        </header>

        <div className="grid gap-4 md:grid-cols-2">
          <Card className="p-5">
            <form onSubmit={createCasa} className="flex flex-col gap-4">
              <h2 className="font-display text-base font-bold uppercase tracking-wide text-ink">
                Criar casa
              </h2>
              <Field label="Nome da casa" htmlFor="casa-name">
                <Input
                  id="casa-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={80}
                  required
                  placeholder="Ex: Casa Bolitas"
                />
              </Field>
              <Button type="submit" loading={creating} disabled={!name.trim()} className="w-full">
                Criar casa
              </Button>
              <p className="text-xs text-faint">Você vira admin e recebe um código para convidar.</p>
            </form>
          </Card>

          <Card className="p-5">
            <form onSubmit={joinCasa} className="flex flex-col gap-4">
              <h2 className="font-display text-base font-bold uppercase tracking-wide text-ink">
                Entrar com código
              </h2>
              <Field label="Código da casa" htmlFor="casa-code" hint="6 caracteres">
                <Input
                  id="casa-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  maxLength={6}
                  required
                  placeholder="ABC123"
                  className="text-center text-lg tracking-[0.4em] uppercase"
                />
              </Field>
              <Button
                type="submit"
                variant="secondary"
                loading={joining}
                disabled={code.trim().length !== 6}
                className="w-full"
              >
                Entrar
              </Button>
              <p className="text-xs text-faint">Peça o código para quem administra a casa.</p>
            </form>
          </Card>
        </div>

        <div className="mt-8 text-center">
          <button onClick={logout} className="label-mono underline underline-offset-2 hover:text-ink">
            sair
          </button>
        </div>
      </div>
    </main>
  );
}
