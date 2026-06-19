# Home Share

Despesas compartilhadas da casa: registre gastos, divida entre os moradores
(**igual**, **por valor** ou **por slider de %**) e veja **quem deve quanto pra quem**.
Tem lista de compras, plataformas de pagamento e suporte a múltiplas casas.

**🔗 Ao vivo:** https://home-share-app-xi.vercel.app

Interface **retro editorial mono** (estética de recibo/extrato): monoespaçada, números
tabulares, regras pontilhadas e um acento "carimbo". Mobile-first, com animações de
entrada escalonadas e skeletons de carregamento (respeitando `prefers-reduced-motion`).

## Funcionalidades

- **Auth** — usuário/senha + **login com Google**, sessão por **cookie httpOnly** (JWT).
  Fluxo de primeiro acesso para usuários legados (definir senha).
- **Casas** — criar / entrar por código de 6 caracteres, papéis ADMIN/MEMBER, trocar de casa.
- **Despesas** — criar/editar/excluir, divisão **igual / por valor / por %** (centavos
  exatos), seleção em massa, **import/export CSV**, ordenação e paginação.
- **Saldos** — quem deve a quem, com as transferências mínimas para zerar.
- **Lista de compras** e **plataformas de pagamento** (com substituição ao excluir).

## Stack

- **Next.js 16** (App Router) + **React 19** — monólito: frontend e API no mesmo app, same-origin
- **Tailwind v4** + Radix primitives · fontes **Space Mono** / **JetBrains Mono**
- **Prisma 7** (`@prisma/adapter-pg`) + **PostgreSQL** (Neon)
- **jose** (JWT) · **bcryptjs** · **Vitest**

## Rodar local

```bash
cp .env.example .env      # preencha DATABASE_URL e JWT_SECRET
npm install
npx prisma db push        # cria o schema no banco
npm run dev               # http://localhost:3000
npm run test              # vitest (currency, balance, csv-parser, auth)
```

### Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|---|---|---|
| `DATABASE_URL` | sim | Postgres (Neon) |
| `JWT_SECRET` | sim em produção | segredo de assinatura da sessão |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | não | habilita o login com Google. Redirect: `<origin>/api/auth/google/callback` |

## Autenticação

Sessão por **cookie httpOnly** (`bolitas_session`, JWT HS256) — o cliente não vê nem
guarda token. A **casa ativa** fica em outro cookie (`bolitas_group`); para trocar,
`POST /api/groups/active`. Por ser same-origin, não há CORS. O login com Google reusa
o mesmo cookie de sessão.

Dinheiro é tratado em **centavos inteiros** (`src/lib/currency`), evitando erro de
ponto flutuante; a divisão sempre soma exatamente o total.

## Estrutura

```
src/
├── app/
│   ├── api/**       # route handlers (auth[+google], groups, expenses, balances, platforms, shopping-items, health)
│   ├── auth/**      # páginas públicas: login, register, set-password
│   └── (app)/**     # área logada: despesas, saldos, compras, plataformas, casa
├── components/      # ui/ (design system retro-mono) · app/ · expenses/ · auth/
├── lib/             # auth, api (client), session, currency, balance, format, members, ...
└── services/        # auth, group, expense, platform, shopping-item
prisma/              # schema + config
```

## Deploy

Hospedado na **Vercel** com banco **Neon** (integração). O build roda
`prisma generate && next build` — o schema é aplicado deliberadamente com
`prisma db push` (não no CI). Dois ambientes: **Production** (branch `main`) e
**Preview** (branches/PRs).

## Explorações de design

A pasta [`design-samples/`](design-samples) guarda 7 direções visuais exploradas antes
de escolher a retro editorial mono (cozy/clay, candy, dark fintech, glassmorphism,
neo-brutalist, bauhaus, retro mono). Abra o `index.html` para comparar.
