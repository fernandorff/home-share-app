# Observabilidade (Sentry)

Como ligar, conferir e desligar o monitoramento do Home Share. Decisão: [ADR 0008](decisions/0008-observability-sentry.md) ·
spec: [007](specs/007-observability-sentry/requirements.md).

## O que é coletado (e o que não é)

- **Erros do servidor** (5xx e exceções inesperadas nas rotas `/api/*`), **erros do navegador** (inclusive a tela
  de erro global) e erros não tratados de páginas e do middleware.
- **Desempenho**: tempo de cada rota (p95), consultas ao banco (Prisma), Web Vitals (LCP, INP, CLS) e sessões sem crash.
- **Nunca**: cookies (`homeshare_session`, `homeshare_group`), cabeçalhos `Authorization`/`Cookie`, corpo das
  requisições, query strings, e-mails, nomes, valores, e IP (este último depende de ligar a opção do projeto no
  passo 2 do checklist). Dos endpoints de push (spec 010) sai só a origem do serviço (`https://fcm.googleapis.com/[Filtered]`):
  o caminho é o token do aparelho. O usuário aparece só como `publicId` (UUID) e a casa como a tag `house=<publicId>`.
- Erros esperados (4xx: não encontrado, validação, sem permissão) **não** viram issue.
- Sem `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` nada é inicializado e nada é enviado: o comportamento do app não
  muda. O código do SDK continua no bundle (inerte), e os logs do servidor passam a sair em linhas JSON com ou sem DSN.

## Checklist do dono (uma vez)

1. **Criar o projeto**: sentry.io → Projects → Create Project → plataforma **Next.js** → nome `home-share`.
   Copie o **DSN** (Settings → Projects → home-share → Client Keys (DSN)).
2. **Privacidade do projeto** (não pule): Settings → Projects → home-share → **Security & Privacy** → ligue
   **Prevent Storing of IP Addresses** e mantenha **Data Scrubber** e **Use Default Scrubbers** ligados.
   O app já remove IPs, tokens, cookies e e-mails antes de enviar qualquer coisa; essas opções do projeto são uma
   segunda barreira (defesa em profundidade), que protege caso algum dado escape do filtro do app.
3. **Token de source maps** (stack traces legíveis): Settings → Developer Settings → **Organization Tokens** →
   Create New Token. Guarde-o só na Vercel (passo 4) — nunca no repositório.
4. **Variáveis na Vercel** (Project → Settings → Environment Variables; marque **Production** e **Preview**):

   | Variável | Valor | Obrigatória? |
   | --- | --- | --- |
   | `SENTRY_DSN` | o DSN | sim (servidor) |
   | `NEXT_PUBLIC_SENTRY_DSN` | o mesmo DSN | sim (navegador) |
   | `SENTRY_ORG` | slug da organização | para source maps |
   | `SENTRY_PROJECT` | `home-share` | para source maps |
   | `SENTRY_AUTH_TOKEN` | token do passo 3 (marque **Sensitive**) | para source maps |
   | `SENTRY_TRACES_SAMPLE_RATE` | ex. `0.1` | não — padrão 0.1 em produção, 1.0 em preview |
   | `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` | ex. `0.1` | não — mesmo padrão, no navegador |

   Confira que **Automatically expose System Environment Variables** está ligado (é o padrão): o ambiente
   (`production`/`preview`) vem de `VERCEL_ENV` / `NEXT_PUBLIC_VERCEL_ENV`.
5. **Redeploy** (Deployments → ⋯ → Redeploy): variáveis `NEXT_PUBLIC_*` só chegam ao navegador num build novo.
6. **Dashboard**: crie um **User Auth Token** (User Settings → Personal Tokens) com os escopos `org:read`,
   `org:write` e `project:read`. No PowerShell, na raiz do repositório:

   ```powershell
   node scripts/sentry-dashboard.mjs --dry-run       # confere o JSON, sem rede e sem token
   $env:SENTRY_AUTH_TOKEN = "<token pessoal>"; $env:SENTRY_ORG = "<org>"; $env:SENTRY_PROJECT = "home-share"
   node scripts/sentry-dashboard.mjs                 # cria ou atualiza "Home Share — System health"
   Remove-Item Env:SENTRY_AUTH_TOKEN
   ```

   O script lê só variáveis exportadas na sessão do terminal — nunca arquivos `.env`. `SENTRY_URL` é opcional
   (padrão `https://sentry.io`). Rodar de novo atualiza o mesmo dashboard: os widgets passam a ser os do JSON.
   Para mudar um widget, edite `docs/observability/sentry-dashboard.json` e rode outra vez.
   **Atenção:** os nomes de campo dos widgets **não foram validados** contra uma conta real do Sentry (o script
   nunca foi executado contra a API). Se algum widget vier vazio ou com erro, ajuste-o no painel (Edit widget) até
   mostrar o dado certo e copie o ajuste para o JSON — senão a próxima execução do script sobrescreve o painel.
7. **Alerta (recomendado)**: Alerts → Create Alert → Issues → "A new issue is created" → e-mail para você.

## Como conferir (depois do deploy)

1. Abra o app com o DevTools → Network: aparecem `POST /monitoring?o=…&p=…` com status 200 (túnel same-origin;
   não deve haver requisição direta para `*.sentry.io`).
2. Sentry → **Explore → Traces**: em alguns minutos surgem spans `GET /api/...` com filhos de banco e spans de
   página com LCP/CLS/INP.
3. Sentry → **Releases**: aparece o commit do deploy, com sessões.
4. Quando surgir uma issue, abra o evento e confira: sem cookies, sem corpo, sem query string, sem e-mail, sem
   IP; `user.id` é um UUID; tags `route`, `http_status`, `request_id`, `house`.
5. Para achar o log de um erro: copie a tag `request_id` do evento e busque nos logs da Vercel (linhas JSON com
   `requestId`, `route`, `status`, `durationMs`, `sentryEventId`).

## Cotas

O plano gratuito tem cota mensal de erros e de spans. Se encher, baixe `SENTRY_TRACES_SAMPLE_RATE` e
`NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` (ex. `0.05`) e faça redeploy.

## Desligar

Remova `SENTRY_DSN` e `NEXT_PUBLIC_SENTRY_DSN` na Vercel e faça redeploy: o SDK não inicializa e o build volta a
ser o de antes. Revogue os tokens no Sentry se não for religar.

## Observações

- No SDK v11, sessões do navegador afetadas por erro não tratado contam como `unhandled` (não `crashed`), então
  o "crash-free" tende a ficar perto de 100% — leia junto com os widgets de erros.
- Se um widget ficar sem dados por mais de um dia com tráfego normal, o nome do campo pode ter mudado no Sentry
  (ou nunca ter batido — veja o aviso do passo 6): ajuste-o no JSON e rode o script de novo (o erro da API, se
  houver, sai no terminal).
- Corpos JSON malformados ainda respondem 500 e vão aparecer como issue (`SyntaxError` em `/api/...`); trocar
  isso por 400 é uma mudança separada.
