# 03 · Design: coleções de vizinhos

> Proposta. Nada aqui está implementado. Os porquês estão em [02-opcoes-e-tradeoffs.md](02-opcoes-e-tradeoffs.md); a ordem de entrega, em [04-plano-de-implementacao.md](04-plano-de-implementacao.md).
> Números marcados **(inicial)** são pontos de partida a calibrar olhando a tela, não requisitos.

## A ideia em uma tela

```
            ANTES                                   DEPOIS

     · · · · · · · · ·                    ┌──────────────┐
   · · · · · · · · · · ·                  │ 114 Sócio PF │━━━━114━━━┓
  · · · · ·  HUB  · · · · ·     ──►       └──────────────┘          ┃
   · · · · · · · · · · ·                  ┌──────────────┐          ┃
     · · · · · · · · ·                    │ 102 Acion. PF│━━102━━━ HUB ─── p-23 ─── Holding 5
        │         │                       └──────────────┘          ┃  ╲
      p-23      p-83                      ┌──────────────┐          ┃   ╲── p-83 ─── Holding 0
        │         │                       │ 14 Sócio PJ  │━━━14━━━━━┛
   Holding 5  Holding 0                   └──────────────┘
```

Os vizinhos que só se ligam ao hub viram **coleções**: um objeto por (tipo de vínculo, tipo de nó, papel), com nome e contagem. Quem tem qualquer outro vínculo fica solto. Cada coleção pode estar fechada (um nó), empacotada (todos os membros juntos sob um contorno; aproximar revela) ou aberta (membros soltos).

## 1. Modelo

Uma coleção **é um `Cluster`** (`frontend/src/types/cluster.ts`). Não há tipo novo no canvas, no modal, na legenda nem na persistência. O que muda é de onde ela vem: de uma regra reavaliada, não de um programa executado uma vez.

```ts
// types/cluster.ts — campos novos, todos opcionais
interface Cluster {
  // ...campos atuais
  arrangement?: 'free' | 'packed';        // só vale com state === 'open'; ausente = 'free'
  collection?: {                          // presente só em coleções
    hub_id: string;
    relationship_types: string[];         // ordenados; mais de um se o membro tem dois vínculos com o hub
    direction: 'in' | 'out' | 'both';     // do ponto de vista do hub
    node_type: string;
    value?: string;                       // valor da propriedade de agrupamento, se houver
  };
}

interface CollectionRule {
  hub_ids: string[];                      // hubs que o usuário mandou agrupar
  auto: boolean;                          // true = todo hub acima do limiar (behavior de contexto)
  group_by_property?: { on: 'edge' | 'node'; name: string };   // ex.: edge.qualificacao
  min_size: number;                       // (inicial) 5
  excluded_node_ids: string[];            // membros que o usuário tirou
}

// ClusterStoreState ganha um campo; vai dentro de ExplorationState.clusters,
// que é `Optional[dict]` no backend (schemas.py:1040): sem migração.
interface ClusterStoreState {
  // ...programs, clusters, executions
  collections?: CollectionRule;
}
```

Identidade estável: `cluster_id = "col:" + hub_id + ":" + chave`, onde a chave é a junção de tipos de aresta, direção, tipo de nó e valor. É isso que deixa o estado (fechada, empacotada, aberta) sobreviver a uma reavaliação. `source_program_id = "builtin:hub-collections"`.

## 2. A regra

Função pura em `frontend/src/utils/hubCollections.ts`:

```ts
computeHubCollections(nodes, edges, rule, { hubThreshold }): CollectionSpec[]
```

1. **Hub**: nó em `rule.hub_ids`, ou, com `rule.auto`, todo nó com grau acima de `behaviors.degreeDimThreshold` (30, o limiar de hub que já existe).
2. **Folha de um hub**: nó cujo conjunto de vizinhos distintos, ignorando auto-arestas, é exatamente `{hub}`. Duas arestas para o mesmo hub (sócio e administrador) continuam sendo folha.
3. **Chave**: tipos de aresta do membro com o hub (conjunto ordenado), direção, `node_type` e, se configurado, o valor da propriedade. Sem valor: balde próprio "(sem valor)", contíguo, nunca espalhado (mesma regra das ordenações do ego).
4. Fica fora: quem está em `excluded_node_ids`; nó selecionado como foco do ego; grupo menor que `min_size` (esses membros ficam soltos).
5. Saída em ordem determinística (por contagem decrescente, desempate pela chave).

Um nó pertence a no máximo uma coleção, por construção. Isso evita contornos sobrepostos, que custam acerto [26].

