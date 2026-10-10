# 05 · Investigações v2: redesenho do produto, da UX e do modelo

> Status: **aprovado em 2026-10-10**, substitui a execução de [04-plano-de-implementacao.md](04-plano-de-implementacao.md)
> (concluída em `feature/investigations`, nunca publicada). As fases abaixo são as tarefas novas;
> progresso marcado nos checkboxes da seção 10 e no decision log.

## Contexto

O branch `feature/investigations` implementou o plano original (G1–F4.6, ~60 commits, +41k linhas, nunca publicado; migrações 016–019 nunca rodaram em Postgres). Três auditorias independentes (UX no app rodando, backend/permissões, fluxo de análise) mais a revisão do mantenedor chegaram ao mesmo veredito: o sistema funciona nos testes, mas é inoperável e sem sentido para um analista real.

**Os erros de raiz, em ordem:**

1. **O caso trava depois de criado.** Não há UI para editar título, status, responsável, compartilhar, apagar, remover fonte ou reabrir. O status "análise" só é alcançado se um agente propuser. Becos sem saída: explorações vazias de terceiros que não dá para remover.
2. **Sete conceitos para "coisas no caso"** (fontes, arquivos, artefatos, evidências, notas, matches, propostas) em quatro painéis. Um upload SIMBA cria arquivo + context global + exploração + fonte + aba com o mesmo nome. Um humano que sobe um documento precisa aprovar o próprio rascunho.
3. **Só exploração salva entra no caso**, por uma lista de 215 itens com título UUID. Resultado de query, tabela, seleção do grafo, documento e link não entram. Não existe "consulta salva do caso" que reexecute no Databricks e versione resultado para relatório.
4. **O agente é tutelado e inseguro ao mesmo tempo.** Token `glt_` aceito em toda rota REST sem máscara (pode compartilhar um context com `*`), mas no MCP não pode criar exploração nem rodar query. Matriz "direto/propõe/nunca" + tabela de propostas + tela própria.
5. **Domínio chumbado em golpe Pix:** 4 papéis fixos, "vítima" como semente, tipologia como coluna, prazo contado da criação do caso. O produto precisa servir crédito de grupo econômico, fuga de garantia, fraude, lavagem, revisão de lojista.
6. **Workspace mutilado:** abas por fonte resetam layout; agrupar exige programa JS; multi-seleção inútil; rótulos são ids crus; nós enormes; sem zoom-to-fit; "seguir o dinheiro" só por botão direito e frágil; chaves de identidade e semântica só no formulário do context.
7. **Cerimônia sem valor:** journal com hash encadeado O(n) nunca verificado; congelar-ao-adicionar; escopos read/analyze fictícios; enums em português; retenção que não apaga nada.

**Decisões do mantenedor (fechadas):** reescrever o modelo de dados; manter os dois motores (TS + Python, com fixtures de paridade); compliance BR fica no núcleo; sugestões do agente **no lugar** (sem tabela de propostas, sem tela T11); o agente age **com a identidade da pessoa** (MCP na máquina dela) e pode quase tudo; o caso é um **workspace vivo** onde se adiciona material muitas vezes; **consultas salvas do caso** com execuções versionadas são de primeira classe.

---

## Princípio de design

**Um caso é um lugar só.** Uma tela, um canvas, uma lista de material, um inspector, uma faixa de tempo/atividade. Tudo o que entra (exploração, consulta, tabela, documento, nota, resultado de análise, texto do agente) é um **item do caso** com a mesma ficha, o mesmo chip de autor e o mesmo botão "fixar versão". Não há páginas secundárias; há modos do mesmo lugar.

---

## 1. Modelo de dados (migração única `016_cases.py`; apagar 016–019 atuais)

