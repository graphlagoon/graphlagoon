# 00 · Pesquisa: ferramentas de investigação de fraude e PLD

> Pesquisa de outubro de 2026. **[V]** marca afirmação de fornecedor sem verificação
> independente; o que não foi verificado ficou de fora.

## Conclusão

Nenhuma ferramenta de investigação **aberta** consulta o warehouse no lugar, e
nenhuma documenta o método de rastreio (tempo máximo de permanência, regra de
alocação). É essa a lacuna que o Graph Lagoon ocupa.

- **Quatro famílias dividem o mercado:**
  - workbenches de vínculos (i2, Linkurious, Maltego);
  - resolução de entidades e redes (Quantexa, Palantir);
  - fraude e PLD com casos (Actimize, SAS, Feedzai, Unit21);
  - rastreio de valores (Chainalysis, TRM, Valid8).
- **Todas copiam os dados** para um banco próprio (grafo, Elasticsearch ou plataforma
  fechada) e cobram por assento.
- **Os métodos de rastreio são opacos,** e a regra de alocação muda o resultado em
  dezenas de vezes (§5).

| | Dados copiados para o fornecedor | Dados consultados no warehouse |
|---|---|---|
| **Licença aberta** | nenhuma aplicação encontrada | **Graph Lagoon** (a lacuna) |
| **Licença fechada** | i2, Linkurious, Maltego, Neo4j Bloom, SAS, Actimize, Feedzai, Unit21, Lucinity, Chainalysis, TRM, Palantir | Quantexa (roda no Databricks), Siren (federa por JDBC) |

## 1. Workbenches de análise de vínculos

