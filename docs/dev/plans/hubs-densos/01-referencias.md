# 01 · Referências: literatura e o que os produtos entregam

> Levantamento de 2026-11-13. Comportamento de produto vem da documentação oficial consultada nesse dia, salvo indicação.
> Os números de Dunne & Shneiderman (2013) e de Dwyer et al. (2013) foram lidos nos PDFs dos artigos.
> Os demais resumos combinam dado bibliográfico confirmado por busca com conhecimento prévio dos artigos.
> O que não foi possível confirmar está marcado **(não conferido)**.

## O que tirar daqui

1. **Ninguém resolve com uma técnica só.** As ferramentas de investigação convergem em quatro peças: expansão limitada ou seletiva na consulta; colapso das folhas "sem graça" do mesmo tipo num nó de coleção com contagem; uma lista dos membros, de onde se puxa um para fora; e nível de detalhe nos rótulos.
2. **Os dois precedentes mais próximos** são as *collection nodes* do Maltego e o *Collect Nodes* do GraphXR (este, uma ferramenta 3D em WebGL como a nossa).
3. **A melhor evidência experimental** é a favor de fundir folhas estruturalmente equivalentes: melhora visão geral e busca. O custo aparece em contar e comparar vizinhos.
4. **Não há evidência de que um force layout melhor resolva uma estrela de mil folhas.** A evidência favorece reduzir o número de entidades na tela.

## 1. Literatura

### Grau de interesse (DOI)

| Trabalho | Ideia | O que implica para nós |
|---|---|---|
| Furnas, *Generalized fisheye views*, CHI 1986 [1] | DOI(x \| foco) = importância a priori − distância ao foco; só aparece o que passa de um limiar (fórmula de memória; os dois componentes foram confirmados) | Ordenar os vizinhos de um hub por uma nota e mostrar os k primeiros |
| van Ham & Perer, *Search, Show Context, Expand on Demand*, InfoVis 2009 [2] | Em vez de "visão geral primeiro": buscar um foco, extrair um subgrafo conexo de DOI máximo com orçamento fixo de nós, e dar pistas visuais de onde ainda há o que expandir | Orçamento de nós por vista; marca "há mais N" nos nós truncados |

### Equivalência estrutural e fusão de folhas

**Dunne & Shneiderman, *Motif simplification*, CHI 2013 [3].** Troca três motivos por glifos: leque (folhas com um mesmo vizinho único), conector (nós com o mesmo conjunto de dois ou mais vizinhos) e clique. Estudo com 36 participantes, entre grupos, 31 perguntas, 3 redes reais.

| Com glifos, melhorou | Com glifos, piorou |
|---|---|
| Achar o maior leque: 7,77 s mais rápido em média (p<0,01); 95% acertaram contra 35% na rede grande | Comparar número de vizinhos: 9 a 11 s mais lento e menos preciso (53% contra 82% numa das redes) |
| Erro no tamanho do leque: 2% contra −62% | Tarefas de vizinho em comum e parte das de caminho mínimo |
| Achar rótulos fora dos motivos: 19,93 s mais rápido; 97,5% contra 14,5% de acerto | Muitos participantes tiveram dificuldade de entender a topologia dentro do glifo fechado |
| Estimar o tamanho da rede: erro de −8% contra −47% (porém mais lento) | |

O estudo rodou sem arestas agregadas com espessura proporcional; os autores as acrescentaram depois.

**Dwyer, Henry Riche, Marriott & Mears, *Edge compression techniques*, InfoVis 2013 [4].** Compara três esquemas sem perda: fundir nós com conjunto de vizinhos idêntico (*matching neighbours*), decomposição modular e *power graphs*.

- Experimento 1 (15 não especialistas, tarefas de caminho, grafos de até 30 nós): acerto de 85 a 90% em todas, sem diferença significativa. Decomposição modular foi 36% mais rápida que nó-aresta puro; *matching neighbours*, 23% mais rápida.
- Experimento 2 (14 participantes, *power graphs*): o acerto caiu para 66% quando muitas arestas cruzam a fronteira dos módulos, contra 84 a 85% com poucas.
- Implicação: fundir por conjunto de vizinhos é barato e seguro; **o que machuca são arestas que cruzam a fronteira do grupo.**

