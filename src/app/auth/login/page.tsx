"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { GoogleButton } from "@/components/auth/GoogleButton";

const GOOGLE_ERRORS: Record<string, string> = {
  google_indisponivel: "Login com Google ainda não está configurado.",
  google_cancelado: "Login com Google cancelado.",
  google_estado: "A sessão do Google expirou — tente novamente.",
  google_falha: "Não foi possível entrar com o Google.",
};

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("error");
    if (code) setError(GOOGLE_ERRORS[code] ?? "Não foi possível entrar.");
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const u = username.trim().toLowerCase();
    try {
      const res = await api.post<{ user?: unknown; requiresPasswordSetup?: boolean }>(
        "/api/auth/login",
        { username: u, password }
      );
      if (res?.requiresPasswordSetup) {
        router.push(`/auth/set-password?u=${encodeURIComponent(u)}`);
        return;
      }
      router.replace("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Erro ao entrar");
      setLoading(false);
    }
  }

  return (
    <Card className="p-5">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <h2 className="font-display text-lg font-bold uppercase tracking-wide text-ink">
          Entrar
        </h2>

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

        <Field label="Senha" htmlFor="password">
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            placeholder="••••••••"
          />
        </Field>

        <Button type="submit" loading={loading} className="w-full">
          Entrar
        </Button>
      </form>

      <div className="my-4 flex items-center gap-3">
        <span className="flex-1 border-t border-dashed border-rule" />
        <span className="label-mono">ou</span>
        <span className="flex-1 border-t border-dashed border-rule" />
      </div>

      <GoogleButton label="Entrar com Google" />

      <p className="mt-5 text-center text-sm text-faint">
        Não tem conta?{" "}
        <Link href="/auth/register" className="text-ink underline underline-offset-2">
          Criar conta
        </Link>
      </p>
    </Card>
  );
}
