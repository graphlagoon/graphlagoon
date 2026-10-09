# Plano: Graph Lagoon como sistema de investigação (fraude, PLD/FT, follow the money)

> Status: **proposta** em 2026-10-09, atualizada no mesmo dia com a etapa AI-first
> (§4.6) e o armazenamento no Volume. **Nada foi implementado ainda.**
>
> **Para executar, use o pacote [investigation/](investigation/README.md):** pesquisa,
> design (telas e fluxos com imagens e mockups), arquitetura e plano de tarefas. O
> pacote é a fonte da verdade; este arquivo é o resumo da proposta.

## O que existe hoje e o que é proposta

| Funcionalidade | Hoje no app | Proposta | Fase |
|---|---|---|---|
| **Uma investigação com várias explorações de contexts diferentes** | Não existe: cada exploração tem FK para um único context | O caso agrupa N explorações em abas, com visão unificada e seleção vinculada | F1 |
| Unir a mesma pessoa ou conta entre contexts | Não existe | Chaves de identidade no context | F1 |
| Tabelas extras de enriquecimento | Não existe | Consultadas por chave, fora da query do grafo | F2 |
| Subir arquivos (SIMBA, QSA, CSV) salvos no Volume | Não existe | Grafo, enriquecimento ou anexo; streaming com hash | FA, F2 |
| Grafo em memória enriquecido | Parcial: um por exploração | Grafo unificado do caso | F1, F2 |
| Seguir o dinheiro | Não existe | Rastreio temporal, camadas, Sankey, raias, caminhos | F3 |
| Resolução de entidades | Não existe | Sugestões revisáveis, com motivo | F2 |
| Dossiê, prazos, decisão, exportação | Não existe | Diário, hipóteses, evidências, decisão, laudo | F4 |
| Agentes de IA no caso (MCP) | Não existe | Token do usuário, propostas com aceite humano | FA |
| Espaço do caso para artefatos | Não existe | Slides, docs e relatórios versionados no Volume | FA |

## Contexto

Hoje o Graph Lagoon é um **explorador de grafos nativo do warehouse**. Um *graph
context* corresponde a um par de tabelas (arestas e nós). Uma *exploração* salva a
visão de um único context. O pedido é evoluir o produto para um **sistema de
investigação** para adquirentes e subcredenciadores (perfil Stone, Cielo, PagBank,
Getnet) e para bancos e IPs. O produto precisa permitir:

- **unir várias explorações** em uma única investigação;
- **carregar CSVs** (extratos, cadastros, quebras de sigilo, listas);
- **montar e enriquecer um grafo em memória** a partir desses CSVs;
- **seguir o dinheiro** (follow the money): rastrear valores salto a salto entre contas;
- **ser AI-first:** API e servidor MCP para um agente de IA criar e evoluir a
  investigação e subir artefatos (slides, documentos, relatórios) no espaço do caso.

Este documento faz três coisas:

1. resume a avaliação das ferramentas atuais de investigação de fraude, risco e
   auditoria (§1) e o contexto regulatório brasileiro (§2);
2. compara essa avaliação com o que o código já tem (§3);
3. propõe o conceito do produto (§4), **como o design será conduzido** (§5), o roadmap
   de engenharia (§6) e os riscos (§7).

As fontes completas estão em §8.

---

## 1. Avaliação do mercado

### 1.1 Categorias

| Categoria | Exemplos | O que entregam | Onde falham |
|---|---|---|---|
| Workbench de análise de vínculos | i2 Analyst's Notebook, Linkurious, Maltego, Neo4j Bloom, Sentinel Visualizer, Siren, DataWalk | Importação tabular com mapeamento coluna→entidade, expansão, combos, timeline, caminhos | Cliente desktop (i2), dados precisam ser copiados para um banco de grafo próprio, importação frágil, licença por assento (Linkurious €490/usuário/mês) |
| Plataforma de ER + redes | Quantexa, Palantir Gotham/Foundry | Resolução de entidades em escala, ego-networks sob demanda, scorecards | Custo de oito dígitos, lock-in, integração pesada |
| Fraude/PLD com gestão de casos | NICE Actimize, SAS Visual Investigator, Feedzai, Featurespace, Unit21, Lucinity, Hawk, ThetaRay, Oracle FCCM | Alertas que viram casos, filas, SAR assistida por IA, auditoria | Grafo raso (às vezes inexistente), métodos fechados, dados presos à plataforma |
| Rastreio de valores (follow the money) | Chainalysis Reactor, TRM, Elliptic (cripto); Valid8, Lucinity Money Flow (fiat) | Rastreio salto a salto até saídas, Sankey de fluxo, timeline narrativa, pacote de evidências | Específicos de cripto ou com teto (Lucinity analisa só as 10 mil transações mais recentes); Reactor custa £55k por licença por ano |

### 1.2 Checklist de capacidades e o Graph Lagoon hoje

Legenda: ✔ existe · ◐ parcial · ✘ não existe.

