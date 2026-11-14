# 04 · Plano de implementação

> Proposta. Segue o fluxo de `.claude/skills/skill_feature_creation` (escopo, irmã mais próxima, fatia vertical, portões, `verify.sh`, uma entrada no `decision_log` por fase).
> Tamanhos são relativos: **P** (uma sessão curta), **M** (uma fase de um ou dois dias), **G** (vários dias, com decisão no meio).
> Design em [03-design.md](03-design.md). Lacunas L1…L18 em [00-diagnostico.md](00-diagnostico.md).
>
> **Revisto em 2026-11-13** depois de [05-estrategias-de-visualizacao.md](05-estrategias-de-visualizacao.md): a primeira entrega passa a ser a fase **FV**, que não usa cluster. F1 (coleções) fica menor e vem depois. F5 foi absorvida pela FV.

## Ordem e dependências

```
FV arranjo visual ──► FZ zoom ──► F1 colapsar pétala ──► F2 listas ──► F6 experimentos
   (sem cluster)        │
                        └── E5 revelar por zoom, se D7 = sim

F0 consertos (independentes; F0.2 a F0.4 só importam para quem usa clusters)
F3 expansão seletiva (backend; independente de tudo acima)
F4 ego: sub-anéis (converge com a FV: a mesma função arranja o anel 1)
```

| Fase | Entrega | Tamanho | Fecha |
|---|---|---|---|
| **FV** | Arranjo das folhas em coroa ou pétalas, arestas hub–folha implícitas, rótulo de região com contagem. **Sem cluster** | G | L18, L14 |
| **FZ** | Rótulos revelados aos poucos; glifo por zoom; revelar nós por zoom como opção | M | L13, L17 |
| **F0** | Cinco consertos independentes no que já existe | P cada | L1, L3, L4, L5, L9, parte de L10 |
| **F1** | Colapsar uma pétala num nó que abre (coleção), tirar membro, persistir | M depois da FV | L6, L7, L12 |
| **F2** | Resumo de vizinhos no painel; lista de membros com "tirar" | M | L15 |
| **F3** | Contagem de vizinhos no backend e diálogo de expansão seletiva | G | L10, L11 |
| **F4** | Ego: sub-anéis, aviso de anel lotado | M | L2 |
| ~~F5~~ | Absorvida pela FV: "empacotado" é o modo pétalas, sem cluster | — | — |
| **F6** | Experimentos com critério de saída | — | L8, L16 e apostas |

Recomendação de corte: **FV sozinha já torna o caso do QSA legível** (capturas 12 e 13), sem agrupar nem ocultar nó algum. FZ é a resposta ao "zoom libera mais nós". F1 só é necessária para hubs de milhares de folhas ou para quem quer um nó por grupo. F3 é o que torna o caso alcançável pelo clique (hoje só por consulta).

Fora de escopo em todas as fases: clusters aninhados, histogramas e facetas, matriz, agrupar vizinhos que têm outros vínculos, auto abrir/fechar por zoom (só em F6).

---

## FV · Arranjo visual das folhas (sem agrupamento)

> **Implementada em 2026-11-14.** Diferenças do desenho abaixo: a configuração ficou em `behaviors` (`hubLeaves`, `hubLeavesKey`, `hubLeavesMinLeaves`, `hubLeavesImplicitEdges`), não em `layout_mode_config`, porque behaviors já são validados, salvos na exploração, no preset e no `default_behaviors` do contexto; o hub é definido por número de folhas, não por grau; uma folha arrastada volta ao arranjo quando o layout roda (critério 5 da tabela de riscos ficou assim).

Estratégias E1, E2 e E4 do [05](05-estrategias-de-visualizacao.md).

**Irmãs a ler antes:** `computeTreeLayout` e seus testes (`utils/layoutModes.ts`), `applyCommunityRadialForce` e `applyEdgeTypeLayoutForce` (`utils/forceConfig3D.ts`), `utils/headlessLayout.ts` (espelha as forças para o settle em worker), `computeLinkAppearance` (`utils/graphAppearance.ts`), rótulos forçados em `composables/useGraphLabels.ts:187`.