```
investigations   id, title, description, kind_preset (credito|garantia|pix_med|lavagem|lojista|livre),
                 status (open|analysis|decided|archived), owner_email, assignee_email,
                 occurred_at, alert_at, deadline_days JSON (override), tags JSON,
                 settings JSON {identity_keys, edge_semantics, enrichment_tables,
                                agent_suggest_kinds, label_templates, vocabularies},
                 state JSON {layout, pins, views, groups_closed},   -- só visualização
                 decision JSON, frozen_hash, frozen_at, created_at, updated_at
investigation_shares  investigation_id, email, role (reader|editor)
                 -- assignee ⇒ share editor automático; PATCH assignee só por quem pode compartilhar
case_items       id, investigation_id, kind (graph|table|query|document|note),
                 subkind  graph: exploration_ref|snapshot|selection|derived|view
                          table: result|csv|enrichment|metrics
                          query: sql|cypher
                          document: upload|markdown|link|brief
                          note: free|anchored
                 title, description, tags JSON, status (suggested|confirmed|rejected),
                 author_kind (human|agent), author_email, agent_token_id,
                 provenance JSON {context_id, exploration_id, query_item_id, run_id,
                                  tool, params, parent_item_id, tool_call_id},
                 exploration_id (ref viva, nullable), context_id (nullable),
                 query JSON {text, language, parameters[], output (table|graph)},
                 mapping JSON {as: graph|enrichment, spec},   -- do caso, nunca context global
                 anchor JSON {entity_ids[], edge_ids[], item_id},
                 current_version, position, created_at, updated_at, deleted_at
case_item_versions  item_id, version, sha256, blob_key, size_bytes, content_type,
                 text_blob_key (extração textual p/ busca e MCP),
                 run JSON {statement_id, started_at, duration_ms, row_count, params, run_by, author_kind},
                 created_by, author_kind, created_at,
                 pinned_at, pinned_by, pin_label         -- evidência = versão fixada; imutável
case_annotations id, investigation_id, kind (role|tag|group|same_as|hypothesis|hypothesis_status|typology),
                 targets JSON (entity_ids | item_ids), value JSON, reason,
                 status (suggested|confirmed|rejected), author_kind, author_email, agent_token_id,
                 confirmed_by, confirmed_at, created_at
investigation_events  append-only (id, investigation_id, actor_email, actor_kind, agent_token_id,
                 kind, payload, created_at)  -- sem prev_hash; frozen_hash calculado ao decidir, verificado no export
agent_tokens     id, name, owner_email, token_hash, scope (user|case), investigation_ids JSON,
                 unmasked bool, expires_at, revoked_at   -- sem escopos read/analyze/write
org_vocabularies kind (role|tag|typology_preset), values JSON
org_library      playbooks e templates em markdown (itens de um caso-sistema), lidos por MCP
```

**Removidos:** `investigation_sources`, `investigation_files`, `investigation_artifacts(+versions)`, `investigation_evidence`, `investigation_notes`, `entity_matches`, `investigation_proposals`, `state.roles/hypotheses`, modo `frozen` ao adicionar, `prev_hash`, rota `files/{id}/context`, exceção em `utils/context_access.py`, enums PT (i18n só no front).

**Consulta salva do caso** (`kind=query`): texto SQL/Cypher, context, parâmetros (ex.: lista de CPFs vinda da seleção), saída tabela ou grafo. "Executar" cria uma **versão** com `run` (statement_id do warehouse, duração, linhas) e o resultado como blob. Reexecutar = nova versão; comparar duas versões; fixar uma como evidência; "usar no dossiê" embute a última ou a fixada. Reusa `routers/query_templates.py` (schema de parâmetros) e `services/datasource/sql_warehouse.py::execute_prepared` + poll por `statement_id`.

---

## 2. Arquitetura de informação

**Duas telas:** `/investigations` (Fila) e `/investigations/:id` (Caso, com `?mode=canvas|dossie`). Nada mais é página.

- **Fila:** título + id curto (`#0412`), tipo, status, prazo, responsável, atualizado, "N sugestões". Ações na linha: abrir, editar, compartilhar, arquivar, excluir. Filtros por tipo/responsável/status, busca por entidade, ordenação, marcador "compartilhado/só leitura". Admin vê a mesma fila com "todos os casos" e "transferir".
- **Caso atual, app-wide:** chip fixo na barra superior `[● Golpe Pix · #0412 ▾]` (store `currentCase`, id persistido em localStorage, acesso validado ao carregar). Define o alvo de "Adicionar ao caso" em explorações, console, tabelas.
- **Dossiê** = `mode=dossie`: mesma store, layout de documento (resumo, brief, hipóteses, evidências fixadas, tabelas de consultas fixadas, decisão, diário), `@media print`. Exportações ficam aqui e no painel de decisão.
- **Tokens/agentes:** `/settings/agents` (menu do avatar). Lista de tokens com escopo "todos os meus casos" ou casos específicos, flag "dados sem máscara" (se a org permitir), validade, comando `claude mcp add`, revogar. No caso só o indicador "1 agente conectado" no rodapé.
- **Preferências do caso:** drawer ⚙ no header (nome, tipo, prazos, membros/compartilhamento, quais tipos de escrita do agente ficam "sugeridos", vocabulários de papel/tag, chaves de identidade, semântica de valor/tempo, templates de rótulo).

---

## 3. A tela do caso

