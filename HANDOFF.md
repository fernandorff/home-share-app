# HANDOFF — La Casa das Bolitas API (para construir o front novo)

Este backend é **headless** (Next.js só com route handlers). O front é um projeto
**totalmente novo**, em qualquer stack (React/Vite, Next, mobile…), que consome esta
API por HTTP com **Bearer token**. Este documento é tudo que você precisa pra construir.

---

## 1. O que o app faz

Controle de **despesas compartilhadas** entre pessoas de uma **casa** (household).
Cada pessoa registra gastos, define quem participou de cada um, e o app calcula
**quem deve quanto pra quem**. Tem também **lista de compras** e **plataformas**
(formas de pagamento: Crédito, PIX, Dinheiro…). Um usuário pode pertencer a várias
casas; cada casa tem membros com papel ADMIN ou MEMBER.

---

## 2. Base URL & como rodar

- Local: `npm install && npm run dev` → `http://localhost:3000`
- Health check (público): `GET /api/health` → `{ "ok": true, "service": "la-casa-das-bolitas-api" }`
- Todas as rotas ficam sob `/api`.

---

## 3. Modelo de dados

```
User        id, publicId(uuid), name, username(único), password?(bcrypt, null=legado)
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
Membros/casas/payer usam o `id` int no corpo das requisições.

---

## 4. Autenticação (Bearer, stateless) — LEIA COM ATENÇÃO

Não há cookies. O fluxo:

1. **Registro ou login** retornam `{ token, user }`. Guarde o `token` (ex: localStorage,
   secure storage no mobile).
2. Em **toda** chamada protegida, envie: `Authorization: Bearer <token>`.
3. A **casa ativa** vai no header `X-Group-Id: <group.id>` (int). Se omitir, o backend
   usa a primeira casa do usuário. Trocar de casa = só mudar esse header.
4. **Logout** é client-side: descarte o token. (Não há endpoint de logout.)
5. Token expira em **30 dias**.

### Fluxo de primeiro acesso (usuários legados)
Existem usuários (Fernando, Tatiana) criados antes da senha existir — `password = null`.
- `POST /api/auth/login` com esse usuário retorna **`{ "requiresPasswordSetup": true }`**
  (sem token, sem erro). 
- O front então mostra "defina sua senha" e chama `POST /api/auth/set-password`
  `{ username, password }` → retorna `{ token, user }`. Pronto, logado.

### Headers padrão
| Header | Quando | Valor |
|---|---|---|
| `Authorization` | toda rota protegida | `Bearer <token>` |
| `X-Group-Id` | rotas com escopo de casa | `<group.id>` (int) |
| `Content-Type` | requests com body | `application/json` |

---

## 5. Formato de erro & status codes

Erros sempre: `{ "error": "mensagem em pt-BR" }` (alguns com `"code"`).

| Status | Significado |
|---|---|
| 200 / 201 | sucesso |
| 400 | input inválido (mensagem explica) |
| 401 | sem token / token inválido (`{ "error": "Não autenticado" }`) |
| 403 | sem permissão / sem casa (`code: "NO_GROUP"` quando o user não tem casa) |
| 404 | recurso não encontrado |
| 409 | conflito (ex: usuário já existe) |
| 500 | erro interno |

> ⚠️ **Decimal serializa como STRING.** `amount` em despesas/participantes vem como
> `"89.90"` (string), não number. Faça `Number(x)` no front. (Os endpoints de
> `balances` já retornam number.)

---

## 6. Referência de endpoints

### Auth (públicas)

**POST `/api/auth/register`** — body `{ name, username, password }`
- `username`: 3-30 chars, `[a-z0-9._-]`, único. `password`: 8-72 chars. `name`: ≤80.
- 201 → `{ token, user: { id, publicId, name } }`
- 409 → `{ error: "Este usuário já existe" }`

**POST `/api/auth/login`** — body `{ username, password }`
- 200 → `{ token, user: { id, publicId, name } }`
- 200 → `{ requiresPasswordSetup: true }` (usuário legado sem senha)
- 401 → `{ error: "Usuário ou senha incorretos" }`

**POST `/api/auth/set-password`** — body `{ username, password }` (só p/ legado sem senha)
- 200 → `{ token, user }` · 400 se já tem senha / inválido

### Sessão (Bearer)

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
Use `X-Group-Id` pra controlar qual `activeGroupId` retorna.

### Casas (Bearer)

**GET `/api/groups`** → `{ groups: [{ id, publicId, name, role, colorIndex }] }`

**POST `/api/groups`** — body `{ name }` (≤80) → cria casa, user vira ADMIN
- 201 → `{ group: { id, publicId, name, joinCode } }` (guarde o `id` p/ X-Group-Id)

**POST `/api/groups/join`** — body `{ code }` (6 chars) → entra na casa
- 200 → `{ group: { id, publicId, name } }` · 404 se código inválido · idempotente

**GET `/api/groups/active/members`** (Bearer + X-Group-Id)
→ `{ members: [{ id, publicId, name, username, role, colorIndex }], groupId }`

**POST `/api/groups/active/regenerate-code`** (Bearer + X-Group-Id, **só ADMIN**)
→ `{ joinCode: "XYZ789" }` · 403 se não for admin

### Despesas (Bearer + X-Group-Id)

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
  exatos; o resto vai pro primeiro). Ignora `participants`.
- `splitEqually: false` → soma de `participants[].amount` deve bater **exatamente** com
  `amount` (senão 400). `payerId` e todo `userId` devem ser membros da casa (senão 400).
- 201 → `{ expense: {...mesmo shape do GET} }`

**PUT `/api/expenses/{publicId}`** — mesmo body do POST → `{ expense }`
**DELETE `/api/expenses/{publicId}`** → `{ message }`
**POST `/api/expenses/bulk-delete`** — body `{ publicIds: ["uuid", ...] }` → `{ message, deleted }`

**POST `/api/expenses/import`** (multipart) — campos: `file` (CSV), `platformId`,
`payerId` (opcional, default = user logado), `splitEqually` ("true"/"false")
- CSV colunas: `description,amount,date,notes` (date/notes opcionais; data DD/MM/YYYY ou YYYY-MM-DD)
- Transacional (tudo-ou-nada). 201 →
  `{ message, created: <n>, invalidRows: [{ line, reason }], totalValue, expenses }`

**GET `/api/expenses/export`** → CSV (text/csv, com `Content-Disposition`), BOM incluso.

### Saldos (Bearer + X-Group-Id)

**GET `/api/balances`**
```json
{
  "balances": [ { "userId": 1, "userName": "Fernando", "balance": 66.67 } ],
  "settlements": [ { "from": {"id":2,"name":"Tatiana"}, "to": {"id":1,"name":"Fernando"}, "amount": 33.34 } ],
  "totalExpenses": 150.00
}
```
`balance` > 0 = tem a receber; < 0 = deve. `settlements` = transferências mínimas pra zerar.

### Plataformas (Bearer + X-Group-Id)

**GET `/api/platforms`** → `{ platforms: [{ id, publicId, name, groupId, createdAt }] }`
- `?counts=true` inclui `_count.expenses` em cada uma.

**POST `/api/platforms`** — `{ name }` → 201 `{ platform }`
**PATCH `/api/platforms/{publicId}`** — `{ name }` → `{ platform }`
**DELETE `/api/platforms/{publicId}`** — `{ replacementId: "<publicId>" }` → move as despesas
pra plataforma substituta e apaga. → `{ message }`

### Lista de compras (Bearer + X-Group-Id)

**GET `/api/shopping-items`** → `{ items: [{ id, publicId, name, isPurchased, createdAt, addedBy: { id, name } | null }] }`
(ordenado: não-comprados primeiro, depois por data desc)

**POST `/api/shopping-items`** — `{ name }` → 201 `{ item }`
**PUT `/api/shopping-items/{publicId}`** — `{ name }` → `{ item }`
**DELETE `/api/shopping-items/{publicId}`** → `{ success: true }`
**PATCH `/api/shopping-items/{publicId}/toggle`** → alterna comprado → `{ item }`
**DELETE `/api/shopping-items/clear-purchased`** → remove os comprados → `{ deleted: <n> }`

---

## 7. Regras de domínio (implemente o front respeitando)

- **Dinheiro**: o backend trabalha em centavos inteiros; divisão igual sempre soma exato.
  No front, exiba `R$ 1.234,56` (pt-BR). Lembre que `amount` vem como string.
- **Cores de membro**: cada membro tem `colorIndex` (0-11). O front mapeia índice → cor
  (paleta livre; sugestão de 12 cores no app antigo). Útil pra colorir por pessoa.
- **Papéis**: só ADMIN vê/regenera o `joinCode` da casa.
- **Validação de despesa custom**: quando não é divisão igual, a soma das partes tem que
  bater com o total — valide no front antes de enviar (o backend rejeita com 400).
- **Datas**: mande `YYYY-MM-DD`. O backend grava ao meio-dia local (evita off-by-one).
- **Multi-casa**: se `GET /api/auth/me` retornar `groups: []`, mande o usuário criar/entrar
  numa casa antes de usar o resto (rotas com X-Group-Id dão 403 `NO_GROUP`).

---

## 8. Telas/fluxos que o front precisa cobrir

1. **Registro** (`name, username, password`) → cria conta → tela criar/entrar casa.
2. **Login** (`username, password`) → trata `requiresPasswordSetup` → tela definir senha.
3. **Criar casa / Entrar com código** (quando `groups` vazio ou por escolha).
4. **Despesas**: lista (tabela + por pessoa), criar/editar/excluir, divisão igual ou custom,
   import/export CSV, seletor de plataforma e pagador.
5. **Saldos**: quem deve quanto pra quem (de `/api/balances`).
6. **Lista de compras**: adicionar, marcar comprado, limpar comprados.
7. **Plataformas**: CRUD, com substituição ao excluir.
8. **Header/menu**: usuário logado, seletor de casa (set `X-Group-Id`), código da casa
   (se ADMIN), sair (descartar token).

---

## 9. CORS & ambiente

- CORS liberado; restrinja com `ALLOWED_ORIGINS` (csv) no `.env` do backend; vazio = `*`.
  Preflight `OPTIONS` é tratado. Headers liberados: `Authorization, Content-Type, X-Group-Id`.
- Env do backend: `DATABASE_URL` (Neon), `JWT_SECRET`, `ALLOWED_ORIGINS`.
- Banco: hoje aponta pro Neon **dev** (cópia dos dados reais de prod) — bom pra desenvolver
  o front sem medo.

---

## 10. Dica de cliente HTTP (front)

Crie um wrapper único que injeta os headers e trata 401:

```ts
const API = "http://localhost:3000"
let token = localStorage.getItem("token")
let groupId = localStorage.getItem("groupId")

async function api(path: string, opts: RequestInit = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(groupId ? { "X-Group-Id": groupId } : {}),
      ...opts.headers,
    },
  })
  if (res.status === 401) { /* limpar token + redirecionar pro login */ }
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
  return data
}
```

Pronto — com isso dá pra construir o front inteiro. Qualquer dúvida de contrato, os
route handlers em `src/app/api/**` e os services em `src/services/**` são a fonte da verdade.
