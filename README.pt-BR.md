# Home Share

🌐 [English](README.md) · **Português** · [Español](README.es.md) · [Français](README.fr.md)

Despesas domésticas compartilhadas: registre gastos, divida entre os moradores
(**igualmente**, **por valor** ou **com um controle de %**) e veja **quem deve a quem**.
Inclui lista de compras, plataformas de pagamento e suporte a múltiplas casas.

**🔗 No ar:** https://home-share-app-xi.vercel.app

Uma interface **retrô editorial mono** (estética de recibo/livro-caixa): monoespaçada, números
tabulares, linhas pontilhadas e um único toque de "carimbo". Mobile-first, com animações de
entrada escalonadas e esqueletos de carregamento (respeitando `prefers-reduced-motion`).

## Funcionalidades

- **Autenticação** — usuário/senha + **login com Google**, sessão via **cookie httpOnly**
  (JWT). Fluxo de primeiro acesso para usuários legados (definir senha).
- **Casas** — criar / entrar com um código de 6 caracteres, papéis ADMIN/MEMBER, trocar de casa.
- **Despesas** — criar/editar/excluir, dividir **igualmente / por valor / por %** (centavos exatos),
  seleção em massa, **importação/exportação CSV**, ordenação e paginação.
- **Saldos** — quem deve a quem, com o conjunto mínimo de transferências para acertar as contas.
- **Lista de compras** e **plataformas de pagamento** (com reatribuição ao excluir).

## Stack

- **Next.js 16** (App Router) + **React 19** — monolito: frontend e API em um único app, mesma origem
- **Tailwind v4** + primitivas Radix · fontes **Space Mono** / **JetBrains Mono**
- **Prisma 7** (`@prisma/adapter-pg`) + **PostgreSQL** (Neon)
- **jose** (JWT) · **bcryptjs** · **Vitest**

## Rodar localmente

```bash
docker compose up -d          # local Postgres 16 (container homeshare-dev-pg, localhost:5433)
cp .env.example .env.local    # DATABASE_URL already points at it; set JWT_SECRET
npm install
npm run db:migrate            # apply prisma/migrations (prisma migrate deploy)
npm run dev                   # http://localhost:3000
npm run test                  # vitest (self-contained: in-process Postgres, no Docker needed)
```

O `.env.local` aponta apenas para o banco local. As URLs do banco de produção e de staging
ficam somente na Vercel, nunca em um arquivo local — apague (ou esvazie) qualquer `.env`
antigo: o Next.js e a CLI do Prisma o leem para tudo que o `.env.local` não define.

Mudanças de schema: edite `prisma/schema.prisma`, rode `npx prisma migrate dev --name <change>`
no banco local e faça commit da nova pasta em `prisma/migrations` — o CI falha quando o
schema muda sem uma migration. `npm run db:reset` recria o banco local e reaplica todas
as migrations.

### Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|---|---|---|
| `DATABASE_URL` | sim | Postgres (Neon) |
| `JWT_SECRET` | sim em produção | segredo de assinatura da sessão |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | não | habilita o login com Google. Redirect: `<origin>/api/auth/google/callback` |

## Autenticação

Sessão via **cookie httpOnly** (`bolitas_session`, JWT HS256) — o cliente nunca vê
nem armazena um token. A **casa ativa** fica em um cookie separado (`bolitas_group`);
para trocar, `POST /api/groups/active`. Por ser de mesma origem, não há CORS. O login
com Google reutiliza o mesmo cookie de sessão.

O dinheiro é tratado em **centavos inteiros** (`src/lib/currency`) para evitar
desvios de ponto flutuante; as divisões sempre somam exatamente o total.

## Estrutura

```
src/
├── app/
│   ├── api/**       # route handlers (auth[+google], groups, expenses, balances, platforms, shopping-items, health)
│   ├── auth/**      # public pages: login, register, set-password
│   └── (app)/**     # logged-in area: expenses, balances, shopping, platforms, household
├── components/      # ui/ (retro-mono design system) · app/ · expenses/ · auth/
├── lib/             # auth, api (client), session, currency, balance, format, members, ...
└── services/        # auth, group, expense, platform, shopping-item
prisma/              # schema + config
```

## Deploy

Hospedado na **Vercel** com um banco **Neon**. Dois ambientes, um projeto na Vercel:

- **Production** — branch `main`, branch principal do Neon.
- **Staging** — branch `dev`, em https://dev.homeshare.fernandorffdev.com (variáveis de
  ambiente de Preview da Vercel com escopo na `dev`), com seu próprio branch `dev` no Neon
  (uma cópia da produção, resetada sob demanda).

Apenas `main` e `dev` fazem deploy (`scripts/vercel-ignore-build.mjs`, o `ignoreCommand` em
`vercel.json`); as demais branches rodam somente o CI do GitHub. Fluxo: branch de feature →
PR para `dev` (o merge atualiza o staging) → testar no staging → PR `dev` → `main`.

- **Build** — `prisma generate && next build`; nunca toca em um banco de dados.
- **Schema** — SQL versionado em `prisma/migrations`, aplicado manualmente com
  `prisma migrate deploy`, **primeiro o staging, depois a produção**. Passe a URL do destino
  (a string direta do Neon, sem `-pooler`) no shell apenas para aquele comando, nunca em um
  arquivo: `DATABASE_URL="<url>" npm run db:migrate` (`npm run db:migrate:status` para conferir).
- **Crons** (`vercel.json`) rodam apenas em Production. No staging, chame-os manualmente com
  o `CRON_SECRET` do staging:
  `curl -H "Authorization: Bearer $CRON_SECRET" https://dev.homeshare.fernandorffdev.com/api/cron/recurring-expenses`
  (o mesmo vale para `/api/cron/notifications`).
- Todo ambiente que não é de produção responde `X-Robots-Tag: noindex, nofollow`.

## Explorações de design

A pasta [`design-samples/`](design-samples) reúne 7 direções visuais exploradas
antes de optar pelo retrô editorial mono (cozy/clay, candy, dark fintech, glassmorphism,
neo-brutalist, bauhaus, retro mono). Abra `index.html` para comparar.