```
┌ barra app ──────────────────────────────── [● Caso atual ▾] [user] ┐
│ ← Fila │ Golpe Pix · falsa central  #0412  [Em análise ▾] ⏱ 31 d  │
│         [Dossiê] [Decidir] [⚙] [Compartilhar]   [Pessoa|Agente|Tudo] │
├──────────┬───────────────────────────────────────┬──────────────────┤
│ MATERIAL │ chips: fonte▾ papel▾ tag▾ grupo▾ tipo▾ │ INSPECTOR        │
│[+ Adicionar]│      ⏱ janela▾  👁 mascarado   ✕    │ entidade │       │
│ ★ Brief   │                                        │ seleção  │       │
│ ▸ Grafos 3│          CANVAS (um só)                │ item     │       │
│ ▸ Consultas 2│                                     │                  │
│ ▸ Tabelas 2│  [Seguir $][Caminhos][Grupos]         │                  │
│ ▸ Documentos│ [Tipologias][Enriquecer][Métricas]   │                  │
│ ▸ Notas 7 │  [Filtros][Tabela][Layout][Fit ⤢]      │                  │
│ ▸ Análises 4│                                      │                  │
│  sugeridos 3│                                      │                  │
├──────────┴───────────────────────────────────────┴──────────────────┤
│ ▤ Linha do tempo │ ▤ Atividade (pessoa/agente) │ ● 3 sugestões │ 38 nós │
└─────────────────────────────────────────────────────────────────────┘
```

- **Header:** título editável inline; status como select com transições (`open→analysis→decided→archived`, reabrir `decided→analysis` só humano, com evento); prazo com barra (laranja `#9a3412` < 7 dias), só quando o tipo tem fase (Pix/MED 45+45; demais, opcional).
- **Canvas:** um grafo unificado; **sem abas por fonte**. Fonte vira chip de filtro (anel de proveniência). Chips multi-valor filtram visualmente (reuso de `FilterPanel` com `mode="chips"`), não refazem layout. Botões de análise abrem **popovers de parâmetros** (nunca só menu de contexto): Seguir o dinheiro (semente = seleção, direção, regra, Δ, valor mínimo, janela, paradas), Caminhos (origem/destino por clique, respeita tempo, k), Grupos (§5), Tipologias (lista CC 4.001 com parâmetros editáveis), Enriquecer (tabela do context ou documento do caso, chave, colunas), Métricas (`MetricsPanel` + "salvar como tabela do caso"). Quando faltam `amount/time`, o popover diz quais colunas configurar e leva ao ⚙ do caso.
- **Múltiplas tabelas, sem limite.** Cada consulta, CSV, resultado de enriquecimento ou tabela de métricas é um item independente; um caso acumula quantas precisar. Operações entre tabelas, pela multi-seleção no material: **Juntar** por chave (ex.: KYC + exposição por CPF → tabela nova com provenance dos pais), **Comparar** duas tabelas quaisquer (não só execuções da mesma consulta), **Promover em lote** a enriquecimento com chave comum, **Unir no grafo** várias tabelas com mapeamento próprio cada (cada uma vira fonte com anel). O agente tem `join_tables` e as mesmas promoções.
- **Resultado = item, nunca estado volátil.** Toda análise devolve item `graph|table` com provenance {ferramenta, parâmetros, sha256}; aparece em "Análises" e como camada no canvas. Re-rodar = nova versão; "Fixar" congela. `TracePanel`/`TraceSankey`/`SwimlaneTimeline`/`PathBar`/`TypologyBadgesPanel` viram **renderizadores de item** (recebem dados por prop, não do store `trace`); o store `trace.ts` some.
- **Material (esquerda):** lista única agrupada por kind, busca, contador de sugeridos. Linha: **checkbox "no canvas"** (substitui as abas por fonte: marcar/desmarcar adiciona ou remove nós sem resetar o layout), ícone, título, id curto (`G3`, `Q2`, `D1`), chip autor, "sugerido" (fundo `#fffbeb`, borda `#b45309`), 🔗 vivo / 📌 fixado v3. Drag-and-drop e **colar** (texto → nota; URL → link; TSV → tabela).
- **Consulta do caso (item `query`):** cartão com context, SQL truncado, última execução ("há 2 h · 1.240 linhas · 3,1 s · por agente"), botões **Executar de novo**, **Histórico (n)**, **Usar no relatório**. No inspector: editor SQL/Cypher (`CypherEditor`), parâmetros declarados (`:cpfs`, `:de`, `:ate`) com fonte **valor fixo | seleção atual | grupo | propriedade**, saída `tabela | grafo` (se grafo, o mesmo passo de mapeamento do arquivo). Histórico: execuções com sha256 curto, linhas, `statement_id`, duração, autor; **Comparar 2** (diff de linhas por chave); **Fixar** uma execução = evidência; **Promover** → grafo (fonte própria com anel) ou → enriquecimento (coluna-chave; dados aparecem no inspector das entidades). Botão **Console** na barra de análise abre `QueryConsolePanel` como gaveta sobre a faixa inferior, com "Salvar como consulta do caso".
- **Inspector (direita), três estados:** *Entidade* (título pelo template de rótulo, anéis de fonte, papel/tags livres com sugestões do vocabulário, "Dados", "Itens que a citam", "Eventos", enriquecimento, nota no rodapé). *Seleção múltipla* (contagem, composição; em lote: papel, tag, **Agrupar**, Mesmo que, nota, salvar seleção como item, comparar lado a lado, usar como parâmetro de consulta). *Item* (ficha, versões/runs, confirmar/recusar se sugerido, fixar, abrir como tabela, usar no dossiê).
- **Faixa inferior:** Linha do tempo (`SwimlaneTimeline` sobre tudo que tem data; brush filtra o canvas), Atividade (journal com filtro pessoa/agente/sistema; clique leva ao item), Sugestões (confirmar em lote por ferramenta). Sem overlay FPS.
- **"Sugerido" inline:** borda tracejada âmbar + chip "sugerido · agente Claude, por você"; `✓ Confirmar · ✕ Recusar` no próprio lugar. Nunca abre outra tela.
- **Estados vazios** dizem o que fazer e trazem os botões ("Adicione uma exploração recente, comece uma nova a partir de um context, ou arraste um arquivo").
- **Legibilidade:** templates de rótulo por tipo (`labelFormatter` + `LabelRuleEditorModal`; fallback `name → razao_social → doc mascarado → tipo + id curto`); mascarado por padrão com toggle 👁 auditado; nós base pequenos com escala por métrica; anéis finos; `zoomToFit` (já existe em `useGraphCamera.ts:212`) em botão e ao carregar; pt-BR em datas e moeda; primário `#0f766e`; nunca UUID cru.

