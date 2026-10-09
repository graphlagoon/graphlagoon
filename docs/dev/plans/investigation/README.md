# Investigações: pacote de execução

> Status: **pronto para implementar**, design aprovado como proposta em 2026-10-09.
> Nenhuma linha de código foi escrita ainda.
>
> Este pacote basta sozinho para um agente implementar a funcionalidade. Os
> artefatos no claude.ai (canvas e documentos) são cópias para humanos e são
> privados; nada aqui depende deles.

## Objetivo

Evoluir o Graph Lagoon de explorador de grafos para **sistema de investigação de
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

## Ordem de leitura

| # | Arquivo | Para quê |
|---|---|---|
| 1 | Este README | Regras de trabalho e mapa do pacote |
| 2 | [04-plano-de-implementacao.md](04-plano-de-implementacao.md) | **O que fazer:** tarefas em ordem, com arquivos, critérios de aceite e testes |
| 3 | [03-arquitetura.md](03-arquitetura.md) | **Como fazer:** modelo de dados, API, frontend, algoritmos e segurança |
| 4 | [02-design.md](02-design.md) | **Como deve parecer:** telas, fluxos, sistema visual, avaliação |
| 5 | [01-pesquisa-brasil.md](01-pesquisa-brasil.md) | Regulação brasileira, tipologias, SIMBA, dados abertos |
| 6 | [00-pesquisa-mercado.md](00-pesquisa-mercado.md) | Ferramentas de mercado e método de rastreio |
| 7 | [../investigation-workspace.md](../investigation-workspace.md) | Proposta original (contexto histórico) |

## Mapa do pacote

```
docs/dev/plans/investigation/
├── README.md                    ← você está aqui
├── 00-pesquisa-mercado.md
├── 01-pesquisa-brasil.md
├── 02-design.md
├── 03-arquitetura.md
├── 04-plano-de-implementacao.md
├── screens/    PNG das telas propostas (T1–T9) e das 3 direções de layout
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
     `git checkout -- api/uv.lock`;
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
   sem linha `Co-Authored-By` (preferência do mantenedor). Um branch por fase:
   `feature/investigations-f1`, `-f2`, ….
10. **Não implemente o que está marcado como decisão em aberto** abaixo sem
    resposta humana; use o padrão recomendado e registre a suposição no decision log.

## Decisões em aberto (precisam de humano)

| # | Pergunta | Padrão recomendado se não houver resposta |
|---|---|---|
| Q1 | Direção de layout: A canvas-first, B cockpit, C dossiê-first ([imagens](02-design.md#direções-de-layout)) | **A**, com o T5 funcionando como cockpit durante o rastreio |
| Q2 | Primeiro fluxo a entregar: golpe Pix (banco/IP) ou lojistas de fachada (adquirente) | **Golpe Pix** (fluxo A) |
| Q3 | Onde ficam os arquivos sigilosos: storage do app, Volume do Databricks, só browser | O mesmo `BlobStore` dos snapshots (local ou Volume) |
| Q4 | Profundidade padrão do rastreio (o MED 2.0 oficial fala em 2 camadas; fontes secundárias em 5) | 3 camadas, Δ = 24 h |
| Q5 | Teto do grafo de trabalho no browser | Medir na tarefa G4 antes de fixar |
| Q6 | Siscoaf tem API? | Não assumir: só exportar resumo estruturado |

## Artefatos para humanos (privados, não necessários para executar)

- Canvas de design (pranchas, fluxos, comparações): https://claude.ai/artifact/EzvJGjsh7w95HyHBHZa5a8
- Documento de pesquisa: https://claude.ai/code/artifact/7eb8caff-be0b-4b87-9bd3-af929d455cc0
- Documento do plano: https://claude.ai/code/artifact/415af28a-62bb-4a13-a06e-b4c10302a2db