**"Folha" é folha no que está carregado.** O texto da coleção diz o que agrupou, não o que falta: "114 Sócio · PF", descrição "ligados só a Banco Aurora entre os nós carregados". Quando a contagem real de vizinhos existir (seção 9), a coleção passa a separar quem tem vínculo não carregado.

## 3. Ciclo de vida

| Evento | O que acontece |
|---|---|
| Usuário pede "agrupar vizinhos-folha" num hub | `hub_id` entra em `rule.hub_ids`; a regra é avaliada; coleções nascem **fechadas** |
| Dados mudam por fusão (expandir, apagar nó, camada de dados do usuário) | A regra é reavaliada. Membro que ganhou um segundo vínculo sai da coleção. Folha nova entra. Estado de cada coleção é mantido pelo id |
| Consulta nova | Regra e coleções são descartadas, como os clusters hoje |
| Usuário tira um membro (lista ou menu) | Id entra em `excluded_node_ids`; o nó aparece solto ao lado do hub |
| Usuário desfaz o agrupamento do hub | `hub_id` sai da regra; membros voltam |
| Salvar e abrir exploração | Regra e estados vão em `ExplorationState.clusters`; ao abrir, a regra é reavaliada sobre os dados restaurados |

Isso exige trocar o watcher de `stores/cluster.ts:1121`, que hoje apaga todos os clusters quando `graphStore.nodes` troca de identidade (lacuna L9):

- consulta nova (`queryRunSeq` avançou): limpa, como hoje;
- qualquer outra troca: mantém os clusters, remove ids que deixaram de existir, descarta cluster que ficou vazio, e reavalia as coleções.

## 4. Aparência do nó de coleção fechada

Lista de conferência das diretrizes de agregados [10]:

| Diretriz | Decisão |
|---|---|
| Diz o que contém | Rótulo `"{contagem} {valor ou tipo de vínculo} · {tipo de nó}"`, por exemplo `114 Sócio · PF`. **Sempre visível**: coleções entram no conjunto de rótulos forçados de `useGraphLabels.ts:187`, com prioridade sobre rótulos de membro |
| Não se confunde com item | Forma `box` (como no Maltego) e a cor do tipo de nó dos membros; ícone do tipo, se houver |
| Tamanho honesto | Área proporcional à contagem, **sem o teto de 50** (`GraphCanvas3D.vue:512`) para coleções. Raio = `k·√n`, com `k` tal que fechada e empacotada ocupem o mesmo lugar (seção 7) |
| Uma aresta, com número | Arestas remapeadas para um cluster são sempre somadas (`aggregateParallelEdges`), independentemente de `aesthetics.sumParallelEdges`. Rótulo = contagem; espessura cresce com `log2(n+1)` |
| Interpretável | Nada de `cluster_orphan_<id>`: o nome usa o rótulo do hub e o valor do grupo |

Texto: o atlas de rótulos só tem ASCII (L8). O rótulo usa `114 Socio` até o atlas ganhar Latin-1; não usar "×". Estender o atlas é um item separado do plano porque afeta todo nome próprio em português, não só coleções.

## 5. Interação

| Gesto | Hoje | Proposto |
|---|---|---|
| Menu de contexto num **hub** | *Expand neighbors*, *Ego layout from here* | + **Group leaf neighbors** (ou *Ungroup* se já agrupado); visível quando o nó tem ao menos `min_size` folhas |
| Clique numa coleção fechada | Abre `ClusterNodeModal` | Igual (decisão D2 discute trocar por seleção + duplo clique) |
| Menu de contexto numa **coleção** | *Show only this cluster* | + **Open**, **Pack**, **Close**, **View members** |
| Menu de contexto num **membro** solto ou empacotado | — | + **Collapse back into ‹114 Sócio›**, **Remove from collection** |
| Linha do `ClusterNodeModal` | Seleciona | + botão **Pull out** (tira da coleção e enquadra) |
| Busca acha um membro de coleção fechada | A conferir no build | A coleção recebe marca "contém resultado"; focar o resultado tira o membro da coleção |
| Aviso | — | Quando um hub tem folhas suficientes e não está agrupado: "*Banco Aurora* tem 285 vizinhos-folha · **Agrupar**". Um aviso por hub, dispensável |

Seleção: selecionar uma coleção fechada seleciona o objeto coleção, não os membros. Ações em lote sobre membros (adicionar ao caso, exportar) saem do modal, que já tem a lista.

## 6. Abrir e fechar sem perder o mapa mental

Regra: **ao abrir ou fechar uma coleção, nenhum outro nó muda de lugar.**

