# Claude Code Preferences

## Response Format
- Mostrar skills ativas no início: `**Skills ativas:** skill-name`

## Projeto

Backend **headless** do La Casa das Bolitas (despesas compartilhadas). O front é
outro projeto que consome via HTTP. Este repo é **só API** — não tem páginas/UI.

- **Código**: inglês (vars, props, comentários). **Mensagens de erro**: pt-BR.
- **Auth**: Bearer token (JWT/jose) no header `Authorization`. Sem cookies.
  Casa ativa via header `X-Group-Id`. Helpers em `lib/api-helpers` (`requireSession`,
  `requireActiveGroup`, `allGroupMembers`). `groupId` NUNCA vem do body.
- **Dinheiro**: centavos inteiros (`lib/currency`: toCents/fromCents/splitCents);
  banco em `Decimal(10,2)`. Comparações exatas, sem epsilon.
- **CORS**: middleware trata preflight + headers; `ALLOWED_ORIGINS` no env.

## Estrutura

```
src/
├── app/api/**        # route handlers (auth, groups, expenses, balances, platforms, shopping-items, health)
├── lib/              # auth, api-helpers, currency, balance, csv-parser, join-code, prisma, date, uuid, constants
├── services/         # auth, group, expense, platform, shopping-item (class singletons)
└── middleware.ts     # gate Bearer + CORS (matcher /api/:path*)
prisma/               # schema v2, backfill-v2, prisma.config
```

## Convenções
- Services agnósticos de framework; route handlers finos (validam, chamam service, respondem).
- Validações de input nas rotas (limites: descrição 200, notas 1000, CSV 1000 linhas/1MB).
- `npm run test` (vitest) é gate obrigatório. `npm run build` = `prisma db push && prisma generate && next build` (SEM `--accept-data-loss`).
- Datas: convenção `T12:00:00` local na escrita; formata em UTC no export.