---

## 4. Adicionar ao caso (o loop vivo)

- **No caso, `+ Adicionar`** é um popover com abas: **Minhas explorações recentes** (título, context, nº nós, data; busca server-side; vazias desabilitadas; "todas" só como toggle de superuser), **Nova exploração** (escolhe context legível → abre `GraphVisualizationView?case=ID` com breadcrumb "← Caso"; salvar auto-anexa como `exploration_ref` e volta), **Consulta** (`QueryConsolePanel` embutido com seletor de context; resultado → "Salvar como consulta do caso" e/ou "Adicionar resultado como tabela/grafo"), **Arquivo** (2 passos: o que é [grafo | enriquecimento | documento] → mapeamento com preset detectado e prévia; editor JSON como "avançado"), **Colar/link**.
- **Fora do caso:** botão `Adicionar ao caso #0412 ▾` em exploração (Toolbar), Query Console (ao lado de CSV/TSV, usa `rawColumns/rawRows`), `DataTablePanel`, seleção do grafo (menu de contexto e inspector), `EnrichmentTab`, resultados de trace/caminho. Um clique, toast "ver no caso". Composable `useAddToCase()`.
- **Agente:** `add_item`, `run_query`, `create_exploration` (mesmas rotas).
- **Ref viva × pin:** item `exploration_ref` e `query` evoluem; "Fixar" cria versão imutável com motivo. Fontes só se congelam todas na decisão.
- Backend: `GET /api/explorations` ganha `q`, `mine`, `limit`, `cursor`, `node_count` (hoje não tem busca nem paginação).

---

## 4b. Entidades genéricas: pessoas, contas, e-mails, telefones, dispositivos, maquininhas, fraude sintética

O núcleo do grafo já é genérico: `IdentityKey` aceita qualquer `node_type`, e as tipologias são padrões estruturais (passagem, concentração, fracionamento, ciclo, hub de atributo, dormente). A rigidez está nas bordas e o plano a remove:

- **Normalizadores de chave de identidade** (`utils/identityKeys.ts` + `services/case_graph.py`): hoje `cpf_cnpj | account | phone | email | lower | none`. Adicionar `device_id`, `ip`, `pix_key` (detecta tipo da chave), `card` (BIN + últimos 4), `terminal_id`, `address` (normalização simples de endereço), e `regex` configurável (captura + lowercase). Vocabulário de entidade sugerido por preset de caso, nunca obrigatório.
- **Semântica de aresta genérica** (`settings.edge_semantics` por tipo de relação): além de `amount/time` para dinheiro, `weight` e `timestamp` para qualquer relação (login, uso de dispositivo, transação em terminal). Seguir o dinheiro usa `amount`; caminhos e linha do tempo usam qualquer `timestamp`.
- **Fraude sintética e vínculo por atributo:** a resolução de entidades (`utils/entityResolution.ts`, `services/entity_resolution.py`) hoje casa só por documento e nome. Passa a casar também por **atributos compartilhados** (telefone, e-mail, dispositivo, IP, endereço, conta, maquininha) e a gerar **arestas derivadas** `compartilha_<atributo>` como item `graph/derived` com provenance. Um popover **Vínculos** na barra de análise: "ligar entidades que compartilham [atributos]" com limiar mínimo e exclusão de atributos comuns demais (ex.: IP de operadora). Grupos e tipologias passam a enxergar essas arestas. A tipologia `hub_atributo` é o caso particular "N partes não relacionadas compartilham X".
- **Presets de caso** (`kind_preset`): `livre` (nenhum vocabulário imposto), `credito`, `garantia`, `pix_med`, `lavagem`, `lojista`, `fraude_sintetica` (papéis sugeridos: identidade real, identidade sintética, mula, ponto de cash-out; atributos de vínculo padrão: telefone, e-mail, dispositivo, endereço). Preset só preenche defaults; tudo editável no ⚙ do caso.
- **Aceite (adicionar ao F4):** um grafo com Pessoa, E-mail, Telefone, Dispositivo, IP, Cartão, Conta, Empresa, Terminal e Endereço entra sem mudança de código; `Vínculos` por telefone + dispositivo revela um cluster sintético; o grupo é criado da seleção e aparece no dossiê.

## 5. Agrupar sem código

- **Seleção → Agrupar:** nome, cor (8), opcional "fechar" (colapsa em nó-cluster via rendering de cluster fechado em `stores/graph.ts enhancedNodes` e `ClusterNodeModal`).
- **Grupos → por…:** propriedade, papel, tag, comunidade (`communityStore.runDetection`, Louvain), componente conexo (`utils/graphComponents.ts`). Nomes legíveis ("uf = SP", "Comunidade 3 · 14 nós"), editáveis.
- Grupo = `case_annotations kind=group` (persistido, com autor). Vira chip de filtro, pode fechar/abrir, "pintar por grupo".
- **Visões salvas** = item `graph/view` (chips + layout + grupos fechados + câmera). `ClusterProgramPanel` (JS) fica em "Avançado".

---

## 6. AI-first: o agente é um analista com a identidade da pessoa

> Esta seção **substitui** a matriz "direto / propõe / nunca" de `docs/dev/plans/investigation/agent-capabilities.md` (escrita hoje sobre o modelo antigo). Aquele documento é reescrito na F5 a partir daqui.

- **Postura padrão:** o agente pode fazer **tudo o que a pessoa pode no caso**, exceto uma lista curta de atos irreversíveis/legais: registrar decisão, compartilhar com novas pessoas, apagar caso, aprovar comunicação externa. Admin pode liberar via `agents_allow_irreversible`.
- **Autoria sempre registrada:** `author_kind=agent` + `agent_token_id` em itens, anotações, eventos. Chip de autor em toda a UI; filtro global Pessoa|Agente|Tudo.
- **Sugerido só para alguns tipos:** `settings.agent_suggest_kinds` (padrão `[role, tag, hypothesis_status, same_as, status_change, typology]`) → `status=suggested`; o resto aplica direto. Humano cria sempre `confirmed`.
- **Escopo do token:** `scope=user` (todos os meus casos) ou `scope=case`; middleware aceita agente só em `/api/investigations/*` (id ∈ token), `/api/explorations*` e `/api/graph/*` (query em contexts legíveis pelo dono) e `/mcp`; 403 no resto. `forbid_agents` nas 4 irreversíveis **e** nas rotas de share de context/exploração.
- **Mascaramento no serviço** (`services/masking.py`, movido de `mcp/server.py`), aplicado em itens, grafo, eventos, anotações e exports quando `token.unmasked=false` (precedência: org permite ∧ token marcado). Binário nunca chega ao agente; ele recebe `/items/{id}/text` (extração server-side: md/txt/csv/json nativos; `pypdf`, `python-docx` a adicionar; PDF escaneado → metadados + aviso, sem OCR).
- **MCP** (`mcp/server.py` reescrito sobre `services/cases.py`): recursos `case://{id}/brief`, `case://{id}/items`, `case://{id}/items/{item}` (texto), `case://{id}/graph`, `case://{id}/changes?since=`, `org://playbooks/{slug}`. Ferramentas 1:1 com ações humanas: `list_cases, get_brief, write_brief, list_items, read_item(offset,limit), search_case, add_item, add_table, add_note, save_query, run_query, create_exploration, import_file(mapping), annotate(role|tag|hypothesis|same_as|typology), group, run_analysis(trace|paths|typologies|er|communities), pin_evidence, changes_since, get_playbook`. Prompts hard-coded → `org_library`. `test_agent_registry.py` mantido e estendido: cada ferramenta declara a rota humana equivalente.
- **Brief** = item `document/brief` fixo no topo do material (★), editável por humano e agente, versões com diff ("o que mudou desde").

