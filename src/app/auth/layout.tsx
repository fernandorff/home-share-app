import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="paper-grain flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <header className="mb-6 text-center">
          <div className="mx-auto mb-3 h-px w-24 border-t border-dashed border-rule" />
          <h1 className="font-display text-2xl font-bold tracking-tight text-ink">
            HOME SHARE
          </h1>
          <p className="label-mono mt-1">contas da casa · extrato</p>
        </header>
        {children}
        <p className="mt-6 text-center text-[0.7rem] uppercase tracking-widest text-faint">
          ░ despesas compartilhadas ░
        </p>
      </div>
    </main>
  );
}
