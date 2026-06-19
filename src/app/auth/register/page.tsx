"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { GoogleButton } from "@/components/auth/GoogleButton";

export default function RegisterPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api.post("/api/auth/register", {
        name: name.trim(),
        username: username.trim().toLowerCase(),
        password,
      });
      router.replace("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Erro ao criar conta");
      setLoading(false);
    }
  }

  return (
    <Card className="p-5">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <h2 className="font-display text-lg font-bold uppercase tracking-wide text-ink">
          Criar conta
        </h2>

        {error && (
          <div className="rounded-md border border-debt/40 bg-stamp-soft px-3 py-2 text-sm text-debt">
            {error}
          </div>
        )}

        <Field label="Nome" htmlFor="name">
          <Input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            maxLength={80}
            required
            placeholder="Seu nome"
          />
        </Field>

        <Field
          label="Usuário"
          htmlFor="username"
          hint="3–30 caracteres: letras minúsculas, números, . - _"
        >
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

        <Field label="Senha" htmlFor="password" hint="Mínimo 8 caracteres">
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

        <Button type="submit" loading={loading} className="w-full">
          Criar conta
        </Button>
      </form>

      <div className="my-4 flex items-center gap-3">
        <span className="flex-1 border-t border-dashed border-rule" />
        <span className="label-mono">ou</span>
        <span className="flex-1 border-t border-dashed border-rule" />
      </div>

      <GoogleButton label="Criar conta com Google" />

      <p className="mt-5 text-center text-sm text-faint">
        Já tem conta?{" "}
        <Link href="/auth/login" className="text-ink underline underline-offset-2">
          Entrar
        </Link>
      </p>
    </Card>
  );
}