- Abrir: os membros nascem em volta da posição do nó de coleção, em espiral determinística (seção 7), e ficam fixos. O nó de coleção some.
- Fechar: o nó de coleção nasce no centroide dos membros e fica fixo.
- Sem reaquecer a simulação. Hoje, em grafo pequeno (até 2000 arestas), qualquer mudança na contagem de nós dispara um novo layout global; só acima disso o canvas usa o posicionamento incremental (`GraphCanvas3D.vue:~960`, ramo `incrementallyPlaced`). A troca de estado de coleção tem de usar sempre o caminho incremental.
- Sem reenquadrar a câmera.

Verificação: teste que compara as posições de todos os nós que não são membros antes e depois da troca.

## 7. Estado empacotado (o zoom que revela)

Os membros são nós de verdade, na cena, dispostos em **espiral de girassol** [21] em torno do centro da coleção:

```
membro i (ordem estável: rótulo, depois id)
  ângulo = i × 137,508°
  raio   = c × √(i + 0,5)          c ≈ 0,55 × d,   d = distância mínima entre membros
raio do disco R = c × √n
```

- **Contorno**: um círculo translúcido de raio `R` atrás dos membros, mais o rótulo da coleção na borda de cima (forçado). Um mesh por coleção empacotada; são poucas.
- **Arestas** membro → hub: continuam sendo as arestas reais, uma por membro, na opacidade do degree dim. Formam uma cunha. Não é bundling: cada uma é reta e selecionável.
- **Zoom**: nada muda nos dados. Longe, o disco lê como uma mancha cuja área diz a contagem. Perto, cada ponto vira um nó com rótulo, pelo LOD de rótulos que já existe (limiar de 6 px em tela). Para isso, membro de coleção empacotada não recebe o esmaecimento de 0,2 no rótulo.
- **Cor**: como os membros são nós comuns, cor por propriedade ou por métrica funciona dentro do disco. É o que permite achar "os 3 vermelhos entre 300".
- **Espaço reservado**: o nó de coleção fechada usa raio de colisão `R` (hoje a colisão usa `cbrt(size)·relSize`, `forceConfig3D.ts:208`). Assim o layout já deixa lugar para o disco e alternar fechada ↔ empacotada não sobrepõe nada.
- **Só em 2D** na primeira versão. Em 3D a ação *Pack* oferece mudar para 2D.

Limite prático: empacotado desenha todos os membros. Acima de alguns milhares por coleção, o estado útil é fechada mais lista.

## 8. Ego layout

Incorpora [ego-crowded-rings-qsa.md](../ego-crowded-rings-qsa.md):

1. **Ego enxerga clusters** (fase B1 daquele plano): `computeTreeLayout` recebe os nós e arestas que o canvas desenha (`filteredNodes`/`filteredEdges` do canvas, que são `enhancedNodes`/`enhancedEdges`), não `graphStore.nodes/edges`. A coleção fechada entra no anel 1 como um nó. Se o foco estiver dentro de uma coleção fechada, o painel avisa em vez de abrir sozinho.
2. **Sub-anéis** (fase A): anel lotado se quebra em faixas concêntricas; ângulos não mudam.
3. **Empacotada no ego** não tem geometria própria: é a coleção aberta com `ringOrdering` pela chave da coleção, que dá um setor contíguo com sub-anéis. O aviso de anel lotado sugere isso.
4. Tamanho do slot: uma coleção fechada ocupa um slot de arco proporcional ao seu raio (hoje o arco mínimo é por nó, fixo em 26).

O determinismo é mantido: nenhuma força, nenhuma aleatoriedade, mesma entrada dá a mesma figura.

## 9. Expansão seletiva

### Contagem antes de carregar

```
POST /api/graph-contexts/{id}/neighbor-summary
  { "node_id": "..." }
→ { "total_edges": 4312,
    "buckets": [
      { "relationship_type": "SOCIO_DE",   "direction": "in",  "edges": 4100 },
      { "relationship_type": "ADMINISTRA", "direction": "in",  "edges": 212 }
    ] }
```

- Fonte SQL: um `GROUP BY` do tipo de relação e da direção sobre a tabela de arestas, filtrado pelo nó. O tipo do vizinho exigiria junção com a tabela de nós; fica fora da primeira versão.
- Neptune e REST: implementar onde for barato; senão a fonte declara que não suporta, como já ocorre com `supportsExpand`, e a UI cai no comportamento de hoje com aviso de corte.
- É leitura: sem permissão nova. Por ser `POST`, entra em `AUDIT_EXEMPT_ROUTES` com o motivo (ver portões no plano).

### Diálogo

- Expandir um nó com até 50 arestas **(inicial, o valor do Linkurious)**: direto, como hoje.
- Acima disso: diálogo com uma linha por balde (tipo, direção, contagem, caixa de seleção), limite por balde e o total que será carregado. Confirmar chama `expand` com `edge_types` e `directed`, que o backend já aceita.
- Depois de carregar, o nó guarda "carregados N de M" e mostra um selo enquanto N < M. O selo some quando tudo foi carregado.
- `truncated` da resposta deixa de ser ignorado: vira aviso.