Outros da mesma família:

- Royer et al., *power graph analysis*, PLoS Comput Biol 2008 [5]: nós e arestas de potência para estrelas, bicliques e cliques; até 85% menos arestas em redes de proteínas.
- Bach et al., *confluent drawings*, TVCG 2017 [6]: agrupamento de arestas sem ambiguidade sobre decomposição em *power graph* (números do estudo não recuperados).
- Wattenberg, *PivotGraph*, CHI 2006 [7]: nós enrolados numa grade de valores de atributo, com arestas agregadas.
- Shneiderman & Aris, *semantic substrates*, TVCG 2006 [8]: nós em regiões sem sobreposição definidas por atributo.
- Shi et al., *OnionGraph* [9]: abstração em camadas (por atributo, depois por equivalência estrutural forte, depois regular), com um glifo que diz o nível.

### Agregação hierárquica e meta-nós

**Elmqvist & Fekete, TVCG 2010 [10]** dão seis diretrizes para agregados. Servem de lista de conferência para o nosso nó de coleção:

| | Diretriz | Como estamos hoje |
|---|---|---|
| G1 | Orçamento de entidades: teto para o que aparece | Não há |
| G2 | Resumo visual: o agregado diz o que contém | Falha: sem contagem legível, sem composição |
| G3 | Simplicidade visual | Ok |
| G4 | Discriminável: agregado não se confunde com item | Parcial: forma diferente só se o programa escolher |
| G5 | Fidelidade | Ok (nada é inventado) |
| G6 | Interpretável | Falha: nome técnico, uma cor só |

Outros: GrouseFlocks e TugGraph (Archambault, Munzner & Auber) [11], hierarquias guiadas pelo usuário cujos meta-nós preservam caminhos; ASK-GraphView [12], navegação por clusters em grafos de até 16 milhões de arestas; NodeTrix [13], comunidades densas como matrizes dentro do diagrama; Vizster, Refinery e Apolo [14], exploração de baixo para cima com vizinhos ordenados por relevância em vez de todos (o veículo do Apolo é de memória, **não conferido**); Vehlow, Beck & Weiskopf [15], levantamento sobre estruturas de grupo.

### Zoom semântico e nível de detalhe

- Gansner, Koren & North, *Topological fisheye views*, TVCG 2005 [16]: hierarquia de simplificação pré-calculada; detalhe total perto do foco, grosso longe.
- Nachmanson et al., *GraphMaps*, GD 2015 [17]: cada nó recebe um nível de zoom conforme a importância, como cidades num mapa; o layout não muda com o zoom.
- *Graph Thumbnails* (Yoghourdjian et al., TVCG 2018) e *BigGraphVis* (Moradi & Mondal, 2021) [18]: resumos em super-nós por decomposição k-core e por detecção de comunidade.

### Respostas só de layout

- Yee et al., layout radial animado, InfoVis 2001 [19]: foco no centro, anéis por distância.
- Rodrigues et al., *Group-in-a-Box*, SocialCom 2011 [20]: uma caixa de treemap por grupo, com área proporcional ao número de vértices.
- *PhylloTrees* (2004) [21]: filhos empacotados em espiral de girassol (ângulo de 137,5°); não sobrepõe e não precisa saber a contagem de antemão. Não foi encontrado uso de filotaxia para folhas de uma estrela ego em ferramenta de investigação.
- Redes ego dinâmicas: 1.5D, egoSlider, EgoLines [22].
- Ehlers et al., *Me! Me! Me! Me!*, Computers & Graphics 2024 [23]: compara nó-aresta em linha reta, radial e em camadas, e matriz, em seis tarefas de rede ego. Pelo resumo, recomenda o diagrama em camadas; a matriz foi a mais difícil de entender. **Atenção:** o `decision_log` (2026-07-20) cita o mesmo artigo como "sem diferença significativa de desempenho entre radial, em camadas e linha reta". As duas leituras não foram reconciliadas nesta rodada; os números por tarefa não foram recuperados.