---

## 7. Compliance no fluxo, não no caminho

- Prazos no header; fases por `kind_preset` (Pix/MED: 45+45 a partir de `alert_at`), dias configuráveis em `config.py` e por caso.
- **Decidir** abre painel guiado no inspector: resultado (comunicar/arquivar/medida/parecer), ações, fundamentação pré-preenchida com hipóteses sustentadas e evidências fixadas, aviso de tipping-off, revisor. Registrar congela: `frozen_hash` de eventos + versões fixadas; status → decided; rota só humana. `archived` só após `decided` ou "arquivado sem decisão" explícito com motivo.
- Exportações (Siscoaf, SIMBA, Laudo PDF via print, CSV/JSON) no Dossiê e no painel de decisão; export verifica `frozen_hash`.
- Selos CC 4.001 = anotações `typology` com vocabulário, chegam como sugeridos (motor ou agente), confirmáveis inline, aparecem no dossiê.

---

## 8. Dois motores

TS (workers, resposta instantânea) e Python (agentes/servidor) ficam. Obrigatório: fixture `unify` compartilhada (`frontend/src/__tests__/fixtures/unify/`, `api/tests/test_case_graph.py`) incluindo matches `same_as` confirmados e overrides do caso; `services/case_graph.py` passa a aplicá-los (hoje ignora). Resultados server-side gravados como item com `provenance.tool_call_id`.

---

## 9. Kill list

| Remover | Motivo |
|---|---|
| `investigation_proposals`, `services/investigation_proposals.py`, `InvestigationAgentsView` (T11) | sugestão no lugar; tokens → settings do usuário |
| `InvestigationMatchesView` (T8), `entity_matches` | anotação `same_as` sugerida, revisada no inspector |
| `InvestigationDossierView` como rota | `mode=dossie` da mesma store |
| `ArtifactsSpace` (T10), `CaseFiles`, `SourcesPanel`, abas por fonte, `EnrichmentTab` separada | lista "Material" + chips + seção do inspector |
| `FileImportWizard` 5 passos | 2 passos com detecção; o passo de mapeamento vira `MappingStep` reutilizado por arquivo e por consulta→grafo |
| `stores/trace.ts`, `TracePanel` como modo de tela | popover de parâmetros + item resultado renderizado por prop |
| `AddToInvestigationModal` com lista global | popover `+ Adicionar` |
| rota `files/{id}/context`, context/exploração globais por arquivo, exceção em `context_access` | mapping é do item do caso |
| modo `frozen` ao adicionar, `prev_hash`/hash encadeado | pin explícito; hash ao decidir |
| escopos read/analyze/write, `investigation.export` (permissões ficam `investigation.create`, `.upload`, `.decide`, `.share`, `.agent`) | token = identidade + lista curta |
| papéis enum fixo, `typology` como coluna | vocabulários/tags/preset |
| enums PT, datas US, strings EN misturadas, overlay FPS no caso | |
| menu de contexto como único caminho de rastreio/caminho | botões com popover |

**Mantém no núcleo:** prazos BR, CC 4.001 como preset, exports SIMBA/Siscoaf/dossiê, Sankey, raias, tipologias, `BlobStore`/`investigation_storage`, registry tests, paridade InMemory.

---

## 10. Fases (cada uma fecha com pytest, vitest, vue-tsc e `investigations.spec.ts` verdes)

**Progresso**
- [x] F0 · Segurança
- [ ] F1 · Caso operável
- [ ] F2 · Novo modelo
- [ ] F3 · Add everywhere + loop vivo
- [ ] F4 · Workspace de análise
- [ ] F5 · AI-first completo
- [ ] F6 · Compliance e acabamento