| Capacidade | Nível | Referências | Graph Lagoon |
|---|---|---|---|
| Importação tabular com prévia e **mapeamentos salvos e reutilizáveis** | Básico | i2, Maltego, Linkurious, Foundry | ✘ (só JSON de presets, ações e métricas) |
| Resolução de entidades com revisão humana: score, "match link" para adiar, merge que preserva a origem | Básico | i2, Senzing/Linkurious, Quantexa, DataWalk | ✘ |
| Expandir com filtros e limite de saltos | Básico | todos | ✔ `expandFromNode` (profundidade ≤ 2, tipos, direção) |
| Agrupar e **sumarizar arestas paralelas** (transações) | Básico | KeyLines, i2 (Directed/Flow) | ◐ clusters existem; arestas paralelas são contadas mas não somadas |
| Estilo por propriedade, perspectivas salvas | Básico | i2, Bloom | ✔ visual mapping, regras de label, style presets |
| Timeline ligada ao grafo | Básico | i2, KronoGraph, Linkurious, SAS | ✘ (só filtro de data na Data Table) |
| Caminho mais curto / todos os caminhos | Básico | i2, Sentinel, TRM | ✘ na UI (VLP em Cypher no servidor) |
| Alertas→casos, responsável, comentários, trilha de auditoria | Básico | Linkurious, Unit21, SAS | ◐ auditoria de mutações; nenhum caso |
| Exportação de evidências | Básico | Elliptic, TRM, i2 | ◐ PNG, JSON, CSV (CSV sem mitigação de injeção, M4) |
| **Visão de fluxo de dinheiro** (Sankey, arestas por valor, janelas de tempo) | Diferencial | Lucinity, Valid8, i2 Flow | ◐ layout hierárquico `traversal:'out'`, largura da aresta por métrica |
| **Rastreio automático** até saídas | Diferencial | TRM, Reactor, Elliptic, MED 2.0 | ✘ |
| Selos de tipologia no grafo | Diferencial | Feedzai Genometries, TRM Signatures | ◐ métricas customizadas e cluster programs podem expressar padrões |
| Scorecards de rede | Diferencial | Quantexa, DataWalk, X-Sight | ◐ métricas + regras |
| Narrativa ou relatório assistido por IA | Diferencial | ActOne, ThetaRay, Lucinity | ◐ Ask-AI de labels e ações (sem relatório) |
| Time-lapse da rede | Diferencial | Oracle FCCM | ✘ |
| ER dinâmica com escopo de permissão | Diferencial | Quantexa | ◐ escopo de query por tabela já existe |
| **Nativo do warehouse, sem copiar dados** | Diferencial (lacuna do mercado) | nenhuma *aplicação* de investigação aberta | ✔ é o núcleo do produto |

### 1.3 Follow the money: método

O método que as melhores ferramentas usam, e que a literatura formaliza:

- **Modelo.** Cada transação é uma aresta com data/hora e valor, num multigrafo
  temporal. Agregação acontece só na exibição (i2 Directed/Flow).