### Correção de semântica (independente do diálogo)

Em profundidade 1 (`sql_warehouse.py:466-530`): o limite passa a valer primeiro para as arestas do próprio nó, em ordem estável; arestas entre os vizinhos entram depois, até o limite. Hoje um hub com muitos vizinhos interligados pode voltar sem nenhuma das suas próprias arestas.

## 10. Resumo de vizinhos no painel do nó

Nova seção em `components/SelectionDetails.vue`, só com dado carregado (precedente interno: `EntityPage.vue:35-42` do caso):

```
Vizinhos (300 carregados de 4 312)
  SOCIO_DE ← Person      255   [agrupar] [mostrar só] [selecionar]
  SOCIO_DE ← Company      30   [agrupar] ...
  ADMINISTRA ← Person     15   ...
  ─ dos quais folhas: 285 · com outro vínculo: 15 [selecionar]
```

"Com outro vínculo: 15 [selecionar]" é o atalho para a pergunta do investigador.

## 11. 3D

Fechada e aberta funcionam em 3D como em 2D. Empacotada é só 2D na primeira versão. Rótulo de coleção forçado vale nos dois modos.

## 12. Compatibilidade

- Explorações salvas antes disso não têm `collections` nem `arrangement`: carregam como hoje.
- Clusters de programa continuam existindo e não são afetados, exceto por dois ganhos gerais: não são mais apagados numa expansão, e suas arestas para o hub passam a ser somadas.
- *Orphan Clusters* embutido continua disponível; a documentação passa a apontar para a ação nova.
- MCP e REST de exploração: `clusters` é repassado opaco; nada muda no servidor para as fases de coleção.

## 13. Valores iniciais

| Parâmetro | Valor | Origem |
|---|---|---|
| Limiar de hub | grau > 30 | `degreeDimThreshold` existente |
| Tamanho mínimo de coleção | 5 | sonda; Maltego usa 25 |
| Limiar do diálogo de expansão | 50 arestas | Linkurious |
| Distância mínima entre membros empacotados | 26 | `EGO_MIN_NODE_ARC` existente |
| Limiar de rótulo de membro | 6 px de raio em tela | `labelSizeThreshold` existente |
| Aviso de anel lotado | 80 nós | plano do ego |

## Anexo: programa de coleções usado na sonda

Rodou como programa de cluster comum, sem mudança no app, e gerou as capturas 5, 6, 7 e 11. Serve de protótipo e, depois, de exemplo na documentação de programas.

```js
// Leaf neighbours of each hub, grouped by (edge type, node type, property)
const MIN = params.min_size ?? 5;
const adj = new Map();
const viaType = new Map();
for (const e of edges) {
  if (e.src === e.dst) continue;
  for (const [a, b] of [[e.src, e.dst], [e.dst, e.src]]) {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a).add(b);
  }
  viaType.set(e.src + '|' + e.dst, e.relationship_type);
  viaType.set(e.dst + '|' + e.src, e.relationship_type);
}
const byId = new Map(nodes.map(n => [n.node_id, n]));
const groups = new Map();
for (const n of nodes) {
  const nb = adj.get(n.node_id);
  if (!nb || nb.size !== 1) continue;
  const hub = [...nb][0];
  const rel = viaType.get(n.node_id + '|' + hub);
  const q = n.properties?.qualificacao ?? '(sem qualificação)';
  const key = [hub, rel, n.node_type, q].join('\u0001');
  if (!groups.has(key)) groups.set(key, { hub, rel, type: n.node_type, q, ids: [] });
  groups.get(key).ids.push(n.node_id);
}
const out = [];
for (const g of groups.values()) {
  if (g.ids.length < MIN) continue;
  const hubName = byId.get(g.hub)?.properties?.name ?? g.hub;
  out.push({
    cluster_name: g.ids.length + ' ' + g.q + ' (' + g.type + ')',
    cluster_class: 'collection',
    figure: g.type === 'Company' ? 'box' : 'circle',
    state: 'closed',
    node_ids: g.ids,
    description: g.ids.length + ' ' + g.type + ' ligados só a ' + hubName + ' por ' + g.rel + ' / ' + g.q,
  });
}
return out;
```

Na sonda o nome usava "×" entre a contagem e o valor; foi trocado aqui por espaço por causa de L8.

Diferenças para a regra da seção 2: não exige que o vizinho único seja um hub, não trata dois vínculos com o mesmo hub, tem a propriedade fixa no código e gera ids aleatórios a cada execução.
