# Anéis lotados no layout ego (QSA: empresa com centenas de sócios)

> Status: **proposta** (não implementada). Análise de 2026-08-28. Pasta `docs/dev/` está fora do site VitePress (`srcExclude: dev/**`).

## Contexto

No domínio QSA (Quadro de Sócios e Administradores), uma empresa pode ter centenas de sócios. No layout ego, todos caem no anel 1 (hop 1). Hoje o único mecanismo anti-aglomeração é o crescimento do raio: `radius = max(prevRadius + ringSpacing, count·26/2π, 26/minCircularGap)` em [layoutModes.ts:741-781](frontend/src/utils/layoutModes.ts#L741-L781), com arco mínimo `EGO_MIN_NODE_ARC = 26` hard-coded em [GraphCanvas3D.vue:89](frontend/src/components/GraphCanvas3D.vue#L89). Com 300 sócios, o anel 1 ganha raio ≈ 1240 — um círculo enorme: nós minúsculos após zoomToFit, labels ilegíveis, e o padrão investigativo relevante (os poucos sócios com OUTROS vínculos) fica indistinguível dos ~290 sócios-folha que são ruído.

Restrições de produto (decision_log [2026-07-20]): edge bundling, fade por densidade e filtro por grau foram **rejeitados** — investigador não pode ter dados escondidos silenciosamente. Agregação explícita com expand/collapse e contagem (cluster nodes) É um padrão aceito do produto. O layout ego é determinístico e pinado (sem forças) — garantia de produto; qualquer correção de espaçamento deve ficar pura dentro de `computeTreeLayout`.

## Avaliação das opções (usabilidade / UX / apoio à investigação)

| Opção | Usabilidade | UX | Investigação | Veredito |
|---|---|---|---|---|
| **A. Sub-anéis concêntricos** (wrap do anel lotado em K faixas, espelhando o wrapping em sub-linhas que o modo `layered` já tem em [layoutModes.ts:821-871](frontend/src/utils/layoutModes.ts#L821-L871)) | Anel legível em qualquer densidade; raio cresce ~√N em vez de ~N | Mantém a metáfora radial; determinístico; puro e testável | Neutro-positivo: todos os nós visíveis, nada escondido | **Recomendada — fase A** |
| **B. Agregação de folhas via cluster system existente** (nó-cluster "N sócios sem outros vínculos" no anel 1, expand/collapse explícito) — padrão "supernode" de Linkurious/KeyLines | 300 nós → ~14 objetos no anel | Contagem visível, expansão sob demanda; reusa stores/cluster.ts + programa ORPHAN_CLUSTERS | **Maior valor**: destaca exatamente os sócios multi-vinculados (alvos da investigação) | **Recomendada — fase B** |
| **C. Ordenação do anel por propriedade** (ex.: qualificação do sócio) | Já existe (`ringOrdering: 'property'`) | Sem mudança de código | Agrupa visualmente categorias de sócio | Documentar/sugerir — fase C |
| **D. Avisos e affordances no painel** ("Anel 1 tem 312 nós — agrupe folhas") via `egoLayoutStats` | Guia o usuário à ação certa | Canal de hints já existe | Indireto | Complemento — fase C |
| E. Aumentar/expor `minNodeArc` como config | Ajuste fino apenas | Slider a mais | Não resolve N=300 | Só como sub-item da fase A |
| F. Edge lens (dim/hide no hover) | Já existe e já é sugerido no painel ego | — | Ajuda leitura do interior, não do anel | Já coberto |
| G. Fisheye/lens de magnificação | Alto custo, quebra determinismo/comparabilidade | Interação não trivial em 3D ortho | Distorce distâncias | **Rejeitada** |
| H. Filtro por grau / fade por densidade / bundling | — | — | Esconde dados do investigador | **Rejeitada** (já vetada no decision_log 2026-07-20) |

**Recomendação**: A + B são complementares e podem ser entregues de forma independente. A conserta a geometria para qualquer grafo denso; B ataca o problema investigativo do QSA (separar sinal de ruído). C/D são acabamento de UX de baixo custo.

## Implementação

Ordem recomendada: **B1 → A → B2 → C**. B1 é o menor diff e corrige um bug real (nós-cluster hoje ficam flutuando fora dos anéis no ego); A conserta a geometria para qualquer densidade. A e B são independentes e podem ser entregues separadamente.

### Fase B1 — Ego ciente de clusters (~10 linhas, maior valor investigativo)

O ego lê `graphStore.nodes/edges` cru, mas o canvas renderiza `enhancedNodes/enhancedEdges` (substituição de clusters). Verificado: `displayNodes = nodes` sem filtro extra, então alimentar o dado enhanced é puramente ganhar consciência de cluster; e abrir/fechar cluster já dispara re-layout pelo watcher de dados existente ([GraphCanvas3D.vue:1397-1425](frontend/src/components/GraphCanvas3D.vue#L1397-L1425)).

1. Nos branches ego (~[GraphCanvas3D.vue:1625](frontend/src/components/GraphCanvas3D.vue#L1625)) e hierarchical (~:1693, mesmo bug), passar `filteredNodes.value/filteredEdges.value` (os arrays que o canvas renderiza) para `computeTreeLayout`. Nenhum caso especial para `__cluster__`: o cluster fechado é só um nó com arestas remapeadas ([graph.ts:887-929](frontend/src/stores/graph.ts#L887-L929)) — o BFS o coloca no anel 1 como um cidadão; seus 287 membros não estão no input.
2. Guard do focus (~:1617): se o focus existe em `graphStore.nodes` mas não no conjunto enhanced, ele foi engolido por um cluster fechado → hint no painel ("abra o cluster para focar aqui"), sem auto-abrir.
3. `computeEgoLinkCurvatures` já tem fallback `Math.hypot` e pula endpoints sem posição — arcos funcionam sem mudança.

Resultado QSA: rodar o programa ORPHAN_CLUSTERS existente transforma "300 sócios" em 1 nó-cluster "287 sócios sem outros vínculos" + os ~13 sócios multi-vinculados individualmente no anel — exatamente os alvos da investigação, nada escondido (contagem visível, expand sob demanda).

### Fase A — Sub-anéis concêntricos (matemática pura em `computeTreeLayout`)

Insight estrutural: no branch radial, **ângulos dependem só de slots, nunca do raio** — o wrapping varia apenas o raio por nó, preservando por construção contiguidade de setores, ring ordering e redução de cruzamentos.

1. **Config** ([types/graph.ts:388-422](frontend/src/types/graph.ts#L388-L422), defaults em [graph.ts:163-198](frontend/src/stores/graph.ts#L163-L198)): `minNodeArc: number` (promove o hard-coded 26) e `ringWrap: 'auto' | 'off'` (default `'auto'`). Seguir a receita do `hideRingLabels` (decision_log ~7639). NÃO adicionar ao `LAYOUT_OVERRIDE_SCHEMA` (aparência). Atualizar literais em `contextReferences.test.ts`.
2. **Math** ([layoutModes.ts:741-781](frontend/src/utils/layoutModes.ts#L741-L781) + anel unreachable :784-820): `TreeLayoutOptions.ringWrap` (default `'off'` no util — callers hierarchical/hive e testes antigos intactos). Trigger: `singleRadius > innerBase + 1.5·levelSpacing`. K por fórmula fechada de capacidade; `subRingSpacing = nodeSpacing·0.8` (precedente do branch layered). **Atribuição round-robin por ordem angular** (nó i → sub-anel i % K; empates por id): vizinhos angulares caem em sub-anéis diferentes (gap ~K×), ângulos intocados. Raio exato: por sub-anel j, `req_j = max(capacityRadius_j, nodeSpacing/minCircularGap(angles_j))`; `R = max(innerBase, max_j(req_j − j·s))`; próximo hop parte de `R + (K−1)·s`. Invariantes: determinismo, bandas monotônicas, arco mínimo por sub-anel, ângulos idênticos a `'off'`.
3. **Stats/guias**: `TreeLevelStat.offset` = raio externo da banda (mantém `computeEgoLinkCurvatures` sem mudança de semântica); adicionar `innerOffset?`/`subRingCount?`. `computeRingGuideSpec`: um círculo-guia por hop, label ganha `· N rows` quando wrapped. Curvaturas: endpoints do mesmo hop em sub-anéis diferentes usam o branch cross-ring existente (edit contido ~:1134-1163).
4. **Call site + painel**: `GraphCanvas3D.vue:1631` passa `minNodeArc`/`ringWrap` do config; deletar `EGO_MIN_NODE_ARC`. `LayoutPanel.vue` Advanced: slider "Min node spacing" (12–60) + checkbox "Wrap crowded rings" (testids `ego-min-node-arc`, `ego-ring-wrap`).

### Fase B2 — Botão "Agrupar folhas" (opcional, reusa 100% da máquina existente)

`LayoutPanel.vue` bloco ego: botão que chama `clusterStore.executeProgram(ORPHAN_CLUSTERS)` (idempotente — clusters do mesmo programa são substituídos, [cluster.ts:446-450](frontend/src/stores/cluster.ts#L446-L450)); re-layout automático. Testid `ego-group-leaves-btn`.

### Fase C — Avisos, docs, screenshots

1. `egoLayoutStats` ([graph.ts:418-428](frontend/src/stores/graph.ts#L418-L428)) ganha `crowdedRing: {level, count, subRingCount} | null` (threshold ~80); hint no painel: "Anel 1 tem 312 nós — agrupe folhas ou ordene por propriedade (ex.: qualificação do sócio)".
2. Docs: seção "Ego layout" em `docs/guide/exploring-the-graph.md` (crowding, wrapping, workflow de agrupar folhas, `ringOrdering:'property'` com qualificação do sócio como exemplo); cross-links de `layout-url-overrides.md` e `clusters.md`; atualizar cena `ego` em `frontend/e2e/screenshots/generate.ts`; `make docs-build`.
3. Entradas no decision_log por fase (obrigatório), registrando o break de compat deliberado do `ringWrap:'auto'` (explorações antigas passam a renderizar wrapped — melhor) e o racional "wrapping é espaçamento, clustering é significado — eles compõem".

## Testes / Verificação

- **Unit (layoutModes.test.ts)** — o teste-contrato em :387 (estrela de 100 folhas, raio ≥ 414) muda de semântica com auto-wrap: **dividir explicitamente** em caso `ringWrap:'off'` (asserções atuais, guarda de regressão) + caso `'auto'` (raio externo ≪ 414, `subRingCount > 1`). Novos: ângulos idênticos wrap on/off; distância mínima par-a-par ≥ `min(nodeSpacing, subRingSpacing) − ε`; bandas monotônicas com 2 anéis lotados; determinismo (deep-equal em 2 runs); wrap do anel unreachable; guide spec (1 círculo/hop, label com rows, `hideLabels` ainda anula); curvaturas cross-sub-ring finitas; anéis pequenos byte-idênticos a `'off'`; fixture com nó `__cluster__` no anel 1 (B1).
- **Store/Panel tests**: cluster fechado de folhas hop-1 → `enhancedEdges` pendura o cluster no focus; botão chama `executeProgram`; hint de focus-em-cluster; slider/checkbox despacham `updateLayoutModeConfig`.
- **E2E/screenshot**: cena `SCENES` ego+clusters; user-journey só se B2 entrar.
- **Suite**: `npm run test:run` a cada fase; `make docs-build` na fase C; teste manual com fixture QSA (hub + 300 folhas) via dev-generator.

## Riscos

- Esferas de cluster são maiores que nós comuns — `minNodeArc` é por slot; aceitar para v1, anotar "arc weight por nó" como follow-up.
- Empilhamento radial na banda pode ser lido como hops extras — mitigado por `subRingSpacing (~21) ≪ ringSpacing (60)` + círculo-guia único por hop; validar na cena de screenshot.
- Overlap de labels em bandas densas — checar no teste manual (zoomToFit só melhora: extents menores).

## Fontes externas consultadas

- Linkurious: supernode threshold + expansão filtrada de vizinhos — https://doc.linkurious.com/user-manual/latest/expand/
- yFiles radial layout (anéis concêntricos, distribuição hierárquica) — https://www.yfiles.com/the-yfiles-sdk/features/automatic-layouts/radial-layout
- yFiles fraud detection (grouping/nesting para investigação) — https://www.yfiles.com/solutions/use-cases/fraud-detection-through-visualization
- Node grouping para AML (arxiv 2605.10522) — https://arxiv.org/html/2605.10522
- Yee et al., radial layout animado de exploração — https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/yee01animated.pdf