### Critérios de aceitação

1. No painel de layout, com force layout, a opção *Hub leaves* tem **Free** (hoje), **Crown** e **Petals**. Em *Crown*, as folhas de cada hub ficam em espiral em torno dele; em *Petals*, um disco por valor da propriedade escolhida.
2. Nenhum nó some: a contagem da barra de status é a mesma nos três modos, e toda folha é selecionável.
3. As arestas hub–folha não são desenhadas nos modos *Crown* e *Petals*; aparecem ao passar o mouse ou selecionar a folha ou o hub; uma marca visível diz quantas não estão desenhadas e um botão as desenha todas.
4. Em *Petals*, cada região mostra nome e contagem no zoom de encaixe.
5. Os nós que não são folha não ficam por cima das regiões.
6. Duas aberturas do mesmo grafo dão as mesmas posições relativas das folhas.
7. Salvar e reabrir a exploração mantém o modo e a propriedade.
8. Acima de 2000 arestas (settle headless) o resultado é o mesmo.

### Arquivos

| Camada | Arquivo | Mudança |
|---|---|---|
| Lógica pura | `frontend/src/utils/hubLeaves.ts` (novo) + teste | folhas por hub; deslocamentos em coroa e em pétalas; contagem por valor |
| Forças | `utils/forceConfig3D.ts` e `utils/headlessLayout.ts` | força que prende a folha a `hub + deslocamento`; força de ligação zerada para essas arestas |
| Aparência | `utils/graphAppearance.ts` | motivo "implícita" em `computeLinkAppearance`; regra igual para rótulo de aresta |
| Rótulos | `composables/useGraphLabels.ts` | entradas sintéticas de região, sempre visíveis |
| Config | `types/graph.ts`, defaults em `stores/graph.ts`, `LayoutPanel.vue` | `hubLeaves`, propriedade, limiar; em `layout_mode_config` (dict livre, sem migração) |
| Canvas | `GraphCanvas3D.vue` | só a fiação; a lógica fica no util |
| Docs | `docs/guide/exploring-the-graph.md`; cena de captura | seção "Hubs com muitos vizinhos" |

### Verificações

| Critério | Verificação |
|---|---|
| 1, 6 | vitest de `hubLeaves`: distância mínima entre pares, determinismo em duas execuções, folha com duas arestas ao hub, balde sem valor contíguo |
| 2, 3 | vitest de aparência: aresta implícita volta com foco; e2e conta nós na barra de status nos três modos |
| 4, 5 | captura com a fixture em 300 e 1500 folhas; `ux-reviewer` |
| 7 | ida e volta do estado salvo |
| 8 | teste do settle headless com a força nova |

### Portões

Permissão: não. Docs públicas: sim. Admin: sem impacto.

### Riscos

| Risco | Mitigação |
|---|---|
| A força existe em dois lugares (ao vivo e headless) e diverge | Um teste que roda os dois sobre a mesma entrada e compara posições das folhas |
| Propriedade com dezenas de valores gera pétalas demais | Teto de regiões com um balde "outros", como o `maxAxes` do hive |
| Captura para relatório sem as arestas | A marca "N arestas ao hub não desenhadas" faz parte da cena |
| Em 3D, coroa e pétalas precisam de um plano | Primeira versão só em 2D; em 3D a opção oferece mudar para 2D |
| Nó que é folha de um hub e o usuário arrasta | Arrastar uma folha arranjada a solta do arranjo (vira nó fixado comum) |

---

## FZ · Zoom

Estratégias E3 e E5 do [05](05-estrategias-de-visualizacao.md).

### Critérios

1. Aproximando a partir do encaixe, os rótulos de folha aparecem aos poucos, em ordem estável, e não todos de uma vez por volta do zoom 11 (comparar com as capturas 15 e 16).
2. Rótulo de folha arranjada não herda os 20% de opacidade do degree dim.
3. Longe, a folha é desenhada como ponto; perto, como nó com ícone. A troca não pisca ao parar a câmera no limiar.
4. **Só se D7 = sim:** com *Reveal on zoom* ligado, longe aparecem k folhas por região e a marca "+N"; aproximar revela mais; nenhum nó muda de posição; a marca sai na captura. Desligado por padrão.