### F0 · Segurança (1 PR, bloqueia tudo)
- `api/graphlagoon/middleware/auth.py::_dispatch_agent`: allowlist de prefixos; 403 fora.
- `api/graphlagoon/utils/authz.py`: remover `require_agent_scope`; `forbid_agents` em share/unshare de `routers/graph_contexts.py` e `routers/explorations.py`, em `PATCH assignee/owner`, decisão, delete.
- `services/masking.py` (mover `mask*` de `mcp/server.py`); aplicar em `files/content`, `snapshot`, `evidence`, `events` quando ator = agente. Upload checa acesso antes de bufferizar.
- Testes: `api/tests/test_agent_tokens.py` + novo `test_agent_route_scoping.py` (percorre `app.routes`; token do caso A não lê B nem `/api/graph-contexts`; share por agente → 403; REST mascarado).
- **Aceite:** nenhum endpoint fora da allowlist responde 200 a `glt_`.

### F1 · Caso operável (sobre o modelo atual, cirúrgico)
- `InvestigationView.vue`: `CaseHeader.vue` (título/descrição/tipologia inline, status select com transições, assignee, prazo), `ShareDialog.vue` (POST/DELETE `/share` já existem), menu "…" (excluir, remover fonte, reabrir via novo `POST /reopen` só humano).
- Transições de status explícitas em `services/investigations.py`; colunas `occurred_at/alert_at/deadline_days` (editar 016, que nunca rodou).
- Legibilidade: `labelFormatter` por tipo, zoom-to-fit, tamanhos, FPS off, CPF cru escondido quando há `*_mascarado`, UUIDs resolvidos para títulos.
- `AddToInvestigationModal`: "minhas recentes" + busca + nº nós + vazias desabilitadas (`routers/explorations.py` ganha `q, mine, limit, cursor`).
- Fila: filtros, ordenação, marcador só leitura. Upload humano já entra confirmado.
- **Aceite:** e2e "criar → editar → compartilhar → adicionar → remover fonte → mudar status → decidir → reabrir → excluir" sem sair da tela.

### F2 · Novo modelo
- `alembic/versions/016_cases.py` (apagar 016–019); `db/models.py` + `db/memory_store.py` (paridade InMemory, incluindo busca).
- `services/cases.py`, `case_items.py` (funde `investigation_{files,artifacts,evidence,storage}`; reuso de `BlobStore`, sha256, never-overwrite), `case_annotations.py`, `text_extract.py`, `case_queries.py` (runs via `sql_warehouse.execute_prepared` + poll).
- `routers/investigations.py`: ~25 rotas (caso CRUD/share/status/reopen; items CRUD + versions + content + text + pin + confirm/discard; queries run; annotations CRUD + confirm; graph; analyses; events; brief; search; export; decision).
- Frontend: `types/investigation.ts`, `services/api.ts`, `stores/investigation.ts` (items + annotations + events), `CaseItemsPanel.vue` com editor markdown e brief; apagar T8/T10/T11 e rotas em `router/index.ts`.
- `case_graph.py` aplica `same_as` confirmados + overrides; fixture `unify`.
- `dev/seed_investigations.py` reescrito com 4 cenários (crédito de grupo econômico, fuga de garantia, Pix/MED, fraude sintética com pessoas, e-mails, telefones, dispositivos, IPs, cartões, terminais e endereços compartilhados); `investigation_exports.py` lê itens fixados.
- **Aceite:** upload CSV com mapping aparece no canvas sem criar `GraphContext`; consulta salva reexecuta e gera versão com `run`; testes `test_case_*` e paridade InMemory verdes.

### F3 · Add everywhere + loop vivo
- `stores/currentCase.ts` + chip na `Toolbar.vue`; `composables/useAddToCase.ts`; botões em `QueryConsolePanel`, `DataTablePanel`, `EnrichmentTab`, `TraceExits`, menu de seleção; drop/paste no material.
- Popover `+ Adicionar` com as 5 abas; "Nova exploração" via `GraphVisualizationView?case=` com auto-anexo ao salvar; Query Console dentro do caso (prop `contextId` + emit `result`).
- **Aceite:** resultado do console vira tabela do caso em 2 cliques; consulta salva aparece em "Consultas" com histórico de runs; exploração nova criada do caso aparece como ref viva; um caso com 5+ tabelas de origens diferentes permite juntar duas por chave e promover três a enriquecimento de uma vez.

### F4 · Workspace de análise
- `CaseFilterChips.vue`, montar `FilterPanel`/`DataTablePanel`/`MetricsPanel`/comunidades/`LayoutPanel` no caso (todos já leem o `graphStore` único; `InvestigationView` já usa `graphStore.loadInvestigationGraph`); `GroupsPanel.vue`; `SelectionInspector.vue`; `AnalysisBar.vue` com popovers; `CaseSettingsDrawer.vue`; `EntityPage` (drawer); `CaseTimeline` na faixa inferior; visões salvas; persistir grupos/comunidades/expansões.
- `FileImportWizard` → 2 passos. Dossiê como `mode=dossie`.
- Normalizadores novos (`device_id`, `ip`, `pix_key`, `card`, `terminal_id`, `address`, `regex`) em TS e Python com fixture; `Vínculos` por atributo compartilhado gerando `graph/derived`; presets de caso incluindo `fraude_sintetica` (§4b).
- **Aceite:** os 3 walkthroughs (§11) mais o cenário de fraude sintética (§4b) executáveis sem sair do caso; grupo da seleção sem JS; recarregar preserva grupos, papéis e visões.

