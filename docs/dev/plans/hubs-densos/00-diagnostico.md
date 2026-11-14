# 00 · Diagnóstico: o que acontece hoje com um hub de centenas de vizinhos

> Estado do código em 2026-11-13, branch `feature/context-look-clusters` (`0cf9d78`).
> As capturas vêm de uma sonda Playwright descartável (API mockada, sem backend), não commitada.
> Números de linha são os de hoje e envelhecem: use o nome da função para reencontrar.

## Como foi reproduzido

Grafo sintético de QSA, carregado pela rota mockada de `subgraph`:

- 1 empresa hub (`hub`);
- N sócios ligados direto ao hub (N = 300 e N = 1500), 1 em cada 9 é pessoa jurídica;
- cada aresta tem `qualificacao` (Sócio, Acionista, Sócio-Administrador, Diretor, Conselheiro, Procurador) e tipo `SOCIO_DE` ou `ADMINISTRA`;
- **5% dos sócios também são sócios de 1 ou 2 de outras 6 holdings.** Esse é o sinal que o investigador procura: quem, entre centenas, tem outro vínculo.

Viewport 1440×900, configuração padrão do app (2D, force layout, degree dim ligado). A taxa de quadros que aparece nas capturas é do renderizador por software do Chromium headless e não vale como medida de desempenho.

## O que se vê

