# Home Share

🌐 [English](README.md) · **Português** · [Español](README.es.md) · [Français](README.fr.md)

Despesas domésticas compartilhadas: registre gastos, divida entre os moradores
(**igualmente**, **por valor** ou **com um controle de %**) e veja **quem deve a quem**.
Inclui lista de compras, plataformas de pagamento e suporte a múltiplas casas.

**🔗 No ar:** https://homeshare.fernandorffdev.com

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

- Servidor **Rust / Axum** (`server/`) — serve a API JSON (`/api/*`) e o app web, mesma origem
- App web **React 19** compilado pelo **Vite** (fontes em `src/`, rotas via react-router) · i18n com use-intl (EN/PT/ES/FR)
- **Tailwind v4** + primitivas Radix · fontes **Space Mono** / **JetBrains Mono**
- **PostgreSQL** (Neon) — o servidor Rust fala direto com ele (tokio-postgres + deadpool); o **Prisma** fica só como ferramenta de migrations (`prisma/schema.prisma` + `prisma/migrations`)
- Testes: **Vitest** (app web) · `cargo test` (servidor)

A versão antiga em Next.js agora fica em https://github.com/fernandorff/home-share-next.

## Rodar localmente

```bash
npm run db:up                 # Postgres 16 local (Docker, localhost:5433)
cp .env.example .env.local    # lido por `npm run db:migrate`
npm install
npm run db:migrate            # aplica prisma/migrations
# terminal 1 — o servidor Rust (lê as variáveis de ambiente do shell, não de um arquivo):
cd server && DATABASE_URL=postgresql://postgres:postgres@localhost:5433/homeshare_dev JWT_SECRET=dev-secret cargo run   # http://localhost:8080
# terminal 2 — o app web com hot reload; /api vai para o servidor Rust:
npm run dev                   # http://localhost:5173
```

Gates (os mesmos que o CI roda): `npx tsc --noEmit` · `npm run lint` · `npm run test` · `npm run build` · `cargo test --manifest-path server/Cargo.toml`.

Mudanças de schema: edite `prisma/schema.prisma`, rode `npx prisma migrate dev --name <change>`
no banco local e faça commit da nova pasta em `prisma/migrations` — o CI falha quando o
schema muda sem uma migration. As migrations devem ser aditivas. `npm run db:reset` recria
o banco local e reaplica todas as migrations.

### Variáveis de ambiente

Lidas pelo servidor a partir do ambiente (veja `.env.example`).

| Variável | Obrigatória | Descrição |
|---|---|---|
| `DATABASE_URL` | sim | Postgres (Neon) |
| `JWT_SECRET` | sim | segredo de assinatura da sessão |
| `APP_ENV` | não | `production` é o único deploy que os buscadores podem indexar |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | não | habilita o login com Google. Redirect: `<origin>/api/auth/google/callback` |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | não | Web Push: defina as três ou nenhuma |
| `SENTRY_DSN` | não | relatório de erros |

O app web também recebe `NEXT_PUBLIC_VAPID_PUBLIC_KEY` e `VITE_SENTRY_*` em tempo de build (Docker `--build-arg`).

## Autenticação

Sessão via **cookie httpOnly** (`homeshare_session`, JWT HS256) — o cliente nunca vê
nem armazena um token. A **casa ativa** fica em um cookie separado (`homeshare_group`);
para trocar, `POST /api/groups/active`. Por ser de mesma origem, não há CORS. O login
com Google reutiliza o mesmo cookie de sessão.

O dinheiro é tratado em **centavos inteiros** para evitar desvios de ponto flutuante;
as divisões sempre somam exatamente o total.

## Estrutura

```
server/              # servidor Rust (Axum)
├── src/main.rs      # rotas e camadas
├── src/routes/      # um arquivo por grupo de rotas
└── src/             # auth.rs, house.rs, money.rs, db.rs, config.rs
src/                 # app web
├── vite/            # entrada (main.tsx) e rotas (routes.tsx)
├── app/auth/**      # páginas públicas: login, register, set-password
├── app/(app)/**     # área logada: expenses, balances, shopping, catalogs, activity, house, settings, notifications, recurring
├── components/
├── lib/
└── messages/        # i18n (EN/PT/ES/FR)
prisma/              # schema + migrations
Dockerfile           # uma imagem: binário Rust + build do Vite
fly.toml
```

## Deploy

A produção roda na **Fly.io** (app `home-share`, São Paulo), com um banco **Neon** em
São Paulo e a **Cloudflare** na frente, em https://homeshare.fernandorffdev.com. Não há
ambiente de staging.

Uma única branch, `main`. Trabalhe em uma branch curta → PR para `main` (o `ci` do GitHub
Actions roda os gates) → merge = deploy: o job `deploy` aplica as migrations pendentes no
banco de produção (`prisma migrate deploy`), roda `flyctl deploy --remote-only` e depois
confere `https://homeshare.fernandorffdev.com/api/health?db=1`.

Não há ping de keep-warm: no plano Free do Neon o compute dorme após 5 minutos parado, e mantê-lo acordado o mês todo passaria das 100 CU-horas do plano. A primeira requisição depois de uma pausa leva cerca de um segundo a mais.
