# Briefing dos agentes de execução

Instruções que cada agente recebe para implementar **uma** tarefa do
[plano](04-plano-de-implementacao.md). Mantido aqui para acompanharmos como a execução
é conduzida; mudou, commita junto.

## Antes de começar

1. [README](README.md): Definition of Done e decisões em aberto (Q1–Q9). Use os
   padrões e registre cada suposição no decision log.
2. A seção da tarefa no plano e só as partes de [03](03-arquitetura.md) /
   [02](02-design.md) (e `screens/*.png`) que ela cita.
3. `git log --oneline` e as entradas recentes do `docs/dev/decision_log.md`, para
   reaproveitar o que tarefas anteriores construíram.
4. `.claude/skills/skill_feature_creation/SKILL.md` só para os passos obrigatórios:
   permissão (2.4b), área admin (4.2b), docs públicas (4.2).

## Como escrever o código

- Precisa existir? Pule features, opções e flexibilidade que ninguém pediu (cite-as
  numa linha). Pedido vago → a menor versão que faz o trabalho principal.
- Já existe no código (helper, componente, serviço, padrão)? Use do jeito que o código
  ao redor usa. Biblioteca padrão ou dependência já instalada antes de dependência
  nova; nunca uma dependência por poucas linhas.
- O menor diff que funciona, depois de saber tudo que ele precisa tocar. Sem
  abstração, wrapper, option, config ou código "para depois". Apagar vence adicionar.
  Mantenha camadas, interfaces e convenções existentes.
- Seja preguiçoso na solução, nunca na mudança: termine tudo que a tarefa exige,
  incluindo chamadores, testes e fixtures que sua mudança quebra.
- Comente só o porquê que o código não mostra, em uma linha. Atalho com limite
  conhecido: `shortcut: <o limite>, <quando evoluir>`.
- Bug: antes de editar, grep em todos os chamadores e corrija a causa uma vez.
- Entre opções do mesmo tamanho, a correta nos casos de borda.

## Testes: poucos e onde importam

- Lógica nova não trivial (branch, loop, parser, dinheiro, segurança, permissão) ganha
  **um** teste pequeno; mudança trivial, nenhum. Cubra os critérios de aceite da
  tarefa, não todas as combinações.
- Rode só os testes que você criou ou que cobrem diretamente o que mudou
  (`pytest tests/test_x.py`, `npx vitest run src/caminho`). Nada de suíte completa,
  E2E completo nem `vue-tsc` a cada passo; E2E só do spec que você escreveu.
- O orquestrador roda as suítes completas no fim de cada fase.

## Ambiente

- Backend: `cd api && .venv/bin/pytest tests/<arquivo> -q -p no:cacheprovider`
  (o `uv run` falha sem o checkout irmão do `gsql2rsql`). Pacote novo:
  `uv pip install --python api/.venv/bin/python <pkg>` e declare no `pyproject.toml`;
  não commite `api/uv.lock`.
- Falhas pré-existentes conhecidas (versão do transpilador, não são suas):
  4 em `test_cypher_comments.py` e
  `test_transpile_options.py::test_procedural_plus_cte_prefilter_yields_valid_script`.
- Frontend: `cd frontend && npx vitest run <caminho>`; tipos `npx vue-tsc --noEmit`;
  E2E `npx playwright test -c e2e/playwright.config.ts <spec>`. `npm run lint` está
  quebrado no repo.
- Docs: `cd docs && npx vitepress build` só se criou página ou entrada de sidebar.
- Sem credenciais de push nem `gh` neste ambiente: commit local só.

## Git e registro

- Branch `feature/investigations`; não troque de branch, não faça rebase nem reescreva
  histórico, não toque em `main` nem nas tarefas F5.
- `git add <caminhos>` explícitos, só os arquivos da tarefa (nunca `-A` ou `.`).
- Commits em inglês (`feat(investigations): …`, `fix(…)`, `test(…)`, `docs(…)`), sem
  `Co-Authored-By` (preferência do mantenedor).
- O commit final da tarefa leva: `[x]` no Progresso e nos critérios de aceite
  atendidos, e **uma** entrada curta no decision log (`## [AAAA-MM-DD HH:MM] -
  Feature Implemented: <ID> · <nome>`: decisões, arquivos, testes, suposições, "No
  public docs impact" ou o que mudou, "No admin-area impact" ou o que mudou).
- Bloqueio real (teste que não passa após 3 tentativas diferentes, dependência
  externa indisponível): registre no decision log, troque `[ ]` por `[~]` com uma
  linha de motivo, commite o que estiver verde e reporte.

## Resposta final ao orquestrador

Até 150 palavras: o que foi feito (arquivos-chave), testes rodados, suposições,
pendências `[~]` e hash do commit.
