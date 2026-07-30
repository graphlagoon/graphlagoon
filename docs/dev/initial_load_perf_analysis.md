# Análise: performance do carregamento inicial do grafo

> Documento de avaliação (2026-07-30). Explica **onde** cada problema acontece no código,
> **quando** o usuário é afetado, **qual ganho** cada solução traz e **quais os trade-offs**.
>
> **STATUS (atualizado após implementação):** Fases 0, 1 e 2 implementadas e medidas
> contra warehouse real. As estimativas abaixo foram escritas *antes* das medições —
> onde os dados contradisseram a previsão, há uma nota **MEDIDO**. Detalhes completos
> no [decision_log.md](decision_log.md).
>
> | Fase | Status | Resultado real |
> |---|---|---|
> | 0 — Instrumentação | ✅ feita | revelou que o harness `perf-report` estava quebrado (media zero) |
> | 1 — SQL (P2+P4) | ✅ feita | payload **-35%** (13 cols) / **-87%** (100 cols); Cypher elimina a 2ª query |
> | 2 — Progressiva (P3) | ✅ feita | ver 2b |
> | 2b — Tabelas largas | ✅ feita | **100 colunas: browser 7898 → 1731 ms (-78%)**; limiar `auto` + enriquecimento em 2 ondas |
> | 3 — Partials no job | ⏸ não feita | — |
> | 4 — markRaw | ❌ **implementada e revertida** | ganho medido = **zero** (ver abaixo) |
>
> **A largura da tabela de nós é o fator decisivo.** Com 13 propriedades a carga
> progressiva ganhava 15% (e perdia em grafos pequenos); com 100 colunas ganha
> 78%. Por isso o comportamento é `'auto'` (decide por largura) em vez de um
> default fixo. Ver a entrada *Phase 2b* no decision log.

## 1. O fluxo atual, passo a passo

Quando o usuário abre um contexto (`/graph/:contextId`), acontece esta cadeia — **tudo sequencial, nada em paralelo**:

```
Browser                          API (FastAPI)                    Warehouse (Spark/Databricks)
  │
  ├─ GET /graph-contexts/{id} ──▶ lê contexto (metadados)              (não toca o warehouse)
  │◀─ contexto ─────────────────┘
  │
  ├─ POST /subgraph ────────────▶ monta SQL de ARESTAS ──────────────▶ ORDER BY RAND() LIMIT 1000
  │                              │                                     (lê a tabela INTEIRA)
  │                              │◀─ 1000 arestas ────────────────────┘
  │                              │
  │                              ├─ coleta IDs de nós (src/dst) em Python
  │                              │
  │                              ├─ monta SQL de NÓS ────────────────▶ SELECT n.*  (TODAS as colunas)
  │                              │◀─ ~2000 nós completos ─────────────┘
  │                              │
  │◀─ UM ÚNICO JSON (nós + arestas + todas as properties) ────────────┘
  │
  ├─ nodes.value = [...]  (Vue envelopa TUDO em Proxy reativo)
  ├─ cadeia de 6 computeds recalcula
  ├─ buildGraphData() (chunked, ok)
  ├─ settleLayout no Web Worker (ok)
  └─ graph3d.graphData()  →  PRIMEIRO PIXEL DO GRAFO
```

**O ponto central:** o usuário só vê o grafo depois que *tudo* isso termina. E a maior parte do
tempo/bytes é gasta em dados (`properties` dos nós) que **não são necessários para desenhar** —
só servem para tooltip, painel de detalhes e busca.

---

## 2. Os problemas, um a um

### P1 — `ORDER BY RAND()` na carga inicial

