# Despesas UX (filtros em modal + seletor de pessoa) — validação e qualidade

**Data:** 2026-06-30 · **Escopo:** DEV apenas (sem commit/deploy até o usuário pedir)

Loop de engenharia: validar, endurecer e refinar as duas melhorias até ficarem
perfeitas, rodando testes de interface + smoke + gates de qualidade, e sugerir
melhorias. Releia este spec a cada iteração e valide o checklist **item a item**.

## Features sob teste

### A. Filtros em modal (substitui a barra inline)
- Botão **Filtrar** na toolbar abre um modal com todos os filtros (busca, pagador,
  plataforma, categoria, forma de pagamento, data de/até).
- O modal edita um **rascunho**; a busca **só é aplicada** quando o usuário clica
  em **Filtrar** dentro do modal (que fecha o modal e filtra a lista). Editar no
  modal e cancelar NÃO altera a lista.
- Filtros aplicados aparecem como **chips removíveis** ao lado do botão; o ✕ de um
  chip remove **só aquele** filtro imediatamente.
- Botão **Limpar filtros** ao lado do Filtrar (quando há filtros) limpa todos.
- Reabrir o modal mostra os filtros aplicados como rascunho editável.
- Componente: `src/components/expenses/ExpenseFiltersModal.tsx`; integração em
  `src/app/(app)/despesas/page.tsx` (estado committed + `applyFilters` + chips).

### B. Seletor de pessoa no mobile (view Por pessoa)
- No mobile (`<lg`), um seletor mostra cada membro (nome + total); escolher um
  exibe **só** a coluna dessa pessoa. Default = usuário logado.
- No desktop (`lg+`) mantém as duas colunas lado a lado (inalterado).

## Gates de engenharia (TODOS verdes)
1. `npx tsc --noEmit` limpo (apague `.next/types` se stale).
2. `npm run test` (vitest) verde.
3. `npm run build` verde.
4. `npx eslint .` — **sem erros novos** introduzidos pelas mudanças. Corrigir os
   erros nos arquivos tocados (ex.: ExpenseFiltersModal, ThemeSelector, despesas).
   Reportar (não necessariamente corrigir) os pré-existentes não relacionados.

## Testes de interface (Playwright, logado no localhost:3000)
Login: assinar um JWT de sessão do usuário id 1 com o `JWT_SECRET` do `.env` e
injetar os cookies `bolitas_session` + `bolitas_group`. Validar:
- Abrir modal → setar pagador + plataforma → **a lista NÃO muda ainda** → clicar
  Filtrar → modal fecha → lista filtra → chips corretos aparecem.
- Remover um chip pelo ✕ → aquele filtro some e a lista re-filtra; os outros
  permanecem.
- Limpar filtros → some tudo, lista volta ao total (304).
- Reabrir modal → os campos refletem os filtros aplicados.
- Mobile (viewport ~390px): na view Por pessoa, o seletor troca a pessoa exibida;
  no desktop as duas colunas aparecem.
- Funciona nos dois temas (default + bolitas), pois é token-based.

## Smoke test (não pode quebrar)
- Lista carrega; criar despesa (Nova despesa) abre/fecha; clicar numa despesa abre
  o modal de detalhe; trocar Lista/Por pessoa; CSV menu abre.

## Busca de melhorias (sugerir; implementar as seguras)
Procurar e propor melhorias de UX/qualidade, por exemplo:
- Acessibilidade do modal (foco, Esc, aria nos chips).
- Persistir filtros ao navegar/recarregar (querystring) — avaliar custo/benefício.
- `eslint-plugin-sonarjs` + `knip` como gates futuros (reportar achados; instalar só
  se o usuário aprovar — mexe em package.json).
- Contagem/affordance: o botão Filtrar mostrar quantos filtros ativos (já mostra `· N`).
Implementar as de baixo risco; listar as demais como sugestões.

## Fora de escopo
- Sem commit/deploy. Sem instalar dependências novas sem aprovação. Não refatorar
  código não relacionado nem corrigir lint pré-existente fora dos arquivos tocados.
