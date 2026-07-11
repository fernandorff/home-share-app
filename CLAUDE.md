# Claude Code Preferences

## Response Format
- Mostrar skills ativas no início: `**Skills ativas:** skill-name`

## Projeto

**Home Share** (ex-"La Casa das Bolitas") — app de **despesas compartilhadas** de uma casa.
**Monólito Next.js** (App Router): o frontend e a API vivem no mesmo app, **same-origin**.

- **Código**: inglês (vars, props, comentários). **Mensagens de erro / UI**: pt-BR.
- **Auth**: **cookie httpOnly** `bolitas_session` (JWT HS256, jose) — **NÃO** Bearer. Login/
  register/set-password setam o cookie e retornam só `{ user }` (token vai no cookie).
  Existe `POST /api/auth/logout`. **Login com Google** (OAuth) em `/api/auth/google[/callback]`,
  guarded por `GOOGLE_CLIENT_ID/SECRET` (reusa `signSession` + mesmo cookie).
- **Casa ativa**: cookie httpOnly `bolitas_group` (preferência; a membership no banco é a
  autoridade). Trocar de casa = `POST /api/groups/active` `{ groupId }`. **Sem header X-Group-Id.**
  Helpers em `lib/api-helpers` (`requireSession`, `requireActiveGroup`, `allGroupMembers`).
  `groupId` NUNCA vem do body.
- **Dinheiro**: centavos inteiros (`lib/currency`: toCents/fromCents/splitCents);
  banco em `Decimal(10,2)` → `amount`/`participant.amount` serializam como **string** no JSON
  (balances vêm como number). Comparações exatas, sem epsilon.
- **Same-origin**: sem CORS no código. O front usa o wrapper `lib/api` (cookies automáticos).

## Estrutura

```
src/
├── app/
│   ├── api/**            # route handlers (auth[+google], groups, expenses, balances, platforms, shopping-items, health)
│   ├── auth/**           # páginas públicas (login, register, set-password)
│   ├── (app)/**          # área logada (despesas, saldos, compras, plataformas, casa) + layout/shell
│   ├── layout.tsx, page.tsx, globals.css, icon.svg
├── components/
│   ├── ui/               # design system retro-mono (Button, Field, Card, Money, Modal, Menu, Toast, Skeleton, …)
│   ├── app/              # AppChrome (header/nav) + Onboarding
│   └── auth/, expenses/  # GoogleButton, ExpenseFormModal, ImportCsvModal
├── lib/                  # auth, api-helpers, api (client), session, format, members, motion, currency, balance, csv-parser, join-code, prisma, …
├── services/             # auth, group, expense, platform, shopping-item (class singletons)
└── middleware.ts         # gate de sessão por COOKIE (libera /auth/* e /api/auth/*, /api/health)
prisma/                   # schema (User tem email/googleId p/ Google), prisma.config
```

## Convenções
- Services agnósticos de framework; route handlers finos (validam, chamam service, respondem).
- UI retro editorial mono: monoespaçado, `tabular-nums`, regras pontilhadas, 1 acento "stamp".
  Mobile-first; animações de entrada (`reveal`/`revealDelay`) + skeletons, atrás de `prefers-reduced-motion`.
- Validações de input nas rotas (limites: descrição 200, notas 1000, CSV 1000 linhas/1MB).
- `npm run test` (vitest) é gate. `npm run build` = `prisma db push && prisma generate && next build` (SEM `--accept-data-loss`).
- Datas: convenção `T12:00:00` local na escrita; formata em UTC no export.
- **Porquês de arquitetura** (auth, casa ativa, dinheiro — com alternativas rejeitadas):
  `docs/decisions/` (ADRs, MADR, append-only). Consultar antes de mexer nessas áreas.
