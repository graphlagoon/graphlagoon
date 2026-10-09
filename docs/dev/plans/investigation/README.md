# Investigações: pacote de execução

> Status: **pronto para implementar**, design aprovado como proposta em 2026-10-09.
> **Execução em andamento** no branch `feature/investigations`: portões G1–G4
> concluídos (G4 por decisão, sem medição). O progresso tarefa a tarefa está nos checkboxes de
> [04-plano-de-implementacao.md](04-plano-de-implementacao.md#progresso) e no decision log.
>
> Este pacote basta sozinho para um agente implementar a funcionalidade. Os
> artefatos no claude.ai (canvas e documentos) são cópias para humanos e são
> privados; nada aqui depende deles.

## Objetivo

Evoluir o Graph Lagoon de explorador de grafos para **sistema de investigação AI-first de
fraude, PLD/FT e risco** para adquirentes e bancos. As capacidades são:

1. **Investigação** como entidade nova: reúne N explorações de **contexts
   diferentes**, arquivos e notas, e termina num **dossiê** com decisão.
2. **Arquivos** (CSV, SIMBA, QSA) em três papéis: grafo, enriquecimento e anexo.
3. **Tabelas de enriquecimento** no context: tabelas extras consultadas por chave,
   que não entram na query do grafo.
4. **Grafo em memória** unificado por chaves de identidade, com proveniência por nó.
5. **Seguir o dinheiro:** rastreio temporal com regra de alocação explícita (FIFO,
   proporcional, LIBR), caminhos, Sankey e linha do tempo em raias.
6. **Documentação do caso:** diário automático, notas, hipóteses, evidências
   congeladas com hash, decisão e exportações.
7. **AI-first:**
   - API REST e **servidor MCP** para um agente de IA criar e evoluir a investigação,
     rodar análises e subir artefatos (slides, documentos, relatórios, imagens) no
     **espaço do caso**, guardado no Volume;
   - o agente age em nome de uma pessoa e propõe;
   - a pessoa aprova e decide.

## Funcionalidades: o que existe hoje e o que é proposta

**Nada da coluna "Proposta" está implementado ainda;** só os portões G (correções
pré-requisito, fora desta tabela) começaram. O estado é de outubro de 2026; a
coluna "Tarefas" diz onde cada item é construído.

| Funcionalidade | Hoje no app | Proposta | Tarefas | Tela |
|---|---|---|---|---|
| **Uma investigação com várias explorações de contexts diferentes** | Não existe: cada exploração tem FK para um único context, e não há entidade "investigação" | O caso agrupa N explorações em abas, com visão unificada, seleção vinculada e fonte restrita como placeholder | F1.1–F1.6 | T2, T3 |
| Unir a mesma pessoa ou conta entre contexts | Não existe | Chaves de identidade no context | F1.4, F1.6 | T6, T2 |
| Tabelas extras de enriquecimento, fora da query do grafo | Não existe: só tabela de arestas e de nós | Tabelas no context, consultadas por chave e auditadas | F2.1, F2.2 | T6, T2 |
| Subir arquivos (SIMBA, QSA, CSV) salvos no Volume | Não existe | Grafo, enriquecimento ou anexo; streaming para o Volume com hash | FA.2, F2.3–F2.6 | T4 |
| Grafo em memória enriquecido | Parcial: um por exploração; métricas customizadas | Grafo unificado do caso, propriedades gravadas, nós promovidos | F1.6, F2.2, F2.7 | T2 |
| Seguir o dinheiro | Não existe | Rastreio temporal com regra de alocação, camadas, Sankey, raias, caminhos; também no servidor | F3.1–F3.8 | T5 |
| Resolução de entidades revisável | Não existe | Sugestões com motivo; nunca merge de documento mascarado | F2.8 | T8 |
| Dossiê, prazos, decisão e exportação | Não existe | Diário, hipóteses, evidências, decisão, laudo, SIMBA, resumo Siscoaf | F1.7, F4.1–F4.6 | T1, T7 |
| Agentes de IA no caso (MCP) | Não existe | Token do usuário, ferramentas MCP, propostas com aceite humano | FA.1, FA.3–FA.7 | T11 |
| Espaço do caso para artefatos | Não existe | Slides, docs e relatórios versionados no Volume, com aprovação humana | FA.2 | T10 |

## Ordem de leitura

| # | Arquivo | Para quê |
|---|---|---|
| 1 | Este README | Regras de trabalho e mapa do pacote |
| 2 | [04-plano-de-implementacao.md](04-plano-de-implementacao.md) | **O que fazer:** tarefas em ordem, com arquivos, critérios de aceite e testes |
| 3 | [03-arquitetura.md](03-arquitetura.md) | **Como fazer:** modelo de dados, API, frontend, algoritmos e segurança |
| 4 | [02-design.md](02-design.md) | **Como deve parecer:** telas, fluxos, sistema visual, avaliação |
| 5 | [01-pesquisa-brasil.md](01-pesquisa-brasil.md) | Regulação brasileira, tipologias, SIMBA, dados abertos |
| 6 | [00-pesquisa-mercado.md](00-pesquisa-mercado.md) | Ferramentas de mercado e método de rastreio |
| 7 | [BRIEFING.md](BRIEFING.md) | Instruções dadas a cada agente de execução (código mínimo, testes enxutos, git) |
| 8 | [../investigation-workspace.md](../investigation-workspace.md) | Proposta original (contexto histórico) |

## Mapa do pacote

```
docs/dev/plans/investigation/
├── README.md                    ← você está aqui
├── 00-pesquisa-mercado.md
├── 01-pesquisa-brasil.md
├── 02-design.md
├── 03-arquitetura.md
├── 04-plano-de-implementacao.md
├── screens/    PNG das telas propostas (T1–T11) e das 3 direções de layout
├── diagrams/   PNG do mapa do sistema, das jornadas e da comparação
└── mockups/    HTML-fonte das telas e diagramas (abra no browser; ver abaixo)
```

**Mockups.** Os arquivos `.dc.html` são as pranchas do canvas de design. Eles abrem
num browser comum:
- `./support.js` não existe localmente; o erro 404 é esperado.
- Os estilos são inline, então cores, tamanhos e espaçamentos podem ser copiados
  dali.
- A única parte dinâmica é a alternância Camadas/Sankey do T5; localmente as duas
  visões aparecem uma embaixo da outra.

**Imagens.** Para regerar os PNGs, use o Playwright do projeto (`frontend/node_modules`)
abrindo cada `.dc.html` com viewport 1440×900, ou no tamanho da prancha indicado em
[02-design.md](02-design.md).

## Regras de trabalho (Definition of Done)

Valem para **toda** tarefa do plano:

1. **Siga a skill** [`.claude/skills/skill_feature_creation/SKILL.md`](../../../../.claude/skills/skill_feature_creation/SKILL.md).
   Ela cobre registro no decision log, gate de permissão (Step 2.4b), testes, docs
   públicas (Step 4.2) e área admin (Step 4.2b).
2. **Decision log:** uma entrada por tarefa concluída em `docs/dev/decision_log.md`,
   citando o ID da tarefa (ex.: `F1.3`).
3. **Marque a tarefa** como feita no [plano](04-plano-de-implementacao.md)
   (`- [x]`) no mesmo commit.
4. **Testes verdes:**
   - backend: `make test-unit-api`. O `uv run` reescreve `api/uv.lock`; restaure com
     `git checkout -- api/uv.lock`. Se o `uv run` falhar com "Distribution not found"
     (o `gsql2rsql` aponta para um checkout irmão, `../../cyper2dsql`, que nem toda
     máquina tem), rode `cd api && .venv/bin/pytest tests/ -q`;
   - frontend: `make test-unit-frontend`;
   - tipos: `npx vue-tsc --noEmit`. O `npm run lint` está quebrado no repo; use o
     vue-tsc;
   - E2E quando a tarefa mexe em UI ou fluxo: `make test-e2e`.
5. **Permissões:** toda ação nova que um admin pode querer restringir ganha uma
   entrada no catálogo, um gate `require_permission(...)` e a affordance escondida
   com `can(...)`. Nunca crie um sem o outro (o teste `test_admin_registry` falha).
6. **Área admin:** tabela nova vai para `CLEARABLE_TABLES` ou `PRESERVED_TABLES`;
   rota mutável vai para `AUDITED_ROUTES` com um `AuditAction`; setting novo vai para
   `CONFIG_FIELD_KINDS`. O teste `api/tests/test_admin_registry.py` cobra isso.
7. **Memória e Postgres:** todo modelo novo tem paridade no `InMemoryStore`
   (`api/graphlagoon/db/memory_store.py`). O `make dev` roda sem banco.
8. **Dados de exemplo:** estenda `graphlagoon.dev.seed` quando criar entidade nova.
   O `make dev` semeia automaticamente.
9. **Commits:** em inglês, no estilo `feat(investigations): …` / `test(…)` / `docs(…)`,
   sem linha `Co-Authored-By` (preferência do mantenedor). Um branch só,
   `feature/investigations`, com um PR draft para `main` (o mesmo do prompt de
   execução autônoma abaixo).
10. **Não implemente o que está marcado como decisão em aberto** abaixo sem
    resposta humana; use o padrão recomendado e registre a suposição no decision log.
11. **AI-first (a partir da FA.6):** rota nova de investigação entrega também a
    ferramenta MCP, ou fica registrada como só humana. O teste
    `api/tests/test_agent_registry.py` cobra. Análise que o agente usa precisa ter
    versão no servidor com paridade por fixture.

## Decisões em aberto (precisam de humano)

| # | Pergunta | Padrão recomendado se não houver resposta |
|---|---|---|
| Q1 | Direção de layout: A canvas-first, B cockpit, C dossiê-first ([imagens](02-design.md#direções-de-layout)) | **A**, com o T5 funcionando como cockpit durante o rastreio |
| Q2 | Primeiro fluxo a entregar: golpe Pix (banco/IP) ou lojistas de fachada (adquirente) | **Golpe Pix** (fluxo A) |
| Q3 | Onde ficam os arquivos sigilosos e qual o tamanho máximo por upload no Databricks Apps e na Files API | No Volume, em `investigations_volume_path`, em streaming; implementar upload em partes se o limite do request for menor que `investigation_file_max_bytes` |
| Q4 | Profundidade padrão do rastreio (o MED 2.0 oficial fala em 2 camadas; fontes secundárias em 5) | 3 camadas, Δ = 24 h |
| Q5 | Teto do grafo de trabalho no browser | Medir na tarefa G4 antes de fixar |
| Q6 | Siscoaf tem API? | Não assumir: só exportar resumo estruturado |
| Q7 | Como o agente alcança o app no Databricks Apps (proxy com login do Databricks)? | `/mcp` remoto onde for alcançável; senão a ponte local stdio da FA.5 com o OAuth do Databricks CLI |
| Q8 | Agentes podem ver CPF, CNPJ e contas sem máscara? | Não (`agents_allow_unmasked_data = false`); o admin pode liberar |
| Q9 | O que o agente faz direto e o que precisa de aceite humano? | Direto: notas, evidências, fontes, artefatos em rascunho. Proposta: papel, match, hipótese, tipologia, status. Nunca: decisão, comunicação, DICT, compartilhamento, apagar, aprovar artefato |

## Execução autônoma

Prompt para uma sessão implementar o plano inteiro (G1 até F4, incluindo a FA) sem
perguntar nada.
Funciona colado numa sessão interativa; o contexto é resumido sozinho quando
cresce, e o estado fica neste repositório (checkboxes, decision log e commits).

```text
Use a skill skill_feature_creation e execute o plano de investigações de ponta a ponta, sem me fazer perguntas.

1. Leia docs/dev/plans/investigation/README.md (Definition of Done e decisões em aberto). Leia também 03-arquitetura.md e 02-design.md quando a tarefa pedir.
2. Trabalhe no branch feature/investigations: se não existir, crie-o a partir do branch que contém este pacote. Faça push depois de cada tarefa. Na primeira tarefa, abra um PR draft para main com gh e mantenha a descrição com o progresso.
3. Repita até não restar tarefa G1–G4, F1.x, FA.x, F2.x, F3.x ou F4.x desmarcada em 04-plano-de-implementacao.md, na ordem do arquivo: pegue a próxima não marcada cujas dependências estejam feitas; implemente; rode os testes do Definition of Done e corrija até ficarem verdes; registre no decision log; marque [x]; faça commit e push.
4. Decisões em aberto: use os padrões do README e registre cada suposição no decision log. Nunca pare para perguntar.
5. Bloqueio real (teste que não passa depois de 3 tentativas diferentes, dependência externa indisponível): registre no decision log, troque o [ ] da tarefa por [~] com uma linha explicando, e siga para a próxima que não dependa dela.
6. Proibido: force push, merge ou push em main, apagar dados ou arquivos fora do escopo da tarefa, mexer nas tarefas F5.
7. Ao terminar, atualize a descrição do PR com o que foi feito, os bloqueios e as suposições, e escreva o mesmo resumo para mim.
```

**Permissões:** a sessão precisa rodar comandos sem aprovação manual.
- Com `claude --permission-mode acceptEdits` mais uma allowlist (`/permissions`) para
  `make`, `npm`, `npx`, `uv`, `git` e `gh`; ou
- num container ou VM descartável, com `--dangerously-skip-permissions`.

**Variante com contexto limpo por tarefa** (mais robusta para execuções longas): roda
`claude -p` em laço, uma tarefa por chamada, e para se uma rodada não concluir nada.
Troque a regra 3 do prompt por "implemente só a próxima tarefa não marcada" e salve
o texto em `prompt.txt` antes de rodar:

```bash
PLAN=docs/dev/plans/investigation/04-plano-de-implementacao.md
pendentes() { grep -cE '^- \[ \] (G[1-4]|F[1-4]\.|FA\.)' "$PLAN"; }
antes=$(pendentes)
while [ "$antes" -gt 0 ]; do
  claude -p "$(cat prompt.txt)" --permission-mode acceptEdits \
    --allowedTools "Bash(make:*)" "Bash(npm:*)" "Bash(npx:*)" "Bash(uv:*)" "Bash(git:*)" "Bash(gh:*)" || break
  depois=$(pendentes)
  [ "$depois" -lt "$antes" ] || { echo "nenhuma tarefa concluída nesta rodada; parando"; break; }
  antes=$depois
done
```

## Artefatos para humanos (privados, não necessários para executar)

- Canvas de design (pranchas, fluxos, comparações): https://claude.ai/artifact/EzvJGjsh7w95HyHBHZa5a8
- Documento de pesquisa: https://claude.ai/code/artifact/7eb8caff-be0b-4b87-9bd3-af929d455cc0
- Documento do plano: https://claude.ai/code/artifact/415af28a-62bb-4a13-a06e-b4c10302a2db