### Outros resultados empíricos

- Ghoniem, Fekete & Castagliola, InfoVis 2004 [24]: acima de uns 20 nós, matriz ganha de nó-aresta na maioria das tarefas, menos achar caminho.
- Yoghourdjian et al., levantamento de 2018 [25]: a maioria dos estudos controlados usa grafos de 100 nós ou menos.
- Jianu et al., TVCG 2014 [26]: contornos de grupo sobrepostos custam até 25% de acerto em tarefas de rede (fonte secundária).
- Archambault, Purchase & Pinaud, CGF 2010 [26]: meta-nós que abrem e preservam caminho não mostraram ganho nem perda claros contra nó-aresta puro (fonte secundária).

### Vistas que não são nó-aresta

- Nobre, Streit & Lex, *Juniper*, InfoVis 2018 [27]: árvore geradora alinhada a uma tabela de atributos e adjacência; nós de grau alto viram linhas agregadas.
- van den Elzen & van Wijk, InfoVis 2014 [27]: seleções agregadas em nós de visão geral.

### 3D

- Ware & Mitchell (2008) [43]: seguir caminhos em 3D só fica abaixo de 10% de erro até 333 nós com estéreo e movimento juntos; 3D monoscópico não foi melhor que 2D.
- Greffard et al., GD 2011 [43]: para detectar comunidades, 2D foi a condição mais rápida em todos os tamanhos.
- Kwon et al., TVCG 2016 [44]: pistas monoculares de profundidade são perspectiva, oclusão, paralaxe de movimento e sombreamento.
- **Não existe "nível de zoom" estável em 3D.** Na prática aparecem três famílias de gatilho:
  1. **Distância da câmera** ao objeto ou ao centroide do grupo (é como `THREE.LOD` funciona; o ExplorViz testa centroides de cluster em vez de cada objeto [45]). Falha quando o campo de visão muda e ignora o tamanho do objeto.
  2. **Tamanho projetado em tela**, aproximadamente r / (d·tan(fov/2)), com histerese para não piscar. O limiar de 6 px do Sigma é o análogo 2D. **É o que o nosso LOD de rótulos já usa.**
  3. **Orçamento por quadro**: os N rótulos mais próximos, ou os N melhores no frustum (projetos derivados do 3d-force-graph [42]; limite de 30 do Cosmograph [41]). Limita o custo qualquer que seja a cena.

## 2. Produtos

### Maltego: collection nodes [28] (precedente principal)

| Aspecto | Comportamento |
|---|---|
| Padrão | Ligado; há um botão para desligar e ligar as coleções |
| O que entra | Só entidades do mesmo tipo. "Semelhante" não é definido formalmente; a documentação diz que se resume a ter pais e filhos em comum (equivalência estrutural aproximada) |
| Tamanho mínimo | **25 entidades** por padrão (controle deslizante) |
| Exceções | Entidade fixada (pin) nunca é coletada; entidade arrastada para o grafo nasce fixada; entidade com nota ou anexo fica fora |
| Regras | De vizinho: um pai com muitos filhos coleta os filhos. De cadeia: pares paralelos sob um pai comum formam duas coleções ligadas; dispara em limite × 1,5 |
| Aparência | Coleção é quadrada, com contagem; entidade comum é círculo |
| Lista de detalhe | Ordenável e filtrável; pin por linha puxa a entidade para fora; duplo clique enquadra e pisca; sincroniza seleção com o grafo |
| Seleção | Borda cheia = tudo selecionado; tracejada = parte |
| Despin | A entidade só volta para a coleção se ainda cumprir os critérios |

### Kineviz GraphXR (3D, WebGL) [29]

