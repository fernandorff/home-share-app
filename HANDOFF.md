# HANDOFF — Home Share (referência de arquitetura & API)

Este repo é um **monolito Next.js 16 (App Router)**: o **frontend e a API vivem no
mesmo app**, mesma origem (same-origin). O front já existe aqui dentro — não é um
projeto separado a construir. Este documento é uma **referência de arquitetura e
contrato da API**, útil pra entender o sistema, manter as rotas ou escrever um cliente.

> O front mora em `src/app/(app)/**` (despesas, saldos, compras, plataformas, casa) +
> `src/app/auth/**` (login, register, set-password), com um design system retrô
> editorial mono em `src/components/ui/**`. Ele consome a própria API por `fetch`
> same-origin; os cookies de sessão viajam automaticamente.

---

## 1. O que o app faz

Controle de **despesas compartilhadas** entre pessoas de uma **casa** (household).
Cada pessoa registra gastos, define quem participou de cada um, e o app calcula
**quem deve quanto pra quem**. Tem também **lista de compras** e **plataformas**
(formas de pagamento: Crédito, PIX, Dinheiro…). Um usuário pode pertencer a várias
casas; cada casa tem membros com papel ADMIN ou MEMBER.

---

## 2. Como rodar

- Local: `npm install && npm run dev` → `http://localhost:3000` (front + API juntos).
- Health check (público): `GET /api/health` → `{ "ok": true, "service": "home-share" }`
- Todas as rotas de API ficam sob `/api`. As páginas do front ficam fora de `/api`.

---

## 3. Modelo de dados

```
User        id, publicId(uuid), name, username(único), password?(bcrypt, null=legado),
            email?(único, null), googleId?(único, null)
Group       id, publicId, name, description?, joinCode?(único, 6 chars)
GroupMember userId+groupId(único), role(ADMIN|MEMBER), colorIndex(0-11)
Platform    id, publicId, name, groupId           (escopada por casa)
Expense     id, publicId, groupId, payerId, platformId?, description, notes?,
            amount(Decimal 10,2), date
ExpenseParticipant  expenseId+userId(único), amount(Decimal 10,2)
ShoppingItem id, publicId, groupId, name, isPurchased, addedById?
```

Relações: User 1—N GroupMember N—1 Group · Expense N—1 payer(User) · Expense 1—N
ExpenseParticipant N—1 User · Expense N—1 Platform? · ShoppingItem N—1 Group.

**IDs:** toda entidade tem `id` (int interno) e `publicId` (uuid). As rotas que
recebem id na URL usam **publicId** (uuid) para expense/platform/shopping-item.
Membro/pagador/participante usam o `id` int no corpo das requisições.

**Colunas de login social:** `email` e `googleId` (ambos nullable e únicos) ligam a
conta a um login Google. Usuários por usuário+senha não preenchem `googleId`.

---

## 4. Autenticação (cookie httpOnly) — LEIA COM ATENÇÃO

Não há Bearer token nem header `Authorization`. A sessão é um **cookie httpOnly**
assinado (JWT HS256 via `jose`). Por ser same-origin, o front nem manipula o token: o
browser anexa o cookie sozinho.

1. **Registro / login / set-password** **setam o cookie `bolitas_session`** e retornam
   apenas `{ user }` (sem token no corpo).
2. A **casa ativa** é outro cookie httpOnly: **`bolitas_group`**. Trocar de casa é
   `POST /api/groups/active { groupId }` (valida que você é membro antes de gravar).
   O cookie é só preferência de UI — **toda request revalida a participação no banco**.
3. **Logout EXISTE**: `POST /api/auth/logout` limpa os dois cookies. Não é client-side.
4. O cookie de sessão expira em **30 dias**.

Não existe header `X-Group-Id` em lugar nenhum: a casa ativa vem do cookie.

### Login com Google (OAuth)
- `GET /api/auth/google` — redireciona pro consent do Google (grava cookie de `state`).
- `GET /api/auth/google/callback` — valida `state`, troca o code pelo perfil,
  faz **find-or-create** do usuário (por `googleId`/`email`) e seta o mesmo cookie
  `bolitas_session`, redirecionando pra `/`.