- **Rastreio salto a salto.** Parte de uma semente (o Pix contestado, uma conta
  suspeita). Vai **para frente** ("para onde foi") ou **para trás** ("origem dos
  recursos"). Para nas **saídas**: saque, liquidação de lojista, banco externo,
  exchange, bet. O MED 2.0 limita o rastreio a 2 camadas no "caminho mais provável".
  "Saltos ilimitados" só funcionam com regras de parada e ranqueamento: o fan-out
  explode.
- **Restrição temporal.** Um caminho i→j→k só vale se t(j→k) ≥ t(i→j) e se o tempo
  de permanência Δ for limitado. O modelo guloso de buffers de Kosyfaki et al.
  (ICDE'21) processa as interações em ordem temporal e só deixa repassar o que a
  conta tem em saldo. **Nenhuma ferramenta comercial documenta Δ.**
- **Alocação quando há mistura de recursos.** Poison (tudo contamina), haircut
  (proporcional), **FIFO** (Clayton's Case), LIFO, TIHO e **LIBR** (menor saldo
  intermediário, aceito em tribunais). O resultado muda muito: num caso real,
  haircut contaminou 93% dos endereços e FIFO 1,3%. Por isso o método **é um
  parâmetro escolhido pelo analista e gravado na evidência**.
- **Padrões.** Fan-out, fan-in, gather-scatter, scatter-gather, ciclo (round-tripping),
  bipartido, pilha, estruturação (smurfing), peeling chain, camadas (cadeias longas,
  permanência curta, valor quase conservado).
- **UI de referência.**
  - grafo de rastreio com contrapartes ordenadas por valor e "todas as rotas até X"
    (TRM/Reactor);
  - timeline narrativa (Chainalysis Storyline, KronoGraph);
  - Sankey centrado no ator com drill-down até a transação bruta, janelas de tempo e
    pistas de **"possível transferência"** (transferência vista só de um lado, que
    sugere conta não declarada; Valid8, Lucinity);
  - links de fluxo direcionado (i2).

### 1.4 Lacunas que um produto aberto e nativo do warehouse pode ocupar

1. **Custo por assento e lock-in.** Reactor custa £55k por licença por ano.
   Linkurious, Lucinity e Maltego também são caros (valores em §8).
2. **Cópia de dados.** Linkurious e Bloom exigem banco de grafo; SAS e Siren exigem
   Elasticsearch. Quantexa roda no Databricks, mas é plataforma fechada.
   **Não há aplicação de investigação aberta que consulte o warehouse no lugar.**
3. **Importação frágil.** O i2 perde colunas de Excel. O Maltego vira "Phrase" quando o
   mapeamento erra. No Linkurious, as arestas exigem que os nós já existam.
4. **Tetos de escala** de cerca de 10 mil itens (Bloom, Maltego CE, Lucinity). O certo
   é filtrar no warehouse antes de renderizar, e isso o Graph Lagoon já faz.
5. **Métodos opacos.** Atribuição, scorecards e alocação são fechados. Tornar explícitos
   e reproduzíveis os saltos, Δ, a alocação e as regras de parada, e levá-los para a
   evidência exportada, é diferencial e defesa em juízo.
6. **Trabalho manual de juntar dados de vários sistemas** consome boa parte do tempo
   de cada caso (estimativa de fornecedor: 20 de 30 minutos).

---

## 2. Contexto brasileiro: o que o produto precisa suportar

### 2.1 Normas → requisito de produto

| Norma | Exige | Consequência no produto |
|---|---|---|
| Circ. BCB 3.978/2020 art. 30 | Registro de pagamentos com origem e destino: nome, CPF/CNPJ, instituição, agência, conta | Esquema mínimo de aresta "transação" |
| Circ. 3.978 art. 39–43 | Até 45 dias para selecionar e mais 45 para analisar; **dossiê** de toda análise, comunicada ou não | A Investigação **é** o dossiê: prazos visíveis, decisão fundamentada |
| Circ. 3.978 art. 40 | Parâmetros, regras e cenários de monitoramento documentados e auditáveis | Parâmetros de rastreio e de regras gravados e versionados |
| Circ. 3.978 art. 44 | A análise não pode ser terceirizada; "serviços auxiliares" podem | Posicionar como ferramenta **auxiliar self-hosted**, operada pela instituição |
| Circ. 3.978 art. 48/55 | Decisão registrada; comunicação ao COAF via **Siscoaf** até o dia útil seguinte | Exportar um resumo pronto para o Siscoaf; e-filing direto não (sem API pública conhecida, **a confirmar**) |
| Circ. 3.978 art. 50 | Vedação de tipping-off | Compartilhamento de investigação só nominal; nunca `*` público |
| Circ. 3.978 art. 67 | Retenção de 10 anos de KYC, registros e dossiês | Arquivos brutos imutáveis com hash; política de retenção |
| CC BCB 4.001/2020 | Indicadores de atipicidade; muitos são padrões de grafo ou fluxo (I-c, I-h, III-f, III-i/k/l, IV-ad, IV-k, IV-n/o/p, IV-v…z, X-m) | Biblioteca de **selos de tipologia** ligada aos itens da CC 4.001 |
| Res. BCB 493/2025 (MED 2.0) | Rastreio de fraude Pix além da 1ª conta: grafos de profundidade N, bloqueio e devolução em camadas; obrigatório desde 2/2/2026 | O fluxo herói "golpe Pix → rastreio" espelha o MED 2.0 |
| Res. BCB 501/2025 | Rejeitar pagamentos a contas sob "fundada suspeita de fraude" | A investigação gera listas de contas e chaves marcadas para exportar |
| Res. BCB 587/2026 | Marcação de fraude no DICT por CPF/CNPJ, com 5 anos, justificativa e revisão em 7 dias | Campo de justificativa por entidade marcada; trilha de revisão |
| Res. Conj. 6/2023 + Res. BCB 343/2023 (+ 569/2026) | Compartilhamento de dados de fraude entre instituições em 24h | Importar e exportar registros RC6 |
| Portarias SPA/MF 566/2025 (e sucessora, **a confirmar**) | IPs reportam contas de bets ilegais em 24h; a rotação de contas e chaves é "mesma operação" | Tipologia "bets": muitos pagadores → conta intermediária; ligar contas rotativas por site ou jornada |
| LGPD art. 7 II/IX, 20, 37 · LC 105/2001 | Base legal, revisão de decisão automatizada, registro de tratamento; sigilo bancário | Need-to-know, **auditoria de leitura**, sem decisão automática sem revisão |

### 2.2 Tipologias → padrão no grafo → dados que ligam

| Tipologia | Padrão | Ligações |
|---|---|---|
| Laranjas / contas de passagem | Fan-in seguido de fan-out imediato, saldo perto de zero, conta dormente reativada | CPF, dispositivo, IP, telefone, e-mail, endereço, chave Pix, marcação DICT, MED |
| Golpe Pix (falsa venda, falsa central) | Vítima → laranja da camada 1 → divisão em camadas 2…n → saque, cripto, bet ou boleto; valores encolhendo, intervalos de minutos | EndToEndId, chave Pix, notificação de infração, dispositivo |
| Lojista de fachada / bust-out | CNPJ novo (MEI), CNAE incompatível, sócios do QSA em comum com lojistas que saíram, POS longe ou em horário atípico, antecipação seguida de chargeback | CNPJ, QSA, domicílio bancário, terminal, CEP |
| Transaction laundering | O lojista processa vendas de outro negócio (bets, ilícitos); ticket padronizado; vários lojistas liquidando na mesma conta | URL, subcredenciador, conta de liquidação, MCC/CNAE |
| Card testing | Estrela: muitos cartões → um lojista CNP com valores mínimos | BIN, IP, dispositivo |
| Subcredenciador / conta-bolsão | Hub com grau enorme; os beneficiários finais ficam no razão interno | Circ. 3.978 art. 31, regras de split, sub-merchant ID |
| Estruturação (fracionamento) | Muitos→um ou um→muitos em 1–5 dias úteis, logo abaixo de R$ 50 mil ou em valores redondos | Janela temporal, agência/ATM, CPF do portador |

### 2.3 Formatos de entrada prioritários

1. **SIMBA** (quebra de sigilo; layout CC 3.454/2010 e memorando MI001-SPPEA v3.1):
   5 arquivos `.TXT` separados por TAB (AGENCIAS, CONTAS, TITULARES, EXTRATO,
   ORIGEM_DESTINO). Datas em `ddmmaaaa` e valores inteiros em centavos.
   - EXTRATO × ORIGEM_DESTINO vira arestas.
   - Contrapartes `NAO-CORRENTISTA` (agência 9999) e sem identificação (29–35% das
     transações, segundo o diagnóstico ENCCLA) viram **nós "desconhecido" explícitos**.
   - A v3.1 não tem campo de chave Pix nem de EndToEndId (**a confirmar** em versões
     posteriores).
2. **Receita Federal, CNPJ aberto**: CSV separado por `;`, com Empresas,
   Estabelecimentos e Sócios (QSA). O CPF de sócio pessoa física vem **mascarado**,
   então o match é probabilístico e vira "match link", nunca merge automático.
3. **Exportações internas**: transações, KYC, dispositivos/IP, chaves Pix, terminais,
   domicílios bancários, notificações MED, registros RC6.
4. **Listas de enriquecimento**: PEP, CEIS/CNEP, sanções do CSNU, lista de operadores
   de bets autorizados da SPA, ISPB/COMPE do BCB, doações do TSE.

---

## 3. O que já existe no código para reaproveitar

| Alvo | Base mais próxima | Falta |
|---|---|---|
| Mesclar explorações | Blob `GraphSnapshot` + snapshot em `loadExploration`; dedup-append de `expandFromNode`; `state.clusters`; `applyStylePreset` | API e UI de união; política de conflito; **proveniência por nó e aresta**; explorações de contexts diferentes (a FK é 1:1); o watcher do community store zera as comunidades a cada troca de `nodes` |
| Upload de CSV | Modelo `EdgeStructure`/`NodeStructure` + `GraphContextFormModal`; `rest/mapping.py` (normalizador); `readFileAsText`; `useTableColumns.detectType`; `PUT` de precomputed (limite de corpo + auditoria) | Parser e UI de mapeamento; um datasource "upload"/cliente (`DatasourceType` é união fechada); endpoint de upload para quem não é superuser; armazenamento, limites e auditoria; mitigação de injeção de fórmula em CSV (M4) |
| Grafo em memória + enriquecimento | `nodes`/`edges` do `graph.ts` + `patchNodeProperties(merge)`; métricas customizadas (JS por item em worker com sandbox); `similarity.injectEdges` (padrão de aresta derivada); cluster programs | Modo "grafo sem backend" (hoje todo caminho exige `currentContext`); gravar valores computados como propriedade; nós derivados; join por chave (CSV↔grafo); remover nó; desfazer |
| Follow the money | Layout hierárquico `traversal:'out'`; ego com `direction`/`maxHops`; expansão direcionada; weighted-degree; largura da aresta por métrica; VLP no servidor; o `metricsWorker` já monta um multigrafo direcionado com graphology | Rastreio temporal com alocação; soma de arestas paralelas; timeline; Sankey; path finding |
| Caso / workspace | Exploração (estado + snapshot + share + dirty + `?exploration=`); clusters como conjuntos nomeados; grupos e permissões; auditoria; transferência no admin | Entidade que atravesse explorações e contexts; notas, pins e tags; status, responsável e prazos; auditoria de leitura e de query; permissões no catálogo (hoje são só 2) |

**Bloqueios técnicos conhecidos:**
- **#28**: IDs compostos de aresta colidem em arestas paralelas. Transação como aresta
  depende disso.
- **#32**: cluster programs rodam `new Function` na thread principal, o que é mais
  grave com dados sigilosos.
- **M4**: exportação CSV sem mitigação de injeção.
- O clear das comunidades no watcher de `nodes`.

---

## 4. Conceito de produto: "Investigação"

### 4.1 Modelo de objetos

```
Context (warehouse · Neptune · REST · ARQUIVO)
├── tabelas de arestas e nós (o que vira grafo, igual a hoje)
├── chaves de identidade por tipo de nó (CPF/CNPJ, ISPB+agência+conta, chave Pix…)   ← novo
└── tabelas de enriquecimento (não viram grafo; são consultadas por chave)          ← novo

Investigação (= dossiê; status, responsável, prazos 45+45 d, decisão)
├── Explorações ───── N explorações, cada uma do SEU context (contexts diferentes)
│                     aba por exploração + visão unificada (união pelas chaves de identidade)
├── Arquivos ──────── como grafo (vira um context de arquivo) · como enriquecimento · como anexo
│                     (cada arquivo tem hash, autor e data; nunca é alterado)
├── Rastreios ─────── execuções parametrizadas de follow the money (semente, direção, saltos, Δ, janela, alocação)
├── Evidências ────── pins de estado do grafo, notas, trechos de tabela, selos de tipologia, hipóteses
├── Diário ───────── registro automático de cada query, upload, merge, rastreio e decisão de match
│                     (inclusive o que agentes fizeram, "agente X em nome de Y")
├── Espaço do caso ── artefatos versionados: slides, docs, relatórios, imagens (pessoas e agentes)  ← AI-first
├── Agentes ──────── tokens do usuário com escopo; leem, analisam, escrevem, propõem           ← AI-first
└── Decisão ──────── comunicar (COAF/SPA) · marcar (DICT) · arquivar, com fundamentação e exportação
                      (sempre humana)

Volume do caso: {investigations_volume_path}/{id}/ files/ · sources/ · evidence/ · artifacts/ · exports/
                (endereçado por hash, nunca sobrescrito, acesso só pela API)
```

### 4.1a Explorações de contexts diferentes na mesma investigação

Este é um requisito central. A exploração **continua presa ao seu context**: a FK não
muda e cada exploração continua consultando o próprio warehouse ao expandir. A
investigação **agrupa** várias delas e oferece duas leituras.

- **Abas.** Cada exploração continua como é hoje: canvas, filtros, estilos e expansão
  contra o seu context.
- **Visão unificada.** É uma união derivada. Nós de contexts diferentes que são a mesma
  entidade real (o mesmo CPF, a mesma conta) se juntam pelas **chaves de identidade**
  que cada context declara.
  - Cada nó guarda de qual exploração e context veio, e a cor de proveniência mostra
    isso.
  - Ao expandir um nó unificado, o analista escolhe em qual context (ou em todos).
  - Sem chave declarada, a união só acontece pelo `node_id` idêntico.
- **Seleção vinculada.** Selecionar o CPF X numa aba destaca X em todas as outras ("aparece
  em 3 explorações").
- **Referência viva ou congelada.** Enquanto o caso está aberto, a exploração é
  referência viva. Pins de evidência e o fechamento do caso **congelam** o snapshot,
  com hash, para que a evidência não mude se alguém editar a exploração depois.
- **Need-to-know (LC 105).** Compartilhar a investigação **não** concede acesso aos
  contexts. Quem não tem acesso vê um placeholder ("1 exploração restrita"), nunca o
  dado.

### 4.1b Tabelas de enriquecimento no context

Um context passa a declarar **tabelas extras que não entram na query do grafo**. Elas
são consultadas por chave para enriquecer o que já está na tela.

```
enrichment_tables: [{ name: "kyc", table: "cat.sch.kyc_clientes",
                      key: { column: "cpf", matches: "prop:cpf" | "node_id" },
                      node_types: ["Pessoa"], cardinality: "one" | "many",
                      columns: ["renda", "ocupacao", "data_abertura"], label: "Cadastro KYC" }]
```

- **Cardinalidade `one`** (uma linha por nó). As colunas viram propriedades sob
  demanda, num join em lote como o `/nodes/batch` que já existe. Ficam disponíveis em
  labels, cores, filtros, métricas e na Data Table.
- **Cardinalidade `many`** (logins, dispositivos, chargebacks). As linhas aparecem numa
  aba do inspector e podem virar agregados (contagem, soma, última data). Também podem
  ser **promovidas a nós e arestas**: a tabela de dispositivos cria nós "Dispositivo"
  ligando as contas que o compartilham. É assim que nascem os vínculos para resolução de
  entidades.
- **Segurança (obrigatório).** Hoje `sql_scope.context_tables()` só devolve as tabelas
  de arestas e nós, e quem não tem `context.create` só pode ler essas. As tabelas de
  enriquecimento **entram em `context_tables()`**, então anexar uma **amplia o que os
  leitores do context podem ler**. Daí três regras:
  - só anexa quem tem `context.create` e quando a tabela está na allowlist
    `catalog.schema`. Senão, quem só tem share de escrita escalaria para qualquer tabela;
  - a consulta é um endpoint parametrizado por chave (`POST
    /graph-contexts/{id}/enrichment/{name}`), não SQL livre;
  - só as `columns` declaradas saem, e a leitura é auditada.
- **Arquivo como enriquecimento** usa a mesma UI de join, mas com escopo da investigação
  e não do context: lista de PEP, export de KYC, contas marcadas.

### 4.1c Arquivos: três papéis

| Papel | O que vira | Exemplo |
|---|---|---|
| **Grafo** | Um **context de arquivo** (novo `DatasourceType`), com colunas mapeadas para nós e arestas pelo assistente. Gera explorações como qualquer outro context, então entra na investigação do mesmo jeito | SIMBA, extrato interno, export do MED |
| **Enriquecimento** | Tabela de enriquecimento com escopo da investigação (§4.1b) | QSA, PEP, CEIS, KYC |
| **Anexo** | Arquivo não parseado, com hash, anexado ao dossiê | ofício, PDF, print |

O parse acontece no browser, para prévia e mapeamento. O bruto vai ao servidor com
SHA-256, para o mesmo storage dos snapshots (local ou Volume Databricks). Acima do teto
medido no browser, a opção é **promover ao warehouse** (F5): vira uma tabela Delta e o
context de arquivo passa a ser um context SQL normal.

### 4.2 Decisões de arquitetura

| # | Decisão | Por quê |
|---|---|---|
| 1 | **Investigação é uma entidade nova acima da Exploração**, não uma "exploração maior" | A exploração é 1:1 com um context (FK, título único por context). A investigação atravessa contexts e tem ciclo de vida de dossiê (Circ. 3.978 art. 43). |
| 2 | **Identidade de entidade por chave de negócio** (CPF/CNPJ, ISPB+agência+conta, chave Pix, ID de dispositivo), declarada por fonte | É o que permite unir explorações de schemas diferentes com CSVs. O `node_id` de origem vira proveniência. |
| 3 | **Merge nunca apaga o registro de origem**; um match incerto vira "match link" para o analista decidir | Padrão de i2 e Senzing; exigido pelo QSA mascarado; a evidência precisa ser reconstruível. |
| 4 | **Grafo de trabalho em memória no browser** (o `graph.ts` existente), persistido como snapshot com proveniência | Reaproveita o snapshot e é interativo. Teto prático a medir (§7). Acima dele, a fonte é "promovida ao warehouse" (F5). |
| 5 | **CSV parseado no cliente (worker) para prévia e mapeamento; o arquivo bruto vai ao servidor com SHA-256** e auditoria, no mesmo storage dos snapshots (local ou Volume Databricks) | Prévia instantânea. O bruto imutável atende a cadeia de custódia e a retenção de 10 anos. No Databricks, o dado fica sob a governança do Unity Catalog. |
| 6 | **Transação = aresta temporal com valor**; agregação só na exibição | Requisito do rastreio. Depende de resolver o #28. |
| 7 | **Rastreio em worker sobre o grafo de trabalho** (fase 1); operador SQL no warehouse depois | Permite ajustar parâmetros de forma interativa. O `metricsWorker` com graphology já é a base. |
| 8 | **O método do rastreio é explícito e vai junto da evidência** (direção, saltos, Δ, janela, valor mínimo, alocação FIFO/proporcional/LIBR, regras de parada) | Diferencial contra ferramentas opacas, defesa em juízo e Circ. 3.978 art. 40. |
| 9 | **Novas permissões no catálogo:** `investigation.create`, `investigation.upload`, `investigation.export`. Compartilhamento só nominal; auditoria de **leitura** | Receita da Step 2.4b; LC 105, need-to-know e vedação de tipping-off. |
| 10 | **Sem e-filing** no Siscoaf; exportação de um resumo estruturado para colar ou enviar | Não há API pública conhecida (**a confirmar**). Mantém o produto como ferramenta auxiliar. |
| 11 | **Contexts ganham chaves de identidade e tabelas de enriquecimento**; tabelas de enriquecimento entram no escopo de query (§4.1b) | Permitem unir contexts diferentes e enriquecer sem virar grafo. O escopo precisa acompanhar, ou leitores sem `context.create` levam 403. |
| 12 | **Arquivo de grafo é um context** (datasource `file`) | Reaproveita exploração, estilos, métricas e a própria investigação sem caminho especial. |

### 4.3 Algoritmos: o que existe e o que é novo

**Já existem:**
- degree, weighted-degree, PageRank, eigenvector, betweenness, closeness, HITS e
  edge-betweenness (`algorithmRegistry.ts`);
- Louvain e similaridade;
- BFS e ego k-hop;
- métricas customizadas com `ctx.neighbors`, `ctx.edgesOf` e `ctx.degreeOf`. Elas
  bastam para padrões de 1 salto, como contar entradas e saídas.

**Novos**, em ordem de prioridade. Todos rodam em worker sobre graphology, porque o
`metricsWorker` já monta o multigrafo direcionado. Versões em SQL ficam para a F5.

| # | Algoritmo | Para quê | Observação |
|---|---|---|---|
| 1 | **Rastreio temporal de fluxo**: para frente e para trás, t(saída) ≥ t(entrada), Δ máximo, limite de saltos, valor mínimo, paradas por tipo de nó; alocação FIFO, proporcional, LIBR e poison (limite superior) | O núcleo do follow the money | Buffers por nó em ordem temporal (Kosyfaki, ICDE'21), O(E log E). Devolve o valor rastreado por aresta, recebido, repassado e retido por nó, o total por saída e a camada de cada nó |
| 2 | **Caminhos**: mais curto (com e sem peso), k mais curtos (Yen), todos os caminhos simples com limite de saltos, **caminho que respeita o tempo** (chegada mais cedo) | "Como o dinheiro chegou de A até B" | Dijkstra/bidirecional existem prontos em `graphology-shortest-path` (dependência nova); Yen e temporal são implementação própria |
| 3 | **Agregação de arestas paralelas**: soma, contagem, mín/máx, primeira e última data, por par e direção | Exibição, Sankey, largura por valor | Simples; exige resolver o #28 antes |
| 4 | **Resolução de entidades**: normalização determinística (dígitos de CPF/CNPJ, padding de conta), fuzzy (Jaro-Winkler em nome + CPF mascarado parcial do QSA), blocking | Unir contexts e arquivos | Sai como "match link" com score e motivo, nunca merge silencioso |
| 5 | **Detecção de tipologias em janela de tempo**: fan-in e fan-out na janela; passagem (entrada ≈ saída dentro de Δ, retenção baixa); fracionamento (N transações abaixo do limiar na janela); **ciclos temporais** (Johnson com limite); hubs de atributo compartilhado (dispositivo, IP, endereço); dormente que vira ativo | Selos ligados aos itens da CC 4.001 | Os de 1 salto já dão para fazer como métrica customizada. Janela, ciclos e explicabilidade pedem implementação nativa |
| 6 | **Componentes conexos** (fracos e fortes) | Separar anéis independentes | Trivial; hoje só existe o "Orphan Clusters" |
| 7 | **Métricas em janela de tempo**: grau e volume na janela | Comparar períodos | Extensão do registry |

### 4.4 Layouts: o que existe e o que é novo

**Já existem:** force (2D e 3D), ego (radial e em camadas), hive, hierárquico (com
`traversal:'out'` já documentado como "money flow"), circular e grid.

| Novo | O que mostra | Base |
|---|---|---|
| **Fluxo em camadas do rastreio** | x = salto a partir da semente (ou tempo); nós de cada camada ordenados para reduzir cruzamentos; largura da aresta = valor rastreado; saídas fixas à direita | Estende o hierárquico |
| **Linha do tempo em raias** (swimlanes) | Uma raia por conta (y) e x = tempo; cada transação é uma seta entre raias no seu horário. Mostra permanência, divisão e a "corrida" de minutos de um golpe Pix | Novo. É a visão que mais conta a história do rastreio |
| **Sankey** (visão, não layout de grafo) | Semente → camadas → saídas, ou centrado num ator; clique na faixa abre as transações | Novo; `d3-sankey` |
| **Bipartido** | Lojistas × sócios, cartões × lojistas (card testing), contas × dispositivos | O hive com 2 eixos por `node_type` já se aproxima; talvez baste um preset |
| **Mapa** (depois) | Terminais, agências, CEP (CC 4.001 IV-z: POS longe do lojista) | Novo; exige geocodificação. Baixa prioridade |

Além disso, **posições fixadas passam a ser persistidas** nas evidências. Hoje o
snapshot guarda só x/y, sem o flag de fixado.

### 4.5 Novas formas de interação e de documentação

**Interação:**
- **Workspace da investigação**: abas de explorações + visão unificada + **seleção
  vinculada** entre abas.
- **"Adicionar à investigação"** a partir de qualquer exploração, seleção, resultado do
  Query Console ou cluster.
- **Rastreio interativo**:
  - clique direito → "Seguir o dinheiro → para frente / para trás";
  - "+1 salto" para avançar camada a camada;
  - parâmetros ao vivo num painel;
  - marcar um nó como saída para encerrar o ramo.
- **Papéis nas entidades** (vítima, suspeito, laranja, saída, descartado), que dirigem o
  estilo e o relatório.
- **Timeline com seleção de janela** (brushing) ligada ao grafo e ao Sankey, com
  reprodução no tempo.
- **Fila de revisão de matches**: aceitar ou rejeitar, com motivo, e isso vai para o
  diário.
- **Inspector com abas de enriquecimento**: tabelas extras do context e arquivos do caso,
  consultados sob demanda.
- **Desfazer e histórico** do estado da investigação. Hoje só há desfazer para regras,
  clusters e métricas.

**Documentação do caso:**
- **Diário automático**: cada query, upload (com hash), merge, rastreio (com
  parâmetros) e decisão de match, com data, hora e autor. Dá reprodutibilidade, cadeia
  de custódia e atende a Circ. 3.978 art. 40.
- **Notas ancoradas** em nó, aresta, região do canvas ou evidência, com @menções.
- **Evidências fixadas**: estado congelado do grafo com legenda, parâmetros e hash.
- **Hipóteses**: uma lista leve no estilo ACH (análise de hipóteses concorrentes), com
  evidências a favor e contra e um status.
- **Dossiê gerado**: resumo, entidades, fluxos rastreados (com o método), indicadores da
  CC 4.001 encontrados, decisão e fundamentação, hashes dos arquivos. Exporta em PDF, como
  pacote CSV/JSON e como resumo para o Siscoaf.
- **Docs públicas**: guias novos em `docs/guide/` para investigações, importação de
  arquivos, tabelas de enriquecimento e follow the money.

### 4.6 AI-first e armazenamento no Volume

**Armazenamento:**
- Todo arquivo do caso (uploads, fontes congeladas, evidências, artefatos,
  exportações) vai para o Volume do Unity Catalog via Files API, ou para um diretório
  local em dev.
- A raiz é o setting `investigations_volume_path`.
- Upload em streaming, com sha256 calculado durante o recebimento.
- Endereçado por conteúdo, nunca sobrescrito; acesso só pela API.
- Detalhes em [03 §2.3](investigation/03-arquitetura.md#23-armazenamento-no-volume).

**AI-first:** um agente de IA (Claude Code, Claude Desktop ou outro cliente MCP)
trabalha no caso em nome de uma pessoa, com o acesso dela.
- **Identidade:** token `glt_` criado pelo usuário, com escopos `read`, `analyze`,
  `write` e `propose`, validade e revogação.
- **Servidor MCP em `/mcp`:** ferramentas para ler o caso e o grafo, rodar rastreio,
  caminhos e tipologias no servidor, anotar, fixar evidências, subir arquivos e
  artefatos (em rascunho) e propor. Atrás do proxy do Databricks, usa uma ponte local
  stdio.
- **Pessoas decidem:** papéis, matches, hipóteses, tipologias e status viram
  **propostas** que uma pessoa aceita. Decisão, comunicação, DICT, compartilhamento,
  apagar e aprovar artefato **nunca** são do agente.
- **Dados pessoais** vão mascarados para agentes por padrão (LGPD), e conteúdo de
  dados volta marcado como não confiável (prompt injection).
- **Cobertura obrigatória:** um teste de registry faz toda rota nova ter ferramenta MCP
  ou ser marcada como só humana.
- **Telas:** T10 (espaço do caso) e T11 (agentes).
- Detalhes em [03 §8](investigation/03-arquitetura.md#8-ai-first-agentes-na-investigação).

---

## 5. Plano de design (como vou projetar)

**Ferramenta.** Um canvas de design com artboards (pranchas): diagramas editáveis,
telas hi-fi e um protótipo com links entre telas.

**Linguagem visual.** O design segue a linguagem do Graph Lagoon, sem inventar marca:
- teal `#14b8a6` como primária e navy `#0d1b2a` na toolbar;
- superfícies `#ffffff` e `#f5f5f5`, fonte do sistema, raios 4/6/8 e densidade
  compacta de 13–14 px, tudo tirado de `frontend/src/assets/main.css`.

Entram três escalas semânticas novas, todas distinguíveis também por luminosidade
(nada de vermelho contra verde):
- **proveniência** (cor categórica por fonte);
- **valor** (sequencial);
- **risco** (laranja contra azul).

**Dados.** Todos fictícios: CPFs mascarados, valores plausíveis em R$, nenhuma pessoa
real.

### 5.1 Personas e fluxos heróis

| Persona | Fluxo herói |
|---|---|
| **P1** Analista de prevenção a fraude em adquirente | **F-B "Rede de lojistas de fachada":** lojista alertado → importar QSA e domicílios → resolver sócios, telefones e dispositivos compartilhados → anel de lojistas → dossiê |
| **P2** Analista PLD/FT em banco ou IP | **F-A "Golpe Pix → rastreio":** notificação MED → transação semente → rastreio de 3 camadas → saídas (saque, cripto, bet) → marcar contas e comunicar |
| **P3** Perito de LAB-LD ou auditoria interna | **F-C "Quebra de sigilo SIMBA":** upload dos 5 arquivos → detecção automática → grafo → rastreio → laudo |

O F-A é o primeiro a prototipar, porque concentra o pedido de follow the money e
espelha o MED 2.0. O F-B vem logo depois, por ser o que mais diferencia o produto para
adquirentes.

### 5.2 Fases do design

| Fase | Entregável no canvas | Decisão que fecha |
|---|---|---|
| **D0 Mapa do sistema** | Diagrama editável: fontes → grafo de trabalho → análises → dossiê → exportações, mais o modelo de objetos de §4.1 | Escopo e vocabulário (Investigação, Fonte, Rastreio, Evidência) |
| **D1 Direções de layout** (low-fi) | 3 wireframes do workspace. **A** *Canvas-first*: grafo central, fontes à esquerda, inspector à direita, timeline embaixo. **B** *Cockpit*: grafo, Sankey e timeline em divisão sincronizada. **C** *Dossiê-first*: documento do caso com blocos vivos de grafo | Qual estrutura seguir |
| **D2 Telas hi-fi** | (0) Configuração do context: chaves de identidade e tabelas de enriquecimento (§4.1b); (1) Fila de investigações com prazos de 45+45 d; (2) Workspace: abas de explorações de contexts diferentes, visão unificada, seleção vinculada; (3) Adicionar à investigação (explorações de outros contexts, prévia de sobreposição pelas chaves, conflitos); (4) Assistente de arquivo (papel grafo/enriquecimento/anexo → detectar SIMBA/QSA/genérico → mapear colunas → identidade e dedup → revisão e salvar mapeamento); (5) Enriquecimento e resolução de entidades (abas no inspector, match links, promover a nós); (6) Rastreio: configuração e resultado em fluxo por camadas, Sankey e tabela por salto, com o carimbo do método; (7) Timeline em raias ligada ao grafo; (8) Dossiê: diário, notas, hipóteses, evidências, selos CC 4.001, decisão e exportação; (9) Revisão de matches; (10) Anel de lojistas; (11) Espaço do caso com artefatos; (12) Agentes: conexão, propostas, atividade. As telas finais são T1–T11 em [investigation/02-design.md](investigation/02-design.md) | Detalhe de interação de cada tela |
| **D3 Protótipo clicável** | F-A de ponta a ponta, com links entre as telas | Se o fluxo fecha sem atrito |
| **D4 Validação → engenharia** | Revisão do fluxo contra o checklist §1.2 e §2.1 (art. 43, CC 4.001); roteiro de 5 perguntas para analistas reais; cada tela vira épico de §6 | Prioridade de implementação |

---

## 6. Roadmap de engenharia (após o design)

| Fase | Escopo | Reaproveita | Bloqueios |
|---|---|---|---|
| **F1 Fundação** | Entidade Investigação (DB, memory store, registries do admin) com **N explorações de contexts diferentes**; chaves de identidade no context; visão unificada com proveniência; seleção vinculada; notas e pins; permissões `investigation.*`; auditoria de leitura | Snapshot, dedup do `expandFromNode`, clusters, `admin_registry`, `permission_catalog` | #28; o clear das comunidades a cada troca de `nodes` |
| **FA AI-first** | Tokens de agente com escopos; armazenamento do caso no Volume em streaming; espaço de artefatos versionados (T10); propostas com aceite humano (T11); servidor MCP em `/mcp`; ponte stdio para o Databricks; registry que obriga cobertura MCP | Camada de serviço da F1, `BlobStore`, `require_permission`, auditoria | Proxy do Databricks Apps (Q7) |
| **F2 Arquivos e enriquecimento** | **Tabelas de enriquecimento no context** (+ `sql_scope.context_tables` + endpoint parametrizado + auditoria); **context de arquivo** (datasource `file`); parser em worker; assistente; mapeamentos salvos; presets SIMBA/QSA/genérico; upload com hash; arquivos como enriquecimento e como anexo; gravar métricas como propriedade; promover a nós e arestas; resolução de entidades (algoritmo 4) | `/nodes/batch`, `detectType`, `rest/mapping.py`, worker de métricas customizadas, `injectEdges`, datasource factory | M4 (injeção em CSV) |
| **F3 Follow the money** | Modelo temporal; algoritmos 1–3 e 6 (§4.3); layouts de fluxo em camadas, raias e Sankey (§4.4); timeline com seleção de janela; rastreio e caminhos também no servidor (Python, mesma fixture) para os agentes | `metricsWorker` (graphology), layout hierárquico, ego, hive | #28 |
| **F4 Dossiê e compliance** | Diário automático, hipóteses, evidências congeladas; status, responsável e prazos; decisão fundamentada; exportação (PDF, CSV, SIMBA, resumo Siscoaf); retenção; tipologias (algoritmo 5) com selos CC 4.001 | Auditoria, regras de label, métricas customizadas | #32 (sandbox) |
| **F5 Escala e IA** | Promover fontes ao warehouse (schema de rascunho em Delta); rastreio em SQL; narrativa assistida por LLM com revisão humana (LGPD art. 20) | gsql2rsql/VLP, datasource factory | n/a |

---

## 7. Riscos e perguntas em aberto

- **Teto do grafo de trabalho no browser.** Medir com `make perf-report`. Os extratos
  SIMBA de um caso costumam ter de milhares a centenas de milhares de linhas, mas isso
  é **estimativa, a medir**.
- **Onde o dado sigiloso fica.** No Volume do caso (§4.6). O limite de tamanho por
  request do Databricks Apps e da Files API está **a confirmar**; se for baixo, entra
  upload em partes.
- **Agentes e LLMs.** Mandar dado de cliente a um provedor de LLM é transferência de
  dado pessoal: o padrão é mascarar, e só o admin libera. Prompt injection vindo dos
  dados é tratado marcando o conteúdo como não confiável.
- **Acesso de agentes no Databricks Apps.** O proxy exige login do Databricks; se o
  `/mcp` remoto não for alcançável, usa-se a ponte local stdio.
- **Profundidade do MED 2.0.** A fonte oficial fala em 2ª camada; fontes secundárias
  falam em 5 (**incerto**). Isso afeta o default de saltos.
- **Siscoaf.** Sem API pública conhecida; o produto só exporta (**a confirmar**).
- **Match com CPF mascarado** do QSA: sempre revisão humana.
- **Escopo regulatório.** O produto apoia a análise mas não a substitui: a Circ. 3.978
  art. 44 proíbe terceirizar a análise.

---

## 8. Fontes principais

- i2 import specifications: https://docs.i2group.com/anb/9.4.0/create_a_specification.html · link summarization (Flow): https://docs.i2group.com/analyze/4.4.1/configuring_link_summarization.html
- Linkurious CSV import: https://doc.linkurious.com/admin-manual/latest/import-csv/ · ER (Senzing): https://doc.linkurious.com/admin-manual/4.2/entity-resolution-requirements/ · preços: https://linkurious.com/pricing/
- Quantexa (G-Cloud): https://www.applytosupply.digitalmarketplace.service.gov.uk/g-cloud/services/235413955896497
- Chainalysis Reactor: https://www.chainalysis.com/chainalysis-reactor/ · preço (G-Cloud): https://www.applytosupply.digitalmarketplace.service.gov.uk/g-cloud/services/721145525030910
- TRM Forensics: https://www.trmlabs.com/products/forensics · Elliptic Investigator: https://www.elliptic.co/products/investigator/
- Lucinity Money Flow: https://lucinity.com/blog/luci-widgets · Valid8: https://www.valid8financial.com/use-cases/financial-crime
- Unit21 (SAR/goAML): https://docs.unit21.ai/docs/fincen-reports
- Kosyfaki et al., flow tracing (ICDE'21): https://arxiv.org/pdf/2003.01974 · Anderson et al. (FIFO vs haircut, WEIS'18): https://www.cl.cam.ac.uk/~rja14/Papers/bitcoin-redux-weis2018.pdf · AMLworld (NeurIPS'23): https://arxiv.org/html/2306.16424v1
- Circ. BCB 3.978/2020: https://normativos.bcb.gov.br/Lists/Normativos/Attachments/50905/Circ_3978_v6_P.pdf · CC 4.001/2020: https://normativos.bcb.gov.br/Lists/Normativos/Attachments/50911/C_Circ_4001_v4_P.pdf
- MED 2.0, Fórum Pix BCB (4/12/2025): https://www.bcb.gov.br/content/estabilidadefinanceira/pix/Forum_Pix_Plenaria/20251204-Forum_Pix.pdf · Res. BCB 493/2025: https://www.demarest.com.br/en/banco-central-publica-resolucao-que-aperfeicoa-procedimentos-do-pix-resolucao-bcb-no-493/
- Res. BCB 587/2026 (DICT): https://cesconbarrieu.com.br/resolucao-bcb-no-587-2026-novas-obrigacoes-e-impactos-para-participantes-do-pix/ · Res. Conj. 6/2023: https://www.mattosfilho.com.br/unico/resolucao-dados-fraudes/
- Portaria SPA/MF 566/2025: https://www.migalhas.com.br/depeso/427163/a-portaria-566-da-spa-mf-e-as-instituicoes-financeiras-e-de-pagamento
- SIMBA, MI001-SPPEA v3.1: https://www.ancord.org.br/wp-content/uploads/2021/08/MI-001_SigiloBancario_Bancos-3-arquivos-para-publicacao-no-ASSPAWEB-PGR-00269961-2021.pdf · diagnóstico ENCCLA 2019: https://www.gov.br/mj/pt-br/assuntos/sua-protecao/lavagem-de-dinheiro/enccla/acoes-enccla/arquivos-enccla-2019/e2019a10-produto-i-diagnostico-simba.pdf
- CNPJ aberto (layout): https://www.gov.br/receitafederal/dados/cnpj-metadados.pdf
- Laranjas (Serasa): https://www.serasaexperian.com.br/sala-de-imprensa/prevencao-a-fraude/contas-laranja-potenciais-crescem-mais-de-60-em-dois-anos-no-brasil-aponta-estudo-da-serasa-experian/
