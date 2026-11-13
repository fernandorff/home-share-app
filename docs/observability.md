# Observabilidade (Sentry)

Como ligar, conferir e desligar o monitoramento do Home Share. Decisão: [ADR 0008](decisions/0008-observability-sentry.md) ·
spec: [007](specs/007-observability-sentry/requirements.md).

## O que é coletado (e o que não é)

- **Erros do servidor** (5xx e exceções inesperadas nas rotas `/api/*`; o servidor Rust envia só erros, sem traces) e
  **erros do navegador** (inclusive a tela de erro global).
- **Desempenho** (só do navegador): carga e navegação das páginas, chamadas `/api/*` vistas pelo navegador, Web Vitals
  (LCP, INP, CLS) e sessões sem crash.
- **Nunca**: cookies (`homeshare_session`, `homeshare_group`), cabeçalhos `Authorization`/`Cookie`, corpo das
  requisições, query strings, e-mails, nomes, valores, e IP (este último depende de ligar a opção do projeto no
  passo 2 do checklist). Dos endpoints de push (spec 010) sai só a origem do serviço (`https://fcm.googleapis.com/[Filtered]`):
  o caminho é o token do aparelho. O usuário aparece só como `publicId` (UUID) e a casa como a tag `house=<publicId>`.
- Erros esperados (4xx: não encontrado, validação, sem permissão) **não** viram issue.
- Sem `SENTRY_DSN` / `VITE_SENTRY_DSN` nada é inicializado e nada é enviado: o comportamento do app não
  muda. O código do SDK continua no bundle (inerte), e os logs do servidor passam a sair em linhas JSON com ou sem DSN.

## Checklist do dono (uma vez)

1. **Criar o projeto**: sentry.io → Projects → Create Project → plataforma **React** → nome `home-share`.
   Copie o **DSN** (Settings → Projects → home-share → Client Keys (DSN)). Feito em 2026-11-12: organização
   `home-share-3x` (dados nos EUA), projeto `home-share`.
2. **Privacidade do projeto** (não pule): Settings → Projects → home-share → **Security & Privacy** → ligue
   **Prevent Storing of IP Addresses** e mantenha **Data Scrubber** e **Use Default Scrubbers** ligados.
   O app já remove IPs, tokens, cookies e e-mails antes de enviar qualquer coisa; essas opções do projeto são uma
   segunda barreira (defesa em profundidade), que protege caso algum dado escape do filtro do app.
3. **Token de source maps** (stack traces legíveis): Settings → Developer Settings → **Organization Tokens** →
   Create New Token. Guarde-o só fora do repositório — nunca em arquivo versionado.
4. **Variáveis**. O servidor Rust lê as suas em tempo de execução (segredos da Fly: `fly secrets set ...`). As do
   navegador entram na build do Vite (variáveis do repositório no GitHub, que o deploy passa como `--build-arg`):

   | Variável | Onde | Valor | Obrigatória? |
   | --- | --- | --- | --- |
   | `SENTRY_DSN` | segredo da Fly | o DSN | sim (servidor) |
   | `SENTRY_ENVIRONMENT` | segredo da Fly | `production` | não — padrão `development` |
   | `SENTRY_RELEASE` | segredo da Fly | ex. o commit | não |
   | `VITE_SENTRY_DSN` | variável do GitHub | o mesmo DSN | sim (navegador) |
   | `VITE_SENTRY_ENVIRONMENT` | variável do GitHub | `production` | não — padrão o modo da build |
   | `VITE_SENTRY_TRACES_SAMPLE_RATE` | variável do GitHub | ex. `0.1` | não |
5. **Redeploy**: variáveis `VITE_*` só chegam ao navegador numa build nova (um push na `main` ou rodar o workflow
   de deploy de novo).
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
2. Sentry → **Explore → Traces**: em alguns minutos surgem traces de página (pageload/navigation) com LCP/CLS/INP e
   as chamadas `GET /api/...` feitas pelo navegador. Com `VITE_SENTRY_TRACES_SAMPLE_RATE=0.1`, só ~1 visita em 10 gera
   trace.
3. Sentry → **Releases**: só aparece algo se `SENTRY_RELEASE` estiver definido na Fly (o deploy não define hoje).
4. Quando surgir uma issue, abra o evento e confira: sem cookies, sem corpo, sem query string, sem e-mail, sem
   IP; `user.id` é um UUID; tags `route`, `http_status`, `request_id`, `house`.
5. Para achar o log de um erro: copie a tag `request_id` do evento e busque nos logs da Fly (`fly logs`; linhas JSON com
   `requestId`, `route`, `status`, `durationMs`, `sentryEventId`).

## Cotas

O plano gratuito tem cota mensal de erros e de spans. Se encher, baixe `VITE_SENTRY_TRACES_SAMPLE_RATE`
(ex. `0.05`) e faça redeploy.

## Desligar

Remova o segredo `SENTRY_DSN` da Fly e a variável `VITE_SENTRY_DSN` do GitHub e faça redeploy: o SDK não
inicializa. Revogue os tokens no Sentry se não for religar.

## Observações

- No SDK v11, sessões do navegador afetadas por erro não tratado contam como `unhandled` (não `crashed`), então
  o "crash-free" tende a ficar perto de 100% — leia junto com os widgets de erros.
- Se um widget ficar sem dados por mais de um dia com tráfego normal, o nome do campo pode ter mudado no Sentry
  (ou nunca ter batido — veja o aviso do passo 6): ajuste-o no JSON e rode o script de novo (o erro da API, se
  houver, sai no terminal).
- Corpos JSON malformados respondem 400 com `code: "INVALID_JSON"` (`json_body` em `server/src/errors.rs`) e não
  viram issue; só falha inesperada do servidor (500) chega ao Sentry.