### Onde

`composables/useGraphLabels.ts` (ordem de desempate), `composables/useGraphCamera.ts` (gancho de câmera parada), `utils/graphAppearance.ts` (nível por nó; motivo de `hidden` para o item 4), `utils/LabelGrid.ts` (reuso do orçamento por célula).

### Riscos

Piscar no limiar (histerese); ordem arbitrária quando nada distingue as folhas (usar a propriedade do arranjo, depois o id, e dizer isso na interface); em 3D o gatilho é o raio em tela.

**Portões:** permissão não; docs sim; admin sem impacto.

---

## F0 · Consertos que destravam

Cada item é um commit e pode ser entregue sozinho.

### F0.1 · Ego e hierárquico enxergam clusters (L1)

- **Critério:** com layout ego focado no hub e um cluster fechado com as folhas dele, o nó-cluster fica no anel 1 e o raio do anel corresponde ao que está visível (comparar com a captura 9).
- **Onde:** `frontend/src/components/GraphCanvas3D.vue`, as duas chamadas de `computeTreeLayout` (:1903 e :1971) passam os arrays que o canvas desenha. Aviso no `LayoutPanel.vue` quando o foco está dentro de um cluster fechado.
- **Verificação:** caso novo em `utils/__tests__/layoutModes.test.ts` com um nó `__cluster__` no anel 1; cena de captura ego + cluster.
- **Risco:** esfera de cluster maior que o slot de arco. Aceitar; o slot proporcional vem em F4.

### F0.2 · Expandir não apaga clusters (L9)

- **Critério:** com clusters na tela, *Expand neighbors* mantém os clusters; rodar uma consulta nova limpa; apagar um nó o remove dos clusters e descarta cluster que ficou vazio.
- **Onde:** watcher em `frontend/src/stores/cluster.ts:1121`. Distinguir consulta nova (`graphStore.queryRunSeq`) das demais trocas de `nodes`.
- **Verificação:** teste de store com os três casos.
- **Fora:** comunidades (`stores/community.ts:546`) continuam limpando; recalcular comunidade é outro assunto.

### F0.3 · Arestas de cluster somadas (L5)

- **Critério:** entre um cluster fechado e um vizinho há uma aresta por (tipo, direção) com a contagem no rótulo, mesmo com *Sum parallel edges* desligado.
- **Onde:** `enhancedEdges` em `frontend/src/stores/graph.ts:1142`: aplicar `aggregateParallelEdges` só ao subconjunto remapeado.
- **Verificação:** teste de store; conferir que o inspetor de aresta ainda abre a aresta agregada.
- **Registro:** mudança visual deliberada para quem já usa clusters.

### F0.4 · Nó-cluster legível (L3, L4)

- **Critério:** no zoom de encaixe, todo nó-cluster mostra nome e contagem; dois clusters de 39 e 570 membros têm tamanhos visivelmente diferentes.
- **Onde:** conjunto de rótulos forçados em `composables/useGraphLabels.ts:187`; rótulo do cluster com a contagem; fórmula de tamanho em `GraphCanvas3D.vue:512`.
- **Verificação:** captura antes e depois com a fixture do anexo (1500 folhas); `ux-reviewer` sobre as capturas.
- **Cuidado:** rótulos forçados colidem entre si (captura 6). Limitar aos clusters dentro do frustum e deixar o filtro de sobreposição escolher pelo maior.

### F0.5 · Expansão avisa quando cortou (parte de L10)

- **Critério:** expandir um nó cujo resultado veio truncado mostra um aviso com o limite usado.
- **Onde:** `expandFromNode` em `frontend/src/stores/graph.ts:1893` lê `response.truncated`; `useToast`.
- **Verificação:** teste de store com resposta truncada.

**Portões de F0:** permissão: não (nenhuma ação nova). Docs públicas: sim, `docs/guide/clusters.md` e `exploring-the-graph.md` (seção *Expanding neighbors*); regerar capturas de cenas com cluster. Admin: sem impacto.