### F5 · AI-first completo
- `mcp/server.py` reescrito (recursos texto, ferramentas 1:1, `search_case` por ILIKE em `text_blob` + títulos, FTS Postgres opcional, `changes_since`); `org_library` + `org_vocabularies` com UI simples em `AdminView`; tokens user/case em `/settings/agents`; `agent_suggest_kinds` e chips Confirmar/Recusar.
- `test_mcp_server.py`, `test_agent_registry.py` (tool ↔ rota humana), teste de mascaramento em `read_item`; `docs/guide/investigations.md`, `agents-mcp.md`, `docs/dev/plans/investigation/agent-capabilities.md` reescritos.
- **Aceite:** cliente MCP lê brief, busca, salva e roda consulta, adiciona tabela e grupo, sugere papéis; humano confirma inline; registry verde.

### F6 · Compliance e acabamento
- Prazo por `alert_at` + dias configuráveis; `archived` só após decisão ou motivo; `frozen_hash` verificado no export; retenção apaga blobs; rate limit por token em store compartilhado; primário `#0f766e`; pt-BR; i18n dos enums; journal com filtro.

---

## 11. Walkthroughs de validação

**(a) Crédito de grupo econômico.** Novo caso tipo "crédito" (sem prazo) → `+ Adicionar → Nova exploração` no context QSA, semente CNPJ matriz → `Grupos → por propriedade uf` e `por componente` → arrasta planilha de garantias (enriquecimento por CNPJ) → seleciona 6 empresas → `Agrupar "Grupo Alfa"` → `+ Adicionar → Consulta` SQL de faturamento no Databricks, salva como consulta do caso, roda → `Métricas → salvar como tabela` → agente escreve brief "Exposição consolidada" (chip agente) → Dossiê → PDF com a tabela da consulta.

**(b) Fuga de garantia.** Caso tipo "garantia", `occurred_at` = data do contrato → consulta salva "alienações do devedor nos últimos 90 dias" com resultado mapeado para grafo → Linha do tempo com janela "após o vencimento" → clica no bem → inspector lista 3 itens que o citam → multi-seleção adquirentes → `Mesmo que` com motivo → `Caminhos` devedor→adquirente respeitando tempo → item filho → nota no caminho → agente sugere papel `cessionário` em 4 contas → confirma em lote → Decidir: "medida cautelar".

**(c) Pix com MED.** Caso tipo "pix_med": header mostra 45+45 desde `alert_at` → exploração Pix recente em um clique → `Seguir o dinheiro` (popover: semente, FIFO, Δ24h) → item "Rastreio #1" + camadas → upload SIMBA = **um** item grafo → `Tipologias` acende "CC 4.001 IV-k · sugerido" → confirma → agente anexa KYC e marca "laranja · sugerido" → confirma em lote → Fixar rastreio e KYC → Decidir → Siscoaf + Laudo.

---

## 12. Riscos e verificações

- **`InvestigationView` (1113 linhas):** F1 cirúrgica; F4 em componentes novos; não reescrever os dois ao mesmo tempo.
- **`case_graph` × `unifyGraph.ts`:** fixture `unify` obrigatória antes da F4.
- **Query Console no caso:** 11 referências a `currentContext`; precisa de prop `contextId` + emit `result` (F3). `TemplateExecuteModal` depende de `useRouter` → callback.
- **Extração PDF/DOCX:** tamanho/tempo → assíncrono e cacheado em `text_blob_key`.
- **Allowlist de rotas para agentes** pode quebrar a ponte stdio: rodar `test_mcp_server.py` ponta a ponta na F0.
- **Seed e e2e** quebram na F2: reescrever junto.
- **Siscoaf/SIMBA export** lê `sources`/`evidence` hoje: mapear para itens fixados antes de apagar tabelas.
- **InMemoryStore:** itens, versões, runs e busca precisam de paridade; custo real.
- **Mascaramento centralizado:** cobrir `payload` de anotações e eventos (ids unificados contêm CPF).
- **Nome das rotas:** manter `/api/investigations` (sem renomear para `/cases`) para não quebrar MCP, docs e e2e.