- **Collect Nodes:** para os nós selecionados, os vizinhos presos por uma única aresta (folhas) vão para nós de coleção. O painel da coleção lista os membros e deixa tirar e repor. *Explode Collections* devolve os membros.
- Desde a versão 2.13 (fev/2022); tabela de coleções na 2.15; "arestas de coleção" na 2.17, locais e não gravadas no banco.
- É **acionado pelo usuário**: não foi encontrado limiar de colapso automático nem regra documentada de LOD de rótulos.
- Layouts para estrela: anel ou árvore em torno da seleção, grade, cubo, esfera e espiral, com "ordenar por" uma propriedade.

### Linkurious Enterprise e Ogma [30]

- `expandThreshold` = **50**: acima disso, expandir abre o diálogo de expansão seletiva.
- `supernodeThreshold` = **10 000** arestas: acima disso, o diálogo lista só categorias e tipos de relação disponíveis.
- Diálogo: categoria, tipo de aresta, modo (vizinhos, mais conectados, menos conectados) e quantidade máxima.
- Super-nó tem um selo "+" com a contagem; expansão em lote é bloqueada se a seleção contém um.
- Agrupamento de nós (4.0+): regra por **uma** propriedade, uma regra ativa por vez; grupo nasce fechado, círculo cinza com selo "×N"; duplo clique alterna.
- Ogma: `addNodeGrouping` (com `restorePositions`), `addEdgeGrouping` (só paralelas), `addNeighborMerging` (dobra o dado da folha no vizinho).

### Cambridge Intelligence: KeyLines e ReGraph [31]

- *Combos*: fechados por padrão com glifo de contagem; duplo clique alterna; aninháveis; as ligações se fundem em "combo links".
- **Arranjos para combo aberto**: lente (padrão), concêntrico, grade, sequencial. É o precedente do nosso estado "empacotado".
- Itens dentro de combo fechado não podem ser selecionados, e a API de análise só enxerga o nível de cima.
- O texto sobre o efeito *starburst* recomenda: remodelar o super-nó; limitar a expansão e deixar escolher tudo, parte ou nada; expandir por tipo; pontuar por grau e pular folhas; pôr folhas em combos; layouts que deixam as folhas em círculos justos ou empilhadas em grade.

### Neo4j, Memgraph, Graphileon [32]

- Bloom: expansão limitada pelo *node query limit*; "expansão avançada" escolhe tipos de relação e rótulos do vizinho. O padrão de 1000 vem só de resposta em fórum (**não conferido**).
- Browser: `maxNeighbours` 100 nas versões antigas; `maxNewNeighbours` 100 nas atuais (**visto em resumo de busca, não na página**).
- Memgraph Lab: pede confirmação para desenhar a partir de 3 500 nós ou 8 500 relações; sem agrupamento.
- **Graphileon**: painel de vizinhos em árvore (direção, rótulo, tipo de relação) com contagem e um [+] por balde. É o padrão "facetar, depois carregar".

### Palantir, i2, yFiles [33][34][35]

- Vertex (Foundry): agrupar selecionados num nó, com lista de membros e desagrupamento parcial; agrupar por valores de histograma; objetos transacionais dobrados sobre arestas com selo de contagem. Gotham: sem documentação pública (**não conferido**).
- i2 Analyst's Notebook: *List Most Connected*; fundir entidades; layouts agrupado e *Peacock*.
- yFiles: dobra de nós de grupo; demos de nível de detalhe e de esmaecer rótulo por zoom; algoritmo de agregação de nós; orientação de começar com 20 a 50 nós e revelar aos poucos.

### Bibliotecas [36]–[42]