---

## F1 · Coleções de folhas por hub

> Depois da FV, esta fase encolhe: a detecção de folhas, a chave de grupo e a posição já existem em `utils/hubLeaves.ts`. Uma coleção passa a ser **uma pétala colapsada** no mesmo lugar. Os critérios abaixo continuam valendo; onde dizem "agrupar", leia "colapsar a região".

**Irmãs a ler antes:** `utils/isolation.ts` (regra reavaliada contra os dados), `stores/cluster.ts` (`executeProgram`, `getState`, `loadState`), `components/ClusterNodeModal.vue`, e a skill `skill_context_menu_action`.

### Critérios de aceitação

1. Clique direito num nó com pelo menos 5 vizinhos-folha → *Group leaf neighbors* → as folhas viram coleções fechadas, uma por (tipo de vínculo, direção, tipo de nó), cada uma com nome e contagem; os vizinhos com outro vínculo continuam soltos.
2. Depois de agrupar, expandir qualquer nó mantém as coleções; um membro que ganhou um segundo vínculo aparece solto.
3. No modal da coleção, *Pull out* numa linha tira o membro; ele continua fora depois de uma expansão.
4. *Open* e *Close* no menu de contexto da coleção: nenhum nó que não é membro muda de posição.
5. Salvar a exploração e reabrir: mesmas coleções, mesmos estados, mesmos membros retirados.
6. Um hub com folhas suficientes e sem coleção mostra um aviso com o botão *Agrupar*; o aviso pode ser dispensado.
7. *Ungroup* no hub devolve todos os membros.

### Arquivos

| Camada | Arquivo | Mudança |
|---|---|---|
| Lógica pura | `frontend/src/utils/hubCollections.ts` (novo) + teste | `computeHubCollections` (seção 2 do design) |
| Tipos | `frontend/src/types/cluster.ts` | `Cluster.collection?`, `CollectionRule`, `ClusterStoreState.collections?` |
| Store | `frontend/src/stores/cluster.ts` | regra, reavaliação preservando estado por id, exceções, `getState`/`loadState` |
| Canvas | `frontend/src/components/GraphCanvas3D.vue` | ações de menu; posicionamento incremental na troca de estado (seção 6) |
| Menu | `frontend/src/utils/builtInMenuItems.ts` | itens novos entram na lista de embutidos que o contexto pode ocultar |
| Modal | `frontend/src/components/ClusterNodeModal.vue` | *Pull out* por linha |
| Aviso | barra de status do grafo (definir no build com `reference/ux.md`) | aviso por hub |
| Docs | `docs/guide/clusters.md`, `exploring-the-graph.md` | seção "Hubs com muitos vizinhos"; cena de captura |
| E2E | `frontend/e2e/tests/user-journeys.spec.ts` | jornada: agrupar → abrir uma → tirar um → salvar → reabrir |

Não crescer `stores/graph.ts` nem `GraphCanvas3D.vue` além das chamadas: a regra fica no util, a fiação no store de cluster.

### Verificações por critério

| Critério | Verificação |
|---|---|
| 1, 7 | vitest de `hubCollections` (folha com dois vínculos ao hub, balde sem valor, tamanho mínimo, determinismo em duas execuções) + e2e |
| 2, 3 | teste de store: reavaliar após fusão; exceção persiste |
| 4 | teste que compara posições de não membros antes e depois; captura |
| 5 | teste de ida e volta de `getState`/`loadState`; e2e de salvar e reabrir |
| 6 | teste de componente do aviso; estado vazio e dispensado |

### Portões

- **Permissão:** não. É manipulação da própria vista, como rodar um programa de cluster, que não tem permissão hoje.
- **Docs públicas:** sim (páginas acima, captura, `make docs-build`).
- **Admin:** sem impacto se nada for acrescentado a `Settings`. Se o behavior `autoCollectLeaves` (decisão D1) entrar em `default_behaviors`, conferir se há registro de chaves de behavior coberto por teste.

### Riscos

