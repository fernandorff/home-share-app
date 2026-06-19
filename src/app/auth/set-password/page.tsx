"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";

export default function SetPasswordPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const u = new URLSearchParams(window.location.search).get("u");
    if (u) setUsername(u);
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("As senhas não coincidem.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await api.post("/api/auth/set-password", {
        username: username.trim().toLowerCase(),
        password,
      });
      router.replace("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Erro ao definir a senha");
      setLoading(false);
    }
  }

  return (
    <Card className="p-5">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <h2 className="font-display text-lg font-bold uppercase tracking-wide text-ink">
          Definir senha
        </h2>

        <p className="rounded-md border border-rule bg-panel px-3 py-2 text-sm text-ink-soft">
          Sua conta foi criada antes das senhas existirem. Defina uma senha para
          continuar usando o <b className="text-ink">Home Share</b>.
        </p>

        {error && (
          <div className="rounded-md border border-debt/40 bg-stamp-soft px-3 py-2 text-sm text-debt">
            {error}
          </div>
        )}

        <Field label="Usuário" htmlFor="username">
          <Input
            id="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            required
            placeholder="seu_usuario"
          />
        </Field>

        <Field label="Nova senha" htmlFor="password" hint="Mínimo 8 caracteres">
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
            placeholder="••••••••"
          />
        </Field>

        <Field label="Confirmar nova senha" htmlFor="confirm">
          <Input
            id="confirm"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
            placeholder="••••••••"
          />
        </Field>

        <Button type="submit" loading={loading} className="w-full">
          Definir senha e entrar
        </Button>
      </form>

      <p className="mt-5 text-center text-sm text-faint">
        <Link href="/auth/login" className="text-ink underline underline-offset-2">
          Voltar para entrar
        </Link>
      </p>
    </Card>
  );
}