- Graphistry: filtros por histograma, teto de rótulos (`pointsOfInterestMax`).
- **Gephi removeu os meta-nós na 0.9.0** porque, segundo os desenvolvedores, o ferramental de exploração "nunca amadureceu". Aviso sobre o custo de manter a feature pela metade.
- Cytoscape.js: nós compostos com `expand-collapse`; o plugin mais novo refaz o layout a cada operação para preservar o mapa mental.
- Sigma.js: rótulos em grade (`labelGridCellSize` 100, `labelDensity` 1, `labelRenderedSizeThreshold` 6 px, `forceLabel` fura o limiar). O nosso LOD de rótulos é desse modelo.
- Cosmograph: rótulos dinâmicos com limite de 30; rótulo de cluster tem prioridade sobre rótulo de ponto.
- 3d-force-graph (nossa base): o exemplo de nós expansíveis marca `collapsed` e realimenta `graphData()`. Não tem agrupamento nem LOD de rótulo. Trocar a identidade dos nós reconstrói todos os objetos.

### Sem informação pública

Sayari, OpenCorporates e DataWalk: nada documentado sobre hubs (**não conferido**).

## 3. Limites deste levantamento

- Padrão de 1000 do Bloom e padrões atuais do Neo4j Browser: só fonte indireta.
- Algoritmo exato do "semelhante" do Maltego: a documentação é vaga de propósito.
- Números de Bach 2017 e números por tarefa de Ehlers 2024: não recuperados.
- Um texto da Cambridge Intelligence sobre *hairballs* de dados devolveu 404.

## Fontes

**Literatura**

- [1] Furnas 1986: https://cspages.ucalgary.ca/~saul/581/exer.eps/4furnas86.pdf
- [2] van Ham & Perer 2009: https://doi.org/10.1109/TVCG.2009.108
- [3] Dunne & Shneiderman 2013: https://www.cs.umd.edu/~ben/papers/Dunne2013Motif.pdf
- [4] Dwyer et al. 2013: https://www.microsoft.com/en-us/research/wp-content/uploads/2016/12/edgecompression_infovis2013.pdf
- [5] Royer et al. 2008: https://doi.org/10.1371/journal.pcbi.1000108
- [6] Bach et al. 2017: https://aviz.fr/~bbach/confluentgraphs/Bach2016confluentgraphs.pdf
- [7] Wattenberg 2006: https://dl.acm.org/doi/10.1145/1124772.1124891 (DOI de memória, não conferido)
- [8] Semantic substrates: http://www.cs.umd.edu/users/ben/papers/Aris2007Designing.pdf
- [9] OnionGraph: https://www.sciencedirect.com/science/article/pii/S2468502X20300024
- [10] Elmqvist & Fekete 2010: https://www.cs.au.dk/~elm/pdf/hieragg.pdf
- [11] TugGraph: https://www.cs.ubc.ca/labs/imager/tr/2009/Archambault_TugGraph_PacificVis/TugJournal.pdf
- [12] ASK-GraphView: https://doi.org/10.1109/TVCG.2006.120
- [13] NodeTrix: https://arxiv.org/pdf/0705.0599
- [14] Refinery: https://doi.org/10.1111/cgf.12642
- [15] Vehlow et al. 2017: https://onlinelibrary.wiley.com/doi/abs/10.1111/cgf.12872
- [16] Topological fisheye views: https://www.researchgate.net/publication/4117904_Topological_Fisheye_Views_for_Visualizing_Large_Graphs
- [17] GraphMaps: https://arxiv.org/pdf/1506.06745
- [18] Graph Thumbnails: https://www.researchgate.net/publication/322326662 · BigGraphVis: https://arxiv.org/abs/2108.00529
- [19] Yee et al. 2001: https://bailando.berkeley.edu/papers/infovis01.htm
- [20] Group-in-a-Box: https://www.cs.umd.edu/~ben/papers/Rodrigues2011Group.pdf
- [21] PhylloTrees: https://www.researchgate.net/publication/4117939_PhylloTrees_Harnessing_Natures_Phyllotactic_Patterns_for_Tree_Layout
- [22] EgoLines: https://doi.org/10.1145/2858036.2858488 · 1.5D: https://doi.org/10.1109/TVCG.2014.2383380 · egoSlider: https://doi.org/10.1109/tvcg.2015.2468151
- [23] Ehlers et al. 2024: https://www.cg.tuwien.ac.at/research/publications/2024/ehlers-2024-mmm/
- [24] Ghoniem et al., discutido em https://arxiv.org/pdf/1709.00293
- [25] Yoghourdjian et al. 2018: https://arxiv.org/pdf/1809.00270
- [26] Jianu et al. 2014: https://doi.org/10.1109/TVCG.2014.2315995 · Archambault et al. 2010: https://doi.org/10.1111/j.1467-8659.2009.01683.x
- [27] Juniper: https://arxiv.org/html/1804.03261 · van den Elzen & van Wijk: https://doi.org/10.1109/TVCG.2014.2346441
- [43] Ware & Mitchell: https://www.semanticscholar.org/paper/Visualizing-graphs-in-three-dimensions-Ware-Mitchell/6aa82b272c8dc533b6f45c43db64f8a324d32fea · Greffard et al.: https://link.springer.com/chapter/10.1007/978-3-642-25878-7_21
- [44] Kwon et al. 2016: https://vis.cs.ucdavis.edu/papers/TVCG_Kwon2016.pdf
- [45] ExplorViz: https://arxiv.org/pdf/2510.00003 · LOD de grafo 3D em VR: https://arxiv.org/pdf/2302.05660