| Risco | Mitigação |
|---|---|
| Reavaliar a cada mudança custa em grafo grande | A regra é O(arestas) e reutiliza `adjacencyList`; medir com `recordPerf` em 20 mil nós antes de ligar a reavaliação automática |
| Busca acha um membro escondido e o foco não vai a lugar nenhum | Conferir o comportamento atual antes; critério explícito no build |
| Usuário não entende por que um nó "saiu" da coleção após expandir | Aviso curto ("1 membro saiu de ‹114 Sócio›: ganhou outro vínculo") |
| Manter a feature pela metade (o Gephi removeu meta-nós por isso) | F1 só entra com os sete critérios; sem estado empacotado ainda |

---

## F2 · Listas

- **Critérios:** (1) selecionar um nó mostra "Vizinhos" com uma linha por (tipo de vínculo, direção, tipo de nó), contagem e as ações *agrupar*, *mostrar só*, *selecionar*; (2) a linha "com outro vínculo: N" seleciona esses nós no canvas; (3) selecionar uma linha no modal de membros destaca o nó no canvas se ele estiver visível.
- **Onde:** `components/SelectionDetails.vue` (seção nova; lógica de contagem num util, irmã: `EntityPage.vue:35-42`), `ClusterNodeModal.vue`.
- **Verificação:** vitest do util e do componente; captura em 1440, 1024 e 390 de largura (o painel é estreito).
- **Portões:** permissão não; docs sim (`exploring-the-graph.md`); admin sem impacto.

---

## F3 · Expansão seletiva

**Irmãs a ler antes:** `api/graphlagoon/routers/graph.py:398` (`expand_from_node`), `services/datasource/sql_warehouse.py:466`, e como `supportsExpand` é anunciado por tipo de fonte. Ler `reference/backend.md`.

### Critérios

1. Expandir um nó com mais de 50 arestas abre um diálogo com as contagens por tipo e direção, antes de carregar.
2. Confirmar com dois tipos marcados carrega só esses.
3. O nó mostra "carregados N de M" enquanto N < M.
4. Em fonte que não suporta contagem, a expansão funciona como hoje e avisa quando corta.
5. Em profundidade 1, com limite menor que o grau, todas as arestas devolvidas tocam o nó expandido.

### Contrato (definir antes de dividir o trabalho)

`POST /api/graph-contexts/{id}/neighbor-summary` conforme a seção 9 do design. Capacidade nova por fonte de dados, no mesmo lugar de `supportsExpand`.

### Arquivos

| Camada | Arquivo |
|---|---|
| Schema | `api/graphlagoon/models/schemas.py` (`NeighborSummaryRequest/Response`) |
| Fonte SQL | `services/datasource/sql_warehouse.py` (consulta agregada; correção da ordem e do limite em profundidade 1) |
| Outras fontes | `neptune/datasource.py`, `rest/datasource.py` (implementar ou declarar sem suporte) |
| Rota | `routers/graph.py` |
| Registro | `routers/admin_registry.py` `AUDIT_EXEMPT_ROUTES`: "read-only fetch", como `expand` |
| Front | `services/api.ts`, `stores/graph.ts` (`expandFromNode`, mapa "carregados de"), diálogo novo, selo no nó |
| MCP | conferir se `expand_exploration` deve expor a contagem; `make docs-api` |
| Docs | `exploring-the-graph.md`, `rest-api.md` |

### Verificações

pytest para a rota e para a consulta SQL gerada (nó com 3 tipos; fonte sem suporte); pytest do caso 5; vitest do diálogo; e2e com rota mockada. Lembrar que o CI não roda pytest: rodar localmente.

### Portões

- **Permissão:** não (leitura).
- **Docs públicas:** sim.
- **Admin:** sim, uma linha em `AUDIT_EXEMPT_ROUTES`; `test_every_mutating_route_is_audited_or_exempt` acusa se faltar.

### Riscos

