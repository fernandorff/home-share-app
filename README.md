# La Casa das Bolitas — API

Backend headless (Next.js API-only) para o app de despesas compartilhadas. Front
é um projeto separado que consome esta API via HTTP com **Bearer token**.

## Stack

Next.js 16 (só route handlers) · Prisma 7 (`@prisma/adapter-pg`) · PostgreSQL (Neon) ·
jose (JWT) · bcryptjs · Vitest. Sem React/UI no domínio — só o mínimo que o Next exige.

## Rodar local

```bash
cp .env.example .env   # preencha DATABASE_URL e JWT_SECRET
npm install
npx prisma generate
npm run dev            # http://localhost:3000
npm run test           # vitest (currency, balance, csv-parser, auth)
```

## Autenticação (Bearer, stateless)

- `POST /api/auth/register` e `POST /api/auth/login` retornam `{ token, user }`.
- O cliente guarda o token e envia em todas as chamadas: `Authorization: Bearer <token>`.
- Usuários legados (sem senha) → login retorna `{ requiresPasswordSetup: true }`;
  o cliente chama `POST /api/auth/set-password` que retorna `{ token, user }`.
- **Casa ativa** vai no header `X-Group-Id: <id>` (validado contra membership;
  default = primeira casa do usuário). Não há cookie.
- Logout é client-side (descartar o token).

## CORS

Liberado para o front de outro origin. `ALLOWED_ORIGINS` (separado por vírgula) no
`.env` restringe; vazio = `*`. Preflight `OPTIONS` tratado no middleware.

## Endpoints

| Método | Rota | Auth |
|---|---|---|
| GET | `/api/health` | público |
| POST | `/api/auth/register \| login \| set-password` | público |
| GET | `/api/auth/me` | Bearer |
| GET/POST | `/api/groups` (listar / criar casa) | Bearer |
| POST | `/api/groups/join` (entrar por código) | Bearer |
| GET | `/api/groups/active/members` | Bearer + X-Group-Id |
| POST | `/api/groups/active/regenerate-code` (admin) | Bearer + X-Group-Id |
| GET/POST | `/api/expenses` | Bearer + X-Group-Id |
| PUT/DELETE | `/api/expenses/[id]` | Bearer + X-Group-Id |
| POST | `/api/expenses/bulk-delete \| import` | Bearer + X-Group-Id |
| GET | `/api/expenses/export` (CSV) | Bearer + X-Group-Id |
| GET | `/api/balances` | Bearer + X-Group-Id |
| GET/POST | `/api/platforms` · PATCH/DELETE `/api/platforms/[id]` | Bearer + X-Group-Id |
| GET/POST | `/api/shopping-items` · PUT/DELETE `[id]` · PATCH `[id]/toggle` · DELETE `clear-purchased` | Bearer + X-Group-Id |

## Dados

Aponta pro mesmo Neon do app v2 (branch **dev** = cópia de prod). Schema v2 já aplicado.
Dinheiro em centavos inteiros (`lib/currency`); banco em `Decimal(10,2)`.

## Deploy

`prisma db push` (sem `--accept-data-loss`) + `next build`. Aplicar schema manualmente
no banco antes do 1º deploy de cada ambiente (ver app original `DEPLOY-RUNBOOK.md`).