| # | Cena | Captura | O que a tela mostra |
|---|---|---|---|
| 1 | Force, 300 sócios, zoom de encaixe | [01](screens/01-force-300.png) | Os 15 sócios com outro vínculo são puxados para fora do disco e ficam visíveis. Os 285 restantes formam um disco quase invisível (degree dim a 0,2). Nenhum rótulo além do hub. **A tela não diz quantos são nem de que tipo.** |
| 2 | Force, 300, aproximado | [02](screens/02-force-300-zoom.png) | Mesmo de perto os sócios-folha não ganham rótulo legível: o rótulo herda o esmaecimento de 0,2 (`useGraphLabels.ts:309`) e o nó encolhido pode ficar abaixo do limiar de tamanho. Só rótulos de aresta soltos. O zoom não revela nada novo. |
| 3 | Force, 300, 3D | [03](screens/03-force3d-300.png) | Bola de folhas em volta do hub. Oclusão: folhas da frente tapam as de trás e o hub. |
| 4 | Force, 300, programa *Orphan Clusters* | [04](screens/04-force-300-orphan-clusters.png) | 307 nós viram 22 objetos: 1 nó-cluster de 285 + os 15 sócios com outro vínculo + holdings. **Estruturalmente é a resposta certa.** Mas o cluster chama `cluster_orphan_hub`, não mostra a contagem no canvas, e mistura PF, PJ e todas as qualificações num saco só. |
| 5 | Force, 300, protótipo de "coleções" | [05](screens/05-force-300-colecoes.png) | Programa de cluster escrito na sonda (anexo do [03](03-design.md#anexo-programa-de-coleções-usado-na-sonda)): folhas agrupadas por (tipo de aresta, tipo de nó, qualificação). 8 coleções. Sem tocar no código do app. Sem rótulo no zoom de encaixe; todas roxas; entre cada coleção e o hub há ~100 arestas paralelas sobrepostas. |
| 6 | Idem, aproximado | [06](screens/06-force-300-colecoes-zoom.png) | Os rótulos aparecem, mas "×" vira "?" e os acentos somem (atlas MSDF); rótulos de coleção colidem entre si e com o do hub. |
| 7 | Idem, uma coleção de 9 aberta | [07](screens/07-force-300-colecao-aberta.png) | Os 9 membros aparecem como pontos cinza soltos em volta do hub. **Nada indica que eram um grupo, nem como fechar de novo pelo canvas.** |
| 8 | Ego layout, 300 | [08](screens/08-ego-300.png) | Um anel enorme (raio ≈ 1240), nós com 1 ou 2 px. Os 15 sócios interessantes ficam espremidos num arco. Ilegível. |
| 9 | Ego layout, 300, *Orphan Clusters* | [09](screens/09-ego-300-orphan-clusters.png) | **Bug:** o anel continua do tamanho de 300 nós e o nó-cluster flutua fora dos anéis, ligado por um arco longo. |
| 10 | Force, 1500 | [10](screens/10-force-1500.png) | Disco de ~1420 folhas invisíveis; 75 sócios com outro vínculo legíveis fora dele. |
| 11 | Force, 1500, coleções | [11](screens/11-force-1500-colecoes.png) | 1507 nós viram ~95 objetos. Coleções de 570 e de 39 têm o mesmo tamanho (teto de tamanho), sobrepõem-se ao hub e entre si; rótulos colidem. |

Tempo do programa de cluster no worker (inclui clonar o grafo): 0,35 s com 300 folhas, 1,6 a 2,3 s com 1500, medido em headless com CPU por software.

## Leitura do diagnóstico

1. **O force layout já separa o sinal do ruído por acaso** (quem tem dois vínculos é puxado para fora) e o degree dim reforça isso. O que falta é o ruído ser *resumido* em vez de só apagado: quantos, de que tipo, com que papel.
2. **A agregação explícita já existe e funciona** (clusters fechados, capturas 4, 5 e 11). O que falta é ela ser *apresentável*: nome, contagem no nó, uma aresta só, cor, e um jeito de abrir e fechar sem perder o grupo de vista.
3. **O ego layout é o pior caso** e tem um bug de integração com clusters já descrito em [ego-crowded-rings-qsa.md](../ego-crowded-rings-qsa.md) (fase B1, não implementada).
4. **O zoom hoje só controla rótulos.** Aproximar não revela nós nem detalhe.
5. Antes de tudo isso há o problema de **chegar** aos 300 vizinhos: a expansão pelo clique traz no máximo 100 arestas arbitrárias, sem avisar.

## O que já existe e será reutilizado

| Bloco | Onde | Para que serve aqui |
|---|---|---|
| Modelo de cluster (N:M, aberto/fechado) | `frontend/src/types/cluster.ts`, `stores/cluster.ts` (`visibleNodeIds`, `openCluster`, `closeCluster`, `createCluster`, `executeProgram`) | É o meta-nó. Não criar um segundo conceito. |
| Substituição no canvas | `stores/graph.ts` `enhancedNodes` (:1100) e `enhancedEdges` (:1142) | Nó sintético `__cluster__` com `node_count`; arestas remapeadas; arestas internas somem. |
| Soma de arestas paralelas | `utils/parallelEdges.ts` `aggregateParallelEdges`, ligado por `aesthetics.sumParallelEdges` (desligado por padrão, `graph.ts:649`) | Uma aresta com contagem entre a coleção e o hub. |
| Programas de cluster | JS em worker isolado, 10 s de limite (`services/clusterProgramRunner.ts`); parâmetros com `node_binding`; `show_in_context_menu`; escopo contexto ou exploração | O agrupamento de folhas é um programa. Embutidos: `ORPHAN_CLUSTERS`, `GROUP_BY_TYPE`, `BFS_FROM_NODE` (`cluster.ts:875`). |
| Modal do cluster | `components/ClusterNodeModal.vue` (tabela de membros com busca, ordenação, CSV, Abrir/Fechar) | Já é a "lista de vizinhos" de uma coleção. |
| Legenda de grupos | `components/GroupLegend.vue`, `composables/useGroupRows.ts` | Lista com contagem e alternância de colapso. |
| "Mostrar só" | `utils/isolation.ts`, regra `cluster` ou `value` | Isolar uma coleção. Persistido em exploração e em visão de caso. |
| Ego layout determinístico | `utils/layoutModes.ts` `computeTreeLayout` (:427), ordenação do anel por tipo, propriedade ou comunidade, guias com contagem, `egoLayoutStats` | Base do caso "ego". O ramo `layered` já quebra linhas lotadas em sublinhas. |
| LOD de rótulos | `composables/useGraphLabels.ts`: frustum, limiar de raio em tela (`labelSizeThreshold: 6` px), grade estilo Sigma (`utils/LabelGrid.ts`), filtro de sobreposição | Base do caso "zoom". |
| Gancho de câmera parada | `composables/useGraphCamera.ts` (`cameraIdleTimeout`, 300 ms) dispara `updateLabels()` e `updateVisuals()` | Ponto de entrada de qualquer LOD por zoom. |
| Esconder sem reconstruir | `utils/graphAppearance.ts` `computeNodeAppearance` (flag `hidden`), contrato em `graph.ts:1052` | LOD de nós sem reaquecer o layout. |
| Posição de nós novos | `utils/seedNewNodePositions.ts` | Onde os membros nascem ao abrir uma coleção. |
| Grau e hubs | `graph.ts` `nodeDegrees` (:1243), `hubNodeIds` (:1262), degree dim (`degreeDimThreshold: 30`) | Detectar hub e folha sem custo novo. |
| Expansão no backend | `ExpandRequest{edge_types, edge_limit 4..1000, directed}` (`api/graphlagoon/models/schemas.py:1273`) | Filtro por tipo e direção já existem; só a UI não usa. |
| Persistência | `ExplorationState.clusters`, `layout_mode_config`, `graph_contexts.cluster_programs`, `default_behaviors`, `CaseViewContent.groups_closed` | Sem migração para quase tudo deste plano. |

## Lacunas (cada uma vira item do plano)

| ID | Lacuna | Evidência |
|---|---|---|
| L1 | Ego e hierárquico ignoram clusters: leem `graphStore.nodes/edges` crus | `GraphCanvas3D.vue:1903` e `:1971`; captura 9 |
| L2 | Anel lotado só cresce em raio; `EGO_MIN_NODE_ARC = 26` fixo | `GraphCanvas3D.vue:114`; captura 8 |
| L3 | Nó-cluster sem contagem legível no zoom de encaixe; nome técnico; cor padrão única `#9333ea` | `graphAppearance.ts:239`; capturas 4 e 5 |
| L4 | Tamanho do cluster satura: `min(sqrt(n)·5+10, 50)` (teto atingido com 64 membros) | `GraphCanvas3D.vue:512`; captura 11 |
| L5 | Leque de arestas paralelas entre coleção e hub (soma desligada por padrão) | `graph.ts:649`; captura 5 |
| L6 | Coleção aberta não deixa rastro (sem contorno, sem cor comum, sem "fechar" no canvas) | captura 7 |
| L7 | Câmera não reenquadra depois de colapsar | sonda: foi preciso clicar *Fit* |
| L8 | Atlas de rótulos cobre só ASCII 32–126: acentos são removidos (NFD) e "×" vira "?" | `utils/FastLabelRenderer.ts:538-548`; captura 6 |
| L9 | Expandir **apaga os clusters**: o watcher em `graphStore.nodes` limpa tudo quando o array troca de identidade, e `expandFromNode` troca | `cluster.ts:1121`; `graph.ts:1893` |
| L10 | Expansão sem aviso nem escolha: a UI sempre pede profundidade 1 e 100 arestas; o SQL não tem `ORDER BY` e o limite conta também arestas entre vizinhos; `truncated` é ignorado | `GraphCanvas3D.vue:2541`; `sql_warehouse.py:466-530` |
| L11 | Não existe "quantos vizinhos este nó tem, por tipo" antes de expandir | nenhum endpoint de contagem |
| L12 | Não há ação centrada no hub ("agrupar os vizinhos *deste* nó por…"); os programas embutidos são globais e o de órfãos não separa por tipo | `cluster.ts:879-973` |
| L13 | Zoom só afeta rótulos; não há LOD de nós nem de coleções | `useGraphLabels.ts` |
| L14 | Forças iguais para todos: carga, distância e colisão globais; clusters grandes se sobrepõem ao hub | `utils/forceConfig3D.ts:141-214`; captura 11 |
| L15 | Painel do nó não lista vizinhos nem resume por tipo (só existe em `EntityPage.vue` do caso) | `components/SelectionDetails.vue` |
| L16 | `circular` e `grid` estão declarados mas não implementados | `utils/layoutUrlOverrides.ts:33-40` |

## Restrições de produto que valem para qualquer solução

Vêm de `docs/dev/decision_log.md` (entrada de 2026-07-20, linha 2941, e de 2026-08-28, linha 7896):

- **Nada escondido em silêncio.** Edge bundling, esmaecer por densidade e filtro por grau foram rejeitados: o nó de grau alto costuma ser o alvo, e a transação única é o caso.
- **Agregação explícita é aceita** quando mostra a contagem e pode ser aberta.
- **Determinismo do ego layout é requisito**: duas execuções devem ser comparáveis; nada de forças nem lentes que distorcem distância.
- Uma captura do canvas pode ir para um relatório. O que ela mostra tem de ser verdade sobre os dados.

Observação: o degree dim, ligado por padrão, já esmaece folhas de hubs (com "preservar pontes"). Ele não remove nada e é configurável, mas na prática é a única resposta atual ao problema e não diz ao usuário o que está esmaecido. O plano o mantém e o torna desnecessário quando há coleções.