| Risco | Mitigação |
|---|---|
| `GROUP BY` caro em tabela de arestas sem partição pelo nó | É a mesma varredura que `expand` já faz; medir no warehouse real antes de ligar o diálogo por padrão |
| Corrigir a ordem em profundidade 1 muda resultados de quem depende do comportamento atual | Registrar como correção; o comportamento atual é arbitrário |
| Contagem e carga divergirem (dados mudam entre as duas chamadas) | O selo usa o que foi carregado contra a última contagem; sem promessa de exatidão |

Paralelizável: backend e frontend com o contrato acima fixado (`reference/orchestration.md`).

---

## F4 · Ego: sub-anéis e aviso

É a fase A + C de [ego-crowded-rings-qsa.md](../ego-crowded-rings-qsa.md), que continua valendo como especificação (matemática dos sub-anéis, invariantes, lista de testes). Atualizar lá apenas os números de linha, que envelheceram.

- **Critérios:** (1) hub com 300 vizinhos no ego: o raio externo do anel 1 fica muito abaixo de 1240 e todo nó continua visível; (2) os ângulos são idênticos com a quebra ligada e desligada; (3) o painel avisa "anel 1 tem N nós" e oferece *agrupar folhas* (a ação de F1) e ordenar por propriedade.
- **Acréscimo deste pacote:** slot de arco proporcional ao raio para nós de coleção.
- **Portões:** permissão não; docs sim; admin sem impacto.

---

## F5 · Estado empacotado (absorvida pela FV)

> Mantida só como registro. O que esta fase descrevia é o modo *Petals* da FV, que não precisa de cluster. Não executar como fase separada.

**Portão de entrada:** F1 em uso, e a decisão D3 tomada com base num protótipo (uma tarde: fixar posições em espiral pelo console sobre a fixture de 1500 e olhar a tela em 3 zooms).

### Critérios

1. *Pack* numa coleção mostra todos os membros num disco com contorno, nome e contagem; a área do disco cresce com a contagem.
2. Aproximar faz aparecer os rótulos dos membros; afastar os esconde; nenhuma posição muda com o zoom.
3. Alternar fechada ↔ empacotada não move nenhum outro nó nem causa sobreposição com o hub.
4. Com cor por propriedade ligada, os membros empacotados mostram suas cores.
5. Em 3D, *Pack* oferece mudar para 2D.

### Arquivos

| Camada | Arquivo |
|---|---|
| Lógica pura | `utils/hubCollections.ts`: `packedOffsets(n, d)` + teste (distância mínima entre pares, determinismo) |
| Forças | `utils/forceConfig3D.ts`: raio de colisão próprio para nó de coleção |
| Canvas | contorno (um mesh por coleção empacotada), rótulo do contorno, membros sem esmaecimento de rótulo |
| Store | `arrangement` em `Cluster`; persistência |

### Riscos

| Risco | Mitigação |
|---|---|
| O settle headless (acima de 2000 arestas, `workers/layoutWorker.ts`) não conhece o raio de colisão novo | Passar o raio no dado do nó, que já vai para o worker |
| Contorno em 2D ortográfico e ordem de desenho | Reusar o padrão das guias de anel do ego |
| Rótulos de membros de discos vizinhos colidem | O filtro de sobreposição existente já decide; conferir na captura |

**Portões:** permissão não; docs sim, com captura; admin sem impacto.

---

## F6 · Experimentos (cada um com critério de saída)

| Experimento | Hipótese | Sai do papel se |
|---|---|---|
| Atlas de rótulos Latin-1 (L8) | Regerar o atlas MSDF com acentos não pesa no carregamento | O atlas novo ficar dentro do orçamento de tamanho atual e os testes de rótulo passarem. **Vale por si**, independente de coleções |
| Auto empacotar por zoom (4C) | Trocar fechada ↔ empacotada na câmera parada é imperceptível | Reconstrução abaixo de 100 ms com 2000 nós, sem movimento de nenhum outro nó, só em 2D, desligado por padrão |
| Coleção preguiçosa no servidor (1E) | Hubs de 50 mil vizinhos são um caso real dos usuários | Houver um contexto de produção com hub acima de 5 mil vizinhos |
| Motivo conector | Sócios com o mesmo conjunto de duas ou mais empresas formam grupos úteis | Num dado real de QSA, ao menos um terço dos não-folha cair em grupos de 3 ou mais |
| Empacotado em 3D | Disco orientado ao hub lê bem com rotação | Protótipo avaliado pelo `ux-reviewer` sem achado bloqueante |
| Grau real por membro (decisão D5) | Saber quais folhas têm vínculo não carregado muda a investigação | Consulta em lote de grau para 5 mil ids responder em tempo aceitável no warehouse real |
| `circular` e `grid` (L16) | — | Não fazer aqui: remover da lista ou implementar é limpeza separada |