- Protegido por env `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. Sem essas variáveis,
  o botão volta pra `/auth/login?error=google_indisponivel` (mensagem amigável).

### Primeiro acesso (usuários legados)
Existem usuários criados antes da senha existir — `password = null`.
- `POST /api/auth/login` com esse usuário retorna **`{ requiresPasswordSetup: true }`**
  (sem cookie, sem erro).
- O front mostra "defina sua senha" e chama `POST /api/auth/set-password`
  `{ username, password }` → seta o cookie e retorna `{ user }`. Pronto, logado.

### Gate de autenticação (middleware)
O `middleware.ts` (matcher amplo) protege páginas e API ao mesmo tempo:
- Públicas: páginas sob `/auth` e APIs sob `/api/auth` e `/api/health`.
- Sem cookie válido → API responde `401 { error: "Não autenticado" }`; página
  redireciona pra `/auth/login`.

### Cliente de origem diferente (NÃO suportado hoje)
Como é monolito same-origin, **não há CORS no código** e o cookie é `SameSite=Lax`.
Um cliente em outra origem (app separado, mobile com webview cross-site) **não
funcionaria** sem adicionar CORS + trocar o cookie pra `SameSite=None; Secure` — isso
**não existe** atualmente.

---

## 5. Formato de erro & status codes

Erros sempre: `{ "error": "mensagem em pt-BR" }` (alguns com `"code"`).

| Status | Significado |
|---|---|
| 200 / 201 | sucesso |
| 400 | input inválido (mensagem explica) |
| 401 | sem sessão / cookie inválido (`{ "error": "Não autenticado" }`) |
| 403 | sem permissão / sem casa (`code: "NO_GROUP"` quando o user não tem casa) |
| 404 | recurso não encontrado |
| 409 | conflito (ex: usuário já existe) |
| 500 | erro interno |

> ⚠️ **Decimal serializa como STRING.** `amount` em despesas/participantes vem como
> `"89.90"` (string), não number. Faça `Number(x)` no front. (Os endpoints de
> `balances` já retornam number.)

---

## 6. Referência de endpoints

Todas sob `/api`. **Auth e health são públicas**; o resto exige o cookie de sessão.
As rotas com escopo de casa exigem **casa ativa** (senão `403 code: "NO_GROUP"`).

### Auth (públicas)

**POST `/api/auth/register`** — body `{ name, username, password }`
- `username`: 3-30 chars, `[a-z0-9._-]`, único. `password`: 8-72 chars. `name`: ≤80.
- 201 → `{ user: { id, publicId, name } }` + seta cookie `bolitas_session`
- 409 → `{ error: "Este usuário já existe" }`

**POST `/api/auth/login`** — body `{ username, password }`
- 200 → `{ user: { id, publicId, name } }` + seta cookie `bolitas_session`
- 200 → `{ requiresPasswordSetup: true }` (usuário legado sem senha)
- 401 → `{ error: "Usuário ou senha incorretos" }`

**POST `/api/auth/set-password`** — body `{ username, password }` (só p/ legado sem senha)
- 200 → `{ user }` + seta cookie · 400 se já tem senha / inválido

**GET `/api/auth/google`** — redireciona pro Google (ou pra `/auth/login` se sem env).

**GET `/api/auth/google/callback`** — find-or-create + seta cookie → redireciona pra `/`.

### Sessão (cookie)

**GET `/api/auth/me`** → dados do usuário + casas
```json
{
  "user": {
    "id": 1, "publicId": "...", "name": "Fernando", "username": "fernando",
    "groups": [
      { "id": 1, "publicId": "...", "name": "Casa", "role": "ADMIN",
        "colorIndex": 0, "joinCode": "ABC123" }
    ]
  },
  "activeGroupId": 1
}
```
`joinCode` só vem preenchido se o user for ADMIN daquela casa (senão `null`).
`activeGroupId` reflete o cookie `bolitas_group` (ou a primeira casa, como fallback).

**POST `/api/auth/logout`** → `{ ok: true }` + limpa os cookies `bolitas_session` e `bolitas_group`.

### Casas (cookie)

**GET `/api/groups`** → `{ groups: [{ id, publicId, name, role, colorIndex }] }`

**POST `/api/groups`** — body `{ name }` (≤80) → cria casa, user vira ADMIN
- 201 → `{ group: { id, publicId, name, joinCode } }`

**POST `/api/groups/join`** — body `{ code }` (6 chars) → entra na casa
- 200 → `{ group: { id, publicId, name } }` · 404 se código inválido · idempotente

**POST `/api/groups/active`** — body `{ groupId }` (int) → troca a casa ativa
- 200 → `{ ok: true, groupId }` + seta cookie `bolitas_group` · 403 se não for membro

**GET `/api/groups/active/members`**
→ `{ members: [{ id, publicId, name, username, role, colorIndex }], groupId }`

**POST `/api/groups/active/regenerate-code`** (**só ADMIN**)
→ `{ joinCode: "XYZ789" }` · 403 se não for admin

### Despesas (escopo de casa)

**GET `/api/expenses?page=1&pageSize=10&sortField=date&sortDirection=desc`**
- `sortField` ∈ `date | amount | description | payer | platformId | createdAt` (400 se outro)
- `sortDirection` ∈ `asc | desc`
```json
{
  "expenses": [{
    "id", "publicId", "groupId", "payerId", "platformId", "description",
    "notes", "amount": "89.90", "date", "createdAt", "updatedAt",
    "payer":    { "id", "publicId", "name", "username" },
    "platform": { "id", "publicId", "name" },
    "participants": [
      { "id", "expenseId", "userId", "amount": "29.97",
        "user": { "id", "publicId", "name", "username" } }
    ]
  }],
  "pagination": { "page", "pageSize", "total", "totalPages" }
}
```

**POST `/api/expenses`** — body:
```json
{
  "payerId": 1,
  "platformId": 2,            // opcional (null = sem plataforma)
  "description": "Mercado",   // 1-200 chars
  "notes": "...",             // opcional, ≤1000
  "amount": 150.00,           // > 0
  "date": "2026-06-01",       // opcional (YYYY-MM-DD); default hoje
  "splitEqually": true,       // default true
  "participants": [           // usado só quando splitEqually=false
    { "userId": 1, "amount": 75.00 },
    { "userId": 2, "amount": 75.00 }
  ]
}
```
- `splitEqually: true` → backend divide igual entre TODOS os membros da casa (centavos
  exatos; o resto é distribuído 1 centavo por vez a partir da primeira parte). Ignora `participants`.
- `splitEqually: false` → soma de `participants[].amount` (em centavos) deve bater
  **exatamente** com `amount` (senão 400). `payerId` e todo `userId` devem ser membros
  da casa (senão 400).
- 201 → `{ expense: {...mesmo shape do GET} }`

**PUT `/api/expenses/{publicId}`** — mesmo body do POST → `{ expense }`
**DELETE `/api/expenses/{publicId}`** → `{ message }`
**POST `/api/expenses/bulk-delete`** — body `{ publicIds: ["uuid", ...] }` → `{ message, deleted }`

**POST `/api/expenses/import`** (multipart) — campos: `file` (CSV), `platformId`
(obrigatório), `payerId` (opcional, default = user logado), `splitEqually` ("true"/"false")
- CSV colunas: `description,amount,date,notes` (date/notes opcionais; data DD/MM/YYYY ou YYYY-MM-DD)
- Limites: ≤1000 linhas / ≤1MB. Transacional (tudo-ou-nada). 201 →
  `{ message, created: <n>, invalidRows: [{ line, reason }], totalValue, expenses }`

**GET `/api/expenses/export`** → CSV (text/csv, com `Content-Disposition`), BOM incluso,
datas formatadas em UTC.

### Saldos (escopo de casa)

**GET `/api/balances`**
```json
{
  "balances": [ { "userId": 1, "userName": "Fernando", "balance": 66.67 } ],
  "settlements": [ { "from": {"id":2,"name":"Tatiana"}, "to": {"id":1,"name":"Fernando"}, "amount": 33.34 } ],
  "totalExpenses": 150.00
}
```
`balance` > 0 = tem a receber; < 0 = deve. `settlements` = transferências mínimas pra zerar.
(Aqui os valores são **number**, não string.)

### Plataformas (escopo de casa)

**GET `/api/platforms`** → `{ platforms: [{ id, publicId, name, groupId, createdAt }] }`
- `?counts=true` inclui `_count.expenses` em cada uma.

**POST `/api/platforms`** — `{ name }` → 201 `{ platform }`
**PATCH `/api/platforms/{publicId}`** — `{ name }` → `{ platform }`
**DELETE `/api/platforms/{publicId}`** — `{ replacementId: "<publicId>" }` → move as despesas
pra plataforma substituta e apaga. → `{ message }`

### Lista de compras (escopo de casa)

**GET `/api/shopping-items`** → `{ items: [{ id, publicId, name, isPurchased, createdAt, addedBy: { id, name } | null }] }`
(ordenado: não-comprados primeiro, depois por data desc)

**POST `/api/shopping-items`** — `{ name }` → 201 `{ item }`
**PUT `/api/shopping-items/{publicId}`** — `{ name }` → `{ item }`
**DELETE `/api/shopping-items/{publicId}`** → `{ success: true }`
**PATCH `/api/shopping-items/{publicId}/toggle`** → alterna comprado → `{ item }`
**DELETE `/api/shopping-items/clear-purchased`** → remove os comprados → `{ deleted: <n> }`

---

## 7. Regras de domínio

- **Dinheiro**: tudo em centavos inteiros internamente (`lib/currency`: toCents /
  fromCents / splitCents); banco em `Decimal(10,2)`. Divisão igual distribui o resto
  1 centavo por vez a partir da primeira parte; divisão custom precisa somar **exato**
  ao total (em centavos). Comparações são exatas, sem epsilon.
- **Limites de input**: descrição ≤200, notas ≤1000, CSV ≤1000 linhas / 1MB.
- **Código de convite**: 6 chars do alfabeto `ABCDEFGHJKMNPQRSTUVWXYZ23456789`
  (sem 0/O/1/I/L). Só ADMIN vê/regenera o `joinCode` da casa.
- **Papéis**: ADMIN / MEMBER. `colorIndex` do membro vai de 0 a 11 (mapeia índice → cor).
- **Datas**: mande `YYYY-MM-DD`. O backend grava ao meio-dia local (`T12:00`, evita
  off-by-one) e formata em UTC no export.
- **IDs nas URLs**: rotas de entidade usam `publicId` (UUID); membro/pagador/participante
  usam o `id` numérico no body.
- **`groupId` nunca vem do body** — sempre da casa ativa (cookie). Se `GET /api/auth/me`
  retornar `groups: []`, o user precisa criar/entrar numa casa antes de usar rotas com
  escopo de casa (elas dão `403 code: "NO_GROUP"`).

---

## 8. Telas/fluxos cobertos pelo front

1. **Registro** (`name, username, password`) e **Login** (`username, password`), com
   Google como opção. Login trata `requiresPasswordSetup` → tela definir senha.
2. **Criar casa / Entrar com código** (quando `groups` vazio ou por escolha).
3. **Despesas**: lista (tabela + por pessoa), criar/editar/excluir, divisão igual ou
   custom, import/export CSV, seletor de plataforma e pagador.
4. **Saldos**: quem deve quanto pra quem (de `/api/balances`).
5. **Lista de compras**: adicionar, marcar comprado, limpar comprados.
6. **Plataformas**: CRUD, com substituição ao excluir.
7. **Casa / header**: usuário logado, seletor de casa (`POST /api/groups/active`),
   código da casa (se ADMIN), sair (`POST /api/auth/logout`).

---

## 9. Ambiente

- **Env**: `DATABASE_URL` (Neon), `JWT_SECRET`, `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`. Existe `ALLOWED_ORIGINS` no env, mas hoje está **sem uso**
  (não há CORS no código).
- **Build**: `npm run build` = `prisma db push && prisma generate && next build`
  (sem `--accept-data-loss`). `npm run test` (vitest) é gate obrigatório.
- **Banco**: aponta pro Neon **dev** (cópia dos dados reais de prod) — bom pra
  desenvolver sem medo.

---

## 10. Onde está a fonte da verdade

- **Auth/cookies/CORS**: `src/lib/auth.ts`, `src/lib/api-helpers.ts`, `src/middleware.ts`.
- **Route handlers**: `src/app/api/**` (finos: validam, chamam service, respondem).
- **Lógica de negócio**: `src/services/**` (singletons agnósticos de framework).
- **Helpers**: `src/lib/**` (currency, balance, csv-parser, join-code, date, etc.).
- **Front**: `src/app/(app)/**` + `src/app/auth/**`; design system em `src/components/ui/**`.

Qualquer dúvida de contrato, esses arquivos mandam.