| Ferramenta | Importação e entidades | Canvas e tempo | Limite ou ponto fraco |
|---|---|---|---|
| [i2 Analyst's Notebook](https://docs.i2group.com/anb/9.4.0/create_a_specification.html) | Assistente CSV/Excel com "especificações" salvas, sugeridas pelo cabeçalho; [Find Matching Entities](https://docs.i2group.com/anb/10.0.2/find_matching_entities.html) com match adiável e merge que guarda cada origem | Sumarização de links em 4 modos, inclusive **Flow** pelo valor ([docs](https://docs.i2group.com/analyze/4.4.1/configuring_link_summarization.html)); caminhos, SNA, timeline | Cliente desktop Windows; perde colunas de Excel ([IBM](https://www.ibm.com/support/pages/some-columns-are-missing-excel-files-when-importing-ibase-or-analysts-notebook)) |
| [Linkurious Enterprise](https://doc.linkurious.com/admin-manual/latest/import-csv/) | CSV com templates e merge de duplicados; ER via Senzing que explica o match ([manual](https://doc.linkurious.com/admin-manual/4.2/entity-resolution-requirements/)) | Agrupamento, mapa, timeline; alertas Cypher viram casos com atribuição e trilha | Exige banco de grafo; arestas exigem nós já existentes; €490 por usuário ao mês ([preços](https://linkurious.com/pricing/)) |
| [Maltego](https://docs.maltego.com/support/solutions/articles/15000010797-import-graph-from-table) | Coluna→entidade com tabela de conectividade e mapeamentos salvos | "Collections" agrupam entidades do mesmo tipo | 10 mil entidades no CE, 1 milhão no Maltego One; transforms cobrados por crédito |
| [Neo4j Bloom](https://neo4j.com/blog/developer/slice-and-dice-your-graph-data-with-neo4j-bloom/) | Perspectivas com Cypher salvo e frases de busca parametrizadas | Slicer filtra propriedade por faixa num histograma | Mostra de 100 a 10 mil nós |
| [Sentinel Visualizer](https://fmsasg.com/products/sentinelvisualizer/) | Especificações de importação salvas sobre SQL Server | Caminho mais curto, timeline, mapas | Cliente desktop |
| [Siren Investigate](https://www.elastic.co/blog/investigative-analysis-of-disjointed-data-in-elasticsearch-with-the-siren-platform) | Ontologia OWL mapeando chaves; JDBC para Presto/Impala | Filtros "set-to-set" entre dashboards; arestas agregadas | Depende de Elasticsearch |
| [DataWalk](https://datawalk.com/neo4j-entity-resolution-vs-datawalk-entity-resolution/) | ER configurável (Soundex, Levenshtein, Jaccard) | Consultas visuais com "breadcrumbs"; scorecards | "Bilhões de registros" **[V]** |
| [Cambridge Intelligence](https://cambridge-intelligence.com/integrating-kronograph-with-keylines/) | SDKs (KeyLines, ReGraph, KronoGraph) | Combos aninhados; time bar; KronoGraph acopla timeline ao grafo para follow the money | Não é produto final |

## 2. Resolução de entidades e redes

- **[Quantexa](https://www.applytosupply.digitalmarketplace.service.gov.uk/g-cloud/services/235413955896497):**
  - ER em lote, em tempo real ou dinâmica, limitada às permissões do usuário;
  - ego-networks geradas sob demanda, sem banco de grafo;
  - scorecards de entidade e de rede;
  - roda dentro do Databricks do cliente ([parceria](https://www.quantexa.com/press/quantexa-announces-partnership-with-databricks-to-help-customers-rapidly-scale-data-and-ai-initiatives/)).
- **Palantir Gotham/Foundry:**
  - ontologia de objetos e links sobre datasets
    ([docs](https://www.palantir.com/docs/foundry/object-link-types/create-object-type/index.html));
  - "Search Around" filtrado; grafo, mapa, timeline e casos;
  - custo de oito dígitos e software que "só pode ser mantido pela empresa"
    ([GovTech](https://www.govtech.com/computing/ice-renews-controversial-palantir-software-contract.html)).

## 3. Plataformas de fraude e PLD com gestão de casos

| Plataforma | Grafo e redes | Casos e relatórios | IA e explicabilidade |
|---|---|---|---|
| [NICE Actimize](https://thefintechtimes.com/nice-actimize-tackles-complex-networked-financial-crime-with-ai-powered-case-management-solution/) | Redes para anéis de laranjas | Roteamento por risco; narrativa de SAR por IA | Score único por entidade ([PR](https://www.niceactimize.com/press-releases/nice-actimize-introduces-ai-powered-x-sight-entity-risk-solution-to-provide-a-single-trust-score-385)) |
| [SAS Visual Investigator](https://www.sas.com/pt_br/software/intelligence-analytics-visual-investigator.html) | Expandir e podar; centralidades; ER antes de indexar | Workspace com busca, timeline, mapa e rede; auditoria | Resumos por copiloto |
| [Feedzai](https://www.feedzai.com/pressrelease/feedzai-launches-ai-in-case-manager-powered-by-next-generation-ai-capabilities) | "Genometries" marcam laranjas, triângulos e fracionamento | Case Manager | Diz dobrar a vazão de alertas **[V]** |
| [Unit21](https://www.unit21.ai/products/case-management) | Vínculos por IP e dados pessoais | Filas; SAR preenchida a partir do caso; e-filing FinCEN e goAML ([docs](https://docs.unit21.ai/docs/fincen-reports)) | Modelos de narrativa |
| [Lucinity](https://lucinity.com/blog/luci-widgets) | Sankey de fluxo de dinheiro | Case Manager | Copiloto |
| [ThetaRay](https://www.businesswire.com/news/home/20260127397552/en) | não verificado | Agente escreve o relatório com achados e **contradições** | Gráficos como evidência |
| [Oracle FCCM](https://oracle.com/a/ocom/docs/industries/financial-services/ofs-investigation-hub-ds.pdf) | ER; **time-lapse da rede** | Score forma unidades de investigação | ML em grafos |
| [Sardine](https://www.sardine.ai/transaction-monitoring) | Contas, dispositivos, IPs e contrapartes ao vivo | Registros para o regulador | Sinais de dispositivo |
| [Hawk AI](https://www.getapp.co.uk/software/2052402/hawk-ai) | Nenhuma visão de grafo encontrada | Case manager com o motivo de cada alerta | Aprende com decisões |

Featurespace, Napier e Tookitaki têm casos e explicações, mas nenhum recurso de grafo
verificável.

## 4. Especialistas em follow the money

| Ferramenta | Como rastreia | O que mostra | Limite |
|---|---|---|---|
| [Chainalysis Reactor](https://www.chainalysis.com/chainalysis-reactor/) | Segue por endereços não atribuídos até um serviço atribuído | Clusters atribuídos; "exposure wheel"; timeline Storyline | £55k por licença ao ano ([G-Cloud](https://www.applytosupply.digitalmarketplace.service.gov.uk/g-cloud/services/721145525030910)); aceito em juízo nos EUA ([Stout](https://www.stout.com/en/insights/article/judicial-scrutiny-chainalysis)) |
| [TRM Forensics](https://www.trmlabs.com/products/forensics) | Todas as rotas; agente plota fluxos até saídas custodiais | "Signatures" de lavagem; notas e casos | Regra de alocação não documentada |
| [Elliptic Investigator](https://www.elliptic.co/products/investigator/) | Grafo automático a partir de uma carteira | Pacote de evidência com grafo, horários, rótulos e notas | Só cripto |
| [Valid8](https://www.valid8financial.com/use-cases/financial-crime) (fiat) | Lê extratos sem template; casa transferências | Sankey entre contas; pistas de "possível transferência" | não verificado |
| [Lucinity Money Flow](https://lucinity.com/blog/luci-widgets) (fiat) | Sankey centrado no ator | Janelas de 7 a 120 dias | Só as 10 mil transações mais recentes; sem filtro de valor |

## 5. Método de rastreio

- **Modelo:** transação = aresta com data, hora e valor num multigrafo temporal;
  agregação só na exibição.
- **Salto a salto:** de uma semente até saídas (saque, liquidação, banco externo,
  exchange, aposta). "Saltos ilimitados" só funcionam com regras de parada, porque o
  fan-out explode ([Tendrils of Crime](https://arxiv.org/pdf/1901.01769)).
- **Restrição temporal:** `t(j→k) ≥ t(i→j)` e `t(j→k) − t(i→j) ≤ Δ`. O modelo de buffers
  de [Kosyfaki et al. (ICDE'21)](https://arxiv.org/pdf/2003.01974) só repassa saldo
  disponível. Nenhuma ferramenta comercial documenta Δ.
- **Regra de alocação:** muda o resultado. Em [Anderson et al.](https://www.cl.cam.ac.uk/~rja14/Papers/bitcoin-redux-weis2018.pdf)
  a regra proporcional contaminou 93% dos endereços, e a FIFO, 1,3%.
  - **Contaminação total (poison):** limite superior.
  - **Proporcional (haircut).**
  - **FIFO:** Clayton's Case, 1816.
  - **LIFO e TIHO:** como o lavador tenta escapar ([arXiv](https://arxiv.org/pdf/1906.05754)).
  - **LIBR:** aceito em tribunais, com exceções quando há muitas vítimas
    ([10º Circuito](https://caselaw.findlaw.com/court/us-10th-circuit/1004530.html)).
- **Padrões:** o AMLworld ([NeurIPS'23](https://arxiv.org/html/2306.16424v1)) nomeia
  fan-out, fan-in, gather-scatter, scatter-gather, ciclo, passeio aleatório, bipartido
  e pilha. Somam-se o fracionamento, a peeling chain e as camadas.
- **Boas UIs:**
  - contrapartes por valor e "todas as rotas até X" (TRM, Reactor);
  - timeline narrativa (Storyline, KronoGraph);
  - Sankey com clique até a transação (Lucinity, Valid8);
  - selos de padrão (Feedzai, TRM).

## 6. Checklist de capacidades e o Graph Lagoon hoje

| Capacidade | Nível | Referências | Graph Lagoon hoje |
|---|---|---|---|
| Importação tabular com mapeamentos salvos | Básico | i2, Maltego, Linkurious, Foundry | Não existe |
| ER com revisão humana | Básico | i2, Senzing, Quantexa, DataWalk | Não existe |
| Expandir com filtros e limite de saltos | Básico | todas | Existe |
| Agrupar e somar transações paralelas | Básico | KeyLines, i2 | Parcial (conta, não soma) |
| Estilo por propriedade, perspectivas salvas | Básico | i2, Bloom | Existe |
| Timeline ligada ao grafo | Básico | i2, KronoGraph, Linkurious, SAS | Não existe |
| Caminhos | Básico | i2, Sentinel, TRM | Não existe na UI |
| Casos, responsável, comentários, auditoria | Básico | Linkurious, Unit21, SAS | Parcial (auditoria de mutações) |
| Exportação de evidência | Básico | Elliptic, TRM, i2 | Parcial (PNG, JSON, CSV) |
| Visão de fluxo de dinheiro | Diferencial | Lucinity, Valid8, i2 Flow | Parcial (hierárquico "money flow") |
| Rastreio automático até saídas | Diferencial | TRM, Reactor, Elliptic, MED 2.0 | Não existe |
| Selos de tipologia | Diferencial | Feedzai, TRM | Parcial (métricas customizadas) |
| Scorecards de rede | Diferencial | Quantexa, DataWalk, X-Sight | Parcial |
| Narrativa por IA | Diferencial | ActOne, ThetaRay, Lucinity | Parcial (Ask-AI de labels) |
| Time-lapse da rede | Diferencial | Oracle FCCM | Não existe |
| Nativo do warehouse, sem copiar dados | Diferencial | nenhuma aplicação aberta | **Existe** |

## 7. Lacunas que um produto aberto pode ocupar

1. **Custo por assento e lock-in:** Reactor £55k por licença ao ano; Linkurious €490
   por usuário ao mês.
2. **Cópia de dados:** motores que consultam o warehouse no lugar existem
   ([PuppyGraph](https://www.businesswire.com/news/home/20241023866174/en), Graphistry),
   mas não são aplicações de investigação.
3. **Importação frágil:** colunas perdidas (i2), entidade genérica por erro de
   mapeamento (Maltego), arestas que exigem nós prévios (Linkurious).
4. **Tetos de cerca de 10 mil itens** (Bloom, Maltego CE, Lucinity).
5. **Métodos opacos:** tornar Δ, a alocação e as paradas explícitos e reproduzíveis é
   diferencial e defesa em juízo.