---

## Verificação comum a todas as fases

1. `.claude/skills/skill_feature_creation/verify.sh` verde. Neste checkout a linha de backend falha por dependência ausente (`alembic`); rodar os pytest afetados à mão e relatar como ambiental.
2. Olhar a tela com a fixture do anexo, em 300 e 1500 folhas, antes e depois, e guardar as capturas ao lado das de [screens/](screens/).
3. Estados a capturar em toda fase com UI: vazio (hub sem folhas), um só grupo, muitos grupos, nomes longos, largura de 390 px.
4. `ux-reviewer` nas fases F1, F2 e F5.
5. Uma entrada no `decision_log` por fase, com os três portões respondidos.

## Anexo: fixture QSA da sonda

Para recriar a sonda: copiar para `frontend/e2e/tests/_hub-probe.spec.ts` (não commitar), usar `seedGraphResponse(page, buildQsa(N))` e `MOCK_CONTEXT`, e gravar as capturas **fora** de `test-results/`, que o Playwright apaga a cada execução.

```ts
const QUALS = ['Sócio', 'Acionista', 'Sócio-Administrador', 'Diretor', 'Conselheiro', 'Procurador'];

function buildQsa(leaves: number) {
  const nodes: any[] = [];
  const edges: any[] = [];
  let e = 0;
  const edge = (src: string, dst: string, type: string, props: Record<string, unknown> = {}) =>
    edges.push({ edge_id: `e${e++}`, src, dst, relationship_type: type, properties: props });

  nodes.push({ node_id: 'hub', node_type: 'Company', properties: { name: 'Banco Aurora S.A.', uf: 'SP' } });
  for (let c = 0; c < 6; c++) {
    nodes.push({ node_id: `co-${c}`, node_type: 'Company', properties: { name: `Holding ${c}`, uf: 'RJ' } });
  }
  for (let i = 0; i < leaves; i++) {
    const isCompany = i % 9 === 0;
    const id = `p-${i}`;
    const qual = QUALS[i % 7 === 0 ? 2 + (i % 4) : i % 2];
    nodes.push({
      node_id: id,
      node_type: isCompany ? 'Company' : 'Person',
      properties: { name: isCompany ? `Participações ${i} Ltda` : `Sócio ${i}`, qualificacao: qual },
    });
    edge(id, 'hub', qual === 'Diretor' || qual === 'Conselheiro' ? 'ADMINISTRA' : 'SOCIO_DE', {
      qualificacao: qual,
      percentual: Number((100 / leaves).toFixed(3)),
    });
    // 5% dos sócios também têm outras empresas: o sinal investigativo
    if (i % 20 === 3) {
      edge(id, `co-${i % 6}`, 'SOCIO_DE', { qualificacao: 'Sócio' });
      if (i % 40 === 3) edge(id, `co-${(i + 1) % 6}`, 'SOCIO_DE', { qualificacao: 'Sócio' });
    }
  }
  return { nodes, edges, truncated: false, total_count: edges.length };
}
```

Acesso aos stores a partir da sonda, em modo dev:

```ts
const app = (document.querySelector('#app') as any).__vue_app__;
const clusterStore = app.config.globalProperties.$pinia._s.get('cluster');
await clusterStore.executeProgram('default-orphan-clusters');
```

Com 1500 folhas no Chromium headless, o clique em *Fit* (`canvas-toolbar-fit`) às vezes estoura o tempo padrão de 10 s; aumentar o `actionTimeout` da sonda.