- **Onde:** [graph.py:250](api/graphlagoon/routers/graph.py#L250) (endpoint `POST /subgraph`)
- **Quando acontece:** apenas no auto-load ao abrir um contexto (`autoLoadOnOpen`) **e** somente
  quando não há filtro de tipo de aresta. Queries do console (SQL/Cypher) **não** passam por aqui.
- **O problema:** para devolver 1000 arestas "aleatórias", o warehouse precisa **ler e embaralhar
  a tabela inteira** de arestas. Numa tabela de milhões de linhas, paga-se o custo de milhões
  para receber 1000.
- **Quem sente:** todo usuário com `autoLoadOnOpen` ligado, em toda abertura de contexto grande.
  É provavelmente o item individual mais caro do primeiro paint em tabelas grandes.
- **Decisão (2026-07-30): manter como está.** A amostra aleatória é intencional (uma amostra
  determinística pelas primeiras linhas físicas seria enviesada) e o custo só incide no
  auto-load. **Fora de escopo.**

### P2 — `SELECT n.*`: todas as colunas de todos os nós

- **Onde:** [graph_operations.py:410-419](api/graphlagoon/services/graph_operations.py#L410-L419)
- **Quando acontece:** **sempre**, em todos os caminhos (subgraph, query SQL, Cypher, expand).
  É a "segunda query" obrigatória depois das arestas.
- **O problema:** o frontend só precisa de `node_id` + `node_type` para desenhar (cor, tamanho,
  ícone). As `properties` — que podem ser 30+ colunas — dominam o payload (facilmente vários MB),
  o tempo de query, a serialização JSON e o custo de reatividade no Vue. E existe um campo
  `context.node_properties` que já lista as colunas relevantes, mas hoje ele **só** é usado para
  montar o schema do transpiler Cypher, nunca para estreitar o SELECT.
- **Quem sente:** todos, em todo carregamento. Quanto mais larga a tabela de nós, pior.

### P3 — Sequencialidade estrita + resposta em blob único

- **Onde:** [graph_operations.py:294-481](api/graphlagoon/services/graph_operations.py#L294-L481)
  (orquestrador das duas queries) e [warehouse.py:1038-1231](api/graphlagoon/services/warehouse.py#L1038-L1231)
  (chunks baixados em paralelo mas **remontados em um único array** antes de responder).
- **Quando acontece:** sempre. A query de nós só pode começar depois que **todas** as arestas
  chegaram e foram parseadas (os IDs são coletados em Python). E o browser só recebe o primeiro
  byte útil quando as **duas** queries terminaram.
- **O detalhe importante:** internamente já existe uma resposta "só arestas" pronta
  ([graph_operations.py:386-397](api/graphlagoon/services/graph_operations.py#L386-L397) retorna
  `GraphResponse(nodes=[], edges=...)` antes da fase 2) — ela só não é exposta ao cliente.
- **Quem sente:** todos. O tempo até o primeiro pixel é `T(arestas) + T(nós) + T(download blob)`,
  quando poderia ser próximo de `T(arestas) + T(query estreita de tipos)`.

### P4 — Redundância no caminho Cypher

- **Onde:** [graph.py:614+](api/graphlagoon/routers/graph.py#L614) → mesmo funil de
  `execute_graph_query_with_nodes`.
- **Quando acontece:** em toda query Cypher cujo SQL transpilado (gsql2rsql) **já fez join** com
  a tabela de nós e já retornou os dados deles.
- **O problema:** o backend ignora esses dados e roda a segunda query completa (`SELECT n.*`)
  de novo — uma ida ao warehouse inteiramente redundante.
- **Quem sente:** usuários do console Cypher, em toda query.

### P5 — Custo de reatividade no frontend

- **Onde:** [graph.ts:254-255](frontend/src/stores/graph.ts#L254-L255) — `nodes`/`edges` são
  `ref` profundo, sem `shallowRef`/`markRaw`.
- **Quando acontece:** no momento do `nodes.value = response.nodes` após cada fetch.
- **O que se supunha:** que envolver cada dicionário de properties num Proxy custasse CPU no
  assign e em toda leitura subsequente.
- **MEDIDO — a suposição estava errada, este problema NÃO EXISTE na prática:**
  o Vue proxifica **sob demanda**, então o assign custa **0 ms** mesmo com 18,7k nós × 98
  colunas. O custo só apareceria em quem percorresse todas as chaves via Proxy — e o único
  candidato (`DataTablePanel`) já chama `toRaw()` antes. A/B no app real: sem diferença
  (1542 ms vs 1587 ms).
- **Quem sente:** ninguém, com o código atual. Ver a Fase 4 (tentada e revertida).

### P6 — Buracos de instrumentação

- **Onde:** `loadContext` sem timing, `graph3d.graphData()` (o único bloco síncrono
  não-chunkável) sem timing, cadeia de computeds sem timing, caminho de exploration sem timing.
- **O problema:** sem esses números não dá para provar ganho de nenhuma das mudanças acima,
  nem priorizar corretamente. Já existe infra pronta (`recordPerf`/`recordGraphLoad`,
  `make perf-report`) — só faltam os pontos de medição.

---

## 3. Soluções propostas (em fases independentes)

Cada fase é entregável sozinha e mantém a suite verde. Ordenadas por relação esforço/impacto.

### Fase 0 — Fechar os buracos de medição (P6)

**O quê:** adicionar `recordPerf` em `loadContext`, `graph3d.graphData()`, cadeia de computeds;
rodar `make perf-report` num contexto grande e guardar o JSON como baseline.

| | |
|---|---|
| **Ganho para o usuário** | Nenhum direto — mas todas as fases seguintes passam a ter antes/depois mensurável. |
| **Quando percebe** | n/a |
| **Trade-off** | Praticamente nenhum (instrumentação é no-op em produção). |
| **Esforço** | Pequeno. |

### Fase 1 — Otimizações de SQL (P2, P4) — sem mudar API nem UX

> O `ORDER BY RAND()` (P1) fica **fora de escopo** por decisão de 2026-07-30 — a amostra
> aleatória é intencional.

**1a. Estreitar o SELECT de nós:** quando o contexto tem `node_properties` configuradas, projetar
só essas colunas em vez de `n.*`.

**1b. Aproveitar nós já presentes no resultado Cypher:** se o SQL transpilado devolveu structs de
nós, construir os `Node`s dali e só buscar na fase 2 os que faltam (frequentemente zero).

| | |
|---|---|
| **Ganho para o usuário** | **MEDIDO:** payload **-35%** (consistente em 3k e 20k arestas); query de nós -34% em 20k (mas só -3% em 3k com cache quente — o payload é o efeito confiável). **1b MEDIDO:** `RETURN r, a, b` elimina a segunda query (`node_query_ms=0.0`), com nós idênticos aos do caminho antigo. |
| **Quando percebe** | 1a: todo carregamento em contexto com propriedades configuradas. 1b: toda query Cypher que retorna nós. |
| **Trade-offs** | **1a:** se o usuário espera ver uma coluna que não está em `node_properties`, ela some do tooltip — fallback para `n.*` quando a lista está vazia. **1b:** exigiu normalizar tipos (`_stringify_scalar`) — os dois caminhos produziam `float` vs `str` para a mesma propriedade, o que quebraria filtros e ordenação no cliente. |
| **Esforço** | Pequeno/médio, só backend. |

### Fase 2 — Carga progressiva em duas etapas (P3) — a mudança principal

**A ideia:** separar "o que preciso para desenhar" de "o que preciso para inspecionar".

1. `/subgraph` com `nodes_mode: "types"`: devolve arestas + nós com **apenas** `node_id` e
   `node_type` (query estreita e rápida; `properties = null`).
2. O canvas desenha **imediatamente** — cor/tamanho/ícone já corretos, porque dependem só do tipo.
3. Em background, o store busca as properties em lotes (`POST /graph-contexts/{id}/nodes/batch`,
   ~1500 IDs por lote, concorrência 2) e **faz patch in-place** nos nós.
4. Se o usuário clica/hover num nó ainda sem properties, aquele ID fura a fila (prioridade) e o
   tooltip mostra "carregando propriedades…" por um instante.

**Por que o patch é seguro (verificado no código):** o watcher do canvas
([GraphCanvas3D.vue:1324-1352](frontend/src/components/GraphCanvas3D.vue#L1324-L1352)) só dispara
rebuild quando a **contagem** de nós/arestas muda — preencher properties não re-renderiza nem
mexe no layout. Os watchers de community/similarity observam a **identidade** do array — patch
in-place não os dispara. Um sinal explícito (`nodePatchVersion`) atualiza apenas labels/ícones
via `updateVisuals()` (barato, sem recriar objetos Three.js).

**O que fica fora (de propósito):** exploration snapshots, `expandFromNode` e o job de
query/Cypher continuam no modo `full`, inalterados — zero risco para os fluxos existentes.

| | |
|---|---|
| **Ganho para o usuário** | **MEDIDO (live browser + warehouse real, 25 colunas):** primeiro paint 972 → 827 ms (**-15%**) em 3086 nós; payload do primeiro fetch **-44%**. |
| **Quando percebe** | Abertura de contexto com auto-load em grafos **grandes**. |
| **Trade-offs** | **MEDIDO — o mais importante:** o custo **total** sobe ~37% (o enriquecimento é uma passada a mais). Em grafos pequenos (~1k nós) a carga progressiva é **mensuravelmente pior** (700 → 759 ms). Ou seja: **não é ganho universal**, é uma troca de latência-até-o-primeiro-pixel por trabalho total. Por isso ficou atrás da flag `behaviors.progressiveLoad` — e vale considerar acioná-la por limiar de tamanho numa próxima iteração. Demais trade-offs previstos se confirmaram: tooltips incompletos por alguns segundos (mitigado por priorização no clique + indicador na status bar), complexidade nova no store, mocks de E2E. |
| **Esforço** | Médio (backend: 1 endpoint + 1 modo; frontend: 3 actions + 1 watcher no canvas). |

### Fase 3 — Resultados parciais no caminho de query/Cypher (P3 para o console)

**O quê:** o job assíncrono já tem polling com progresso; adicionar `partial` ao status do job —
após a fase de arestas, o poller já aplica arestas + nós tipados e o grafo aparece; o resultado
final chega como patch (mesmo mecanismo da Fase 2). De quebra, corrigir o vazamento de memória do
registro de jobs ([async_job.py:22](api/graphlagoon/services/async_job.py#L22) retém resultados
para sempre — adicionar TTL).

| | |
|---|---|
| **Ganho para o usuário** | Queries do console mostram o grafo assim que as arestas chegam, em vez de esperar o job completo. |
| **Quando percebe** | Toda query SQL/Cypher no console. |
| **Trade-offs** | Payload de polling maior (o partial viaja no status); lógica de "aplicar só uma vez" (sequência monotônica); mais estados intermediários para testar. Foi **preferido a streaming/SSE** porque reaproveita a máquina de polling existente — streaming exigiria novo transporte, novo parsing no cliente e quebraria os mocks do Playwright. |
| **Esforço** | Médio. |

### Fase 4 — `markRaw` nas properties (P5) — ❌ TENTADA E REVERTIDA

**O que se previu:** marcar os dicionários `properties` com `markRaw` para o Vue
parar de proxyficar a parte mais pesada dos dados, estimando ~370 ms de main
thread destravado ao abrir a tabela de dados com 100 colunas.

**O que a medição mostrou:** ganho **zero**. A/B contra o app real (tabela de
100 colunas, 18,7k nós): abrir a tabela de dados levou **1542 ms sem** o markRaw
e **1587 ms com** ele.

**Por quê a estimativa errou.** O custo do Proxy é proporcional a quantas
*chaves* o leitor toca:

| acesso, 18,7k nós × 98 colunas | reativo | markRaw |
|---|---|---|
| percorrer todas as chaves | 398 ms | 11 ms |
| ler 1 chave por nó | 20 ms | 13 ms |
| passar o dict por referência | 10 ms | 6 ms |

Só a primeira linha é dramática — e o único código que faria isso
(`DataTablePanel`) **já chama `toRaw()` antes**
([DataTablePanel.vue:52](frontend/src/components/DataTablePanel.vue#L52)), então
nunca pagou esse custo. Os consumidores reais (`getDistinctPropertyValues`,
`buildGraphSnapshot`) tocam poucas chaves, onde a diferença é ruído.

**Por que foi revertida.** Manter o markRaw imporia uma regra permanente —
"nunca mute uma chave de properties in-place" — que todo desenvolvedor futuro
precisaria conhecer. Trocar isso por um ganho medido como zero é uma troca ruim.

**Se um dia voltar a importar:** o sinal é alguém escrever um loop que percorre
`node.properties` de todos os nós sem `toRaw`. A correção certa aí é `toRaw`
naquele call site — localizada, sem regra global.

**Lição de método:** o microbenchmark sintético mediu um padrão de acesso que o
app não usa. Só o A/B contra a aplicação real revelou. Vale desconfiar de
qualquer estimativa de perf que não tenha passado pelo caminho de código
verdadeiro.

---

## 4. Resumo: onde o usuário sente cada fase

| Fase | Momento em que o usuário percebe | Tipo de ganho | Risco |
|---|---|---|---|
| 0 — Instrumentação | nunca (habilita medição) | — | ~zero |
| 1 — SQL wins | contextos com propriedades configuradas; query Cypher | payload menor + latência de backend | baixo |
| 2 — Carga progressiva | toda abertura com auto-load | **tempo até o primeiro pixel** | médio |
| 3 — Partials no job | toda query do console | tempo até o primeiro pixel | médio |
| 4 — markRaw | ❌ revertida — ganho medido zero | — | — |

**Alternativas descartadas** (e por quê):
- **Streaming NDJSON/SSE** — novo transporte de ponta a ponta, incompatível com o client axios e
  com os mocks de E2E; o polling com partials entrega a mesma UX na infra existente.
- **Uma única query com join servidor-side (arestas ⋈ nós)** — economiza uma ida ao warehouse,
  mas mata justamente a entrega antecipada das arestas; a latência de round-trip é pequena perto
  do custo de scan/payload.
- **Esqueleto puro sem `node_type`** (nós sintetizados só dos src/dst) — o tipo dita cor/tamanho/
  ícone e é assado no build do canvas; corrigir depois forçaria rebuild visual quase completo.
  A query de tipos é quase de graça, não há razão para pular.
- **Properties só sob demanda (lazy puro, sem background)** — quebraria DataTable, busca por
  propriedade, filtros e snapshots, que esperam properties populadas.

## 5. Como validar

1. Baseline da Fase 0: `make perf-report` (warehouse local, contexto grande seedado) → guardar JSON.
2. Após cada fase, re-rodar e comparar: `load:subgraph:fetch/assign`, `metadata.edge_query_ms` /
   `node_query_ms`, novo `graphDataApply`, e as métricas derivadas **tempo-até-primeiro-render**
   e **tempo-até-properties-completas**.
3. Gates por fase: `pytest api/tests`, `npm run test:run` (~905 testes), `npm run e2e`.