**Produtos**

- [28] Maltego: https://docs.maltego.com/en/support/solutions/articles/15000010775-collections-tab · https://docs.maltego.com/support/solutions/articles/15000019182-options-menu
- [29] GraphXR: https://helpcenter.kineviz.com/user-guides/v3/g-user/graphxr-start/project-ui.html · https://helpcenter.kineviz.com/user-guides/v3/g-release-notes/gxr-2-17-0-release-notes.html · https://helpcenter.kineviz.com/user-guides/v2.x/g-release-notes/gxr-release-history.html
- [30] Linkurious e Ogma: https://doc.linkurious.com/user-manual/latest/expand/ · https://doc.linkurious.com/admin-manual/latest/advanced-settings/ · https://doc.linkurious.com/user-manual/latest/nodegrouping/ · https://doc.linkurious.com/ogma/latest/tutorials/transformations/
- [31] Cambridge Intelligence: https://developers.cambridge-intelligence.com/docs/keylines/combos · https://cambridge-intelligence.com/blog/starburst-effect-in-graph-visualization/
- [32] Neo4j, Memgraph, Graphileon: https://neo4j.com/docs/bloom-user-guide/current/bloom-visual-tour/bloom-scene-interactions/ · https://neo4j.com/docs/browser-manual/current/operations/browser-settings/ · https://memgraph.com/docs/memgraph-lab/changelog · https://docs.graphileon.com/graphileon/For_Dashboard_Users/Graphileon_Dashboard.html
- [33] Palantir Vertex: https://www.palantir.com/docs/foundry/vertex/graphs-display-options
- [34] i2: https://docs.i2group.com/anb/9.4.0/most_connected_items.html · https://docs.i2group.com/anb/10.0.2/grouped_layout.html
- [35] yFiles: https://www.yfiles.com/faq · https://www.yfiles.com/resources/how-to/guide-to-visualizing-knowledge-graphs
- [36] Graphistry: https://hub.graphistry.com/docs/ui/basics/
- [37] Gephi: https://github.com/gephi/gephi/wiki/Releases
- [38] Cytoscape.js: https://github.com/iVis-at-Bilkent/cytoscape.js-expand-collapse · https://github.com/iVis-at-Bilkent/cytoscape.js-complexity-management
- [39] G6: https://g6.antv.antgroup.com/en/manual/behavior/overview
- [40] Sigma.js: https://www.sigmajs.org/reference/settings/
- [41] Cosmograph: https://cosmograph.app/docs-lib/api/interfaces/CosmographConfig/
- [42] 3d-force-graph: https://github.com/vasturiano/3d-force-graph/blob/master/example/expandable-nodes/index.html · https://github.com/vasturiano/3d-force-graph/issues/480
