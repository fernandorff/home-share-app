# Claude Code Preferences

## Response Format
- Mostrar skills ativas no início: `**Skills ativas:** skill-name`

## Projeto

**Home Share** (ex-"La Casa das Bolitas") — app de **despesas compartilhadas** de uma casa.
**Servidor Rust/Axum** (`server/`) que serve a API JSON e a tela React gerada pelo **Vite** (`src/`), **same-origin**.
Produção: Fly.io (São Paulo) + Neon (São Paulo) + Cloudflare. A versão Next.js antiga fica no repositório
`fernandorff/home-share-next`.

- **Inglês em TUDO**: código, comentários, mensagens de erro, banco (schema sem `@map`) e URLs
  de página. Texto de UI só via i18n (`src/messages/`, EN/PT/ES/FR); erros de API carregam
  `code` que o client traduz (namespaces `ApiErrors`/`CsvErrors`, hook `useApiError`).
- **Auth**: **cookie httpOnly** `homeshare_session` (JWT HS256) — **NÃO** Bearer. Login/
  register/set-password setam o cookie e retornam só `{ user }` (token vai no cookie).
  Sessão deslizante de 30 dias (ADR 0013): `POST /api/auth/logout` sai só deste aparelho;
  `POST /api/auth/logout-all` revoga todos (bump de `sessionVersion`).
  **Login com Google** (OAuth) em `/api/auth/google[/callback]`, guarded por `GOOGLE_CLIENT_ID/SECRET` (mesmo cookie de sessão).
- **Casa ativa**: cookie httpOnly `homeshare_group` (preferência; a membership no banco é a
  autoridade). Trocar de casa = `POST /api/groups/active` `{ groupId }`. **Sem header X-Group-Id.**
  No Rust: extratores `Session` (`server/src/auth.rs`) e `ActiveHouse` (`server/src/house.rs`).
  `groupId` NUNCA vem do body.
- **Dinheiro**: centavos inteiros (`server/src/money.rs`; na tela, `lib/currency`: toCents/fromCents/splitCents);
  banco em `Decimal(10,2)` → `amount`/`participant.amount` serializam como **string** no JSON
  (balances vêm como number). Comparações exatas, sem epsilon.
- **Same-origin**: sem CORS no código. O front usa o wrapper `lib/api` (cookies automáticos).

## Estrutura

```
server/                   # Rust/Axum: API (/api/*), tela estática (dist/), tarefas diárias, push
├── src/main.rs           # rotas e camadas (headers de segurança, rate limit)
├── src/routes/           # um arquivo por grupo de rotas (expenses, groups, balances, push, jobs, …)
└── src/auth.rs, house.rs, money.rs, db.rs, config.rs, …
src/                      # tela React (Vite)
├── vite/                 # main.tsx (entrada), routes.tsx (react-router), shims/ (link, navigation)
├── app/
│   ├── auth/**           # páginas públicas (login, register, set-password)
│   └── (app)/**          # área logada (expenses, balances, shopping, catalogs, activity, house, settings, …)
├── components/           # ui/ (design system retro-mono), app/ (AppChrome, Onboarding), expenses/, …
├── lib/                  # api (client), session, format, members, currency, …
└── messages/             # i18n EN/PT/ES/FR
prisma/                   # schema.prisma + migrations (Prisma só como ferramenta de migração)
```

## Convenções
- UI retro editorial mono: monoespaçado, `tabular-nums`, regras pontilhadas, 1 acento "stamp".
  Mobile-first; animações de entrada (`reveal`/`revealDelay`) + skeletons, atrás de `prefers-reduced-motion`.
- Validações de input nas rotas (limites: descrição 200, notas 1000, CSV 1000 linhas/1MB).
- Gates (os mesmos da CI): `npx tsc --noEmit`, `npm run lint`, `npm run test` (vitest), `npm run build` (Vite) e
  `cargo test --manifest-path server/Cargo.toml`. Nenhum toca banco.
- **Uma branch só: `main`.** Trabalho em branch curta → PR para a `main` (a CI roda os gates) → merge = deploy:
  a CI aplica as migrações pendentes no banco de produção, faz `flyctl deploy` e confere `/api/health?db=1`.
- Schema só via **migrations** (`prisma/migrations`; CI falha sem migration). Migrations **aditivas**: o servidor
  antigo continua rodando com o schema novo até o deploy trocá-lo.
- Datas: convenção `T12:00:00` local na escrita; formata em UTC no export.
- **Porquês de arquitetura** (auth, casa ativa, dinheiro — com alternativas rejeitadas):
  `docs/decisions/` (ADRs, MADR, append-only). Consultar antes de mexer nessas áreas.
- **Feature não-trivial** = spec primeiro: `docs/specs/NNN-nome/` (copiar `_TEMPLATE`;
  critérios EARS verificáveis, tasks com caminho de arquivo + `_Requirements:_`).
