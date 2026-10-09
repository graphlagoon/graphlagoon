# 04 · Plano de implementação

Siga as tarefas **em ordem**. Cada uma diz do que depende, quais arquivos tocar, os
passos, os critérios de aceite e os testes. O "como" detalhado (esquemas, contratos,
algoritmos) está em [03-arquitetura.md](03-arquitetura.md). As telas estão em
[02-design.md](02-design.md) e em `screens/`.

Antes de começar, leia as regras de trabalho no [README](README.md#regras-de-trabalho-definition-of-done).

**Regra AI-first, a partir da FA.6:** toda tarefa que cria rota em
`routers/investigations.py` também entrega a ferramenta MCP correspondente
([03 §8.3](03-arquitetura.md#83-servidor-mcp)) ou registra a rota como só humana. O
teste `test_agent_registry.py` cobra isso. Tarefas da F1 feitas antes da FA ganham as
suas ferramentas na FA.4.

## Progresso

Marque `[x]` no mesmo commit que conclui a tarefa.

**G · Portões (antes de F1)**
- [ ] G1 · Corrigir o #28 (IDs de arestas paralelas colidem)
- [ ] G2 · Corrigir o M4 (injeção de fórmula em exportação CSV)
- [ ] G3 · Sandbox dos cluster programs (#32)
- [ ] G4 · Medir o teto do grafo no browser

**F1 · Fundação**
- [ ] F1.1 · Modelos, migração 016 e paridade em memória
- [ ] F1.2 · API de investigações: CRUD, compartilhamento nominal, permissões, auditoria
- [ ] F1.3 · Fontes: adicionar e remover explorações, com redação por acesso
- [ ] F1.4 · Chaves de identidade no context (backend e aba no formulário)
- [ ] F1.5 · Frontend: rotas, store, API, fila (T1), "Adicionar à investigação" (T3)
- [ ] F1.6 · Grafo unificado e workspace (T2)
- [ ] F1.7 · Papéis, notas e diário (eventos)
- [ ] F1.8 · Área admin e seed
- [ ] F1.9 · Docs públicas e E2E da fundação

**FA · AI-first: agentes na investigação**
- [ ] FA.1 · Tokens de agente, escopos e ator no diário
- [ ] FA.2 · Armazenamento do caso no Volume e espaço de artefatos (T10)
- [ ] FA.3 · Propostas e aprovação humana (T11)
- [ ] FA.4 · Servidor MCP em `/mcp` com as ferramentas da F1 e da FA
- [ ] FA.5 · Ponte MCP local (stdio) para apps atrás do proxy do Databricks
- [ ] FA.6 · Registry de cobertura AI-first (teste obrigatório)
- [ ] FA.7 · Guia público de agentes, prompts MCP e E2E do agente

**F2 · Arquivos e enriquecimento**
- [ ] F2.1 · Tabelas de enriquecimento no context e endpoint de consulta
- [ ] F2.2 · Aba de enriquecimento no inspector e "promover a nós"
- [ ] F2.3 · Upload de arquivos com hash e papel
- [ ] F2.4 · Especificação de mapeamento, interpretadores TS e Python, presets SIMBA e QSA
- [ ] F2.5 · Datasource `file` e assistente de arquivo (T4)
- [ ] F2.6 · Arquivo como enriquecimento do caso
- [ ] F2.7 · Gravar valores de métricas como propriedade
- [ ] F2.8 · Resolução de entidades e revisão de matches (T8)

**F3 · Seguir o dinheiro**
- [ ] F3.1 · Semântica de valor e horário nas arestas
- [ ] F3.2 · Soma de arestas paralelas e largura por valor
- [ ] F3.3 · Worker de rastreio temporal
- [ ] F3.4 · Tela de rastreio (T5): parâmetros, camadas, Sankey, saídas
- [ ] F3.5 · Linha do tempo em raias com seleção de janela
- [ ] F3.6 · Caminhos
- [ ] F3.7 · Componentes conexos no registry de algoritmos
- [ ] F3.8 · Rastreio e caminhos no servidor (Python) com paridade e ferramentas MCP

**F4 · Dossiê e compliance**
- [ ] F4.1 · Evidências congeladas
- [ ] F4.2 · Hipóteses e tela do dossiê (T7)
- [ ] F4.3 · Selos de tipologia (CC 4.001) e anel de lojistas (T9)
- [ ] F4.4 · Status e prazos (45 + 45 dias) na fila
- [ ] F4.5 · Decisão, congelamento e retenção
- [ ] F4.6 · Exportações (laudo, pacote, SIMBA, resumo Siscoaf)

**F5 · Escala e IA (opcional)**
- [ ] F5.1 · Promover context de arquivo ao warehouse
- [ ] F5.2 · Rastreio em SQL no warehouse
- [ ] F5.3 · Narrativa assistida por IA, com revisão humana

---

## G · Portões

### G1 · Corrigir o #28

- **Por quê:** transação vira aresta. Com o id composto `src@type@dst`, arestas
  paralelas colidem e transações somem no merge. Ver
  `docs/dev/technical-debts.md` (#28).
- **Arquivos:** `api/graphlagoon/services/graph_operations.py` (`_get_edge_id`), testes
  em `api/tests/test_typeless_columns.py` ou um novo `test_edge_ids.py`.
- **Passos:**
  1. Quando não há `edge_id_col`, gerar o id a partir de `src`, `relationship_type`,
     `dst` **e** um hash estável das demais colunas da linha (ordenadas por nome).
  2. Duas linhas idênticas em tudo continuam colidindo; isso é aceitável e
     documentado.
- **Aceite:**
  - [ ] Duas arestas entre o mesmo par, com propriedades diferentes, têm ids
    diferentes.
  - [ ] O id é estável entre execuções, para não invalidar snapshots salvos.
- **Testes:** pytest com tabela sem tipo e duas transações paralelas.
- **Docs:** marcar o #28 como resolvido em `technical-debts.md` e no decision log.

### G2 · Corrigir o M4

- **Arquivos:** novo `frontend/src/utils/csvSafe.ts`, aplicado em
  `utils/tableExport.ts`, `ClusterNodeModal.vue`, `CommunityNodeModal.vue`,
  `DataTablePanel.vue` / `DataGrid.vue` (o `exportFunction` do PrimeVue).
- **Passos:** uma função `safeCell(v)` prefixa `'` em valores que começam com
  `=`, `+`, `-`, `@`, tab ou CR. Os 4 caminhos usam a função.
- **Aceite:**
  - [ ] `=HYPERLINK(...)` exporta como texto nos 4 caminhos.
  - [ ] Números negativos legítimos continuam números quando a célula é numérica (só
    strings são prefixadas).
- **Testes:** vitest em `utils/__tests__/csvSafe.test.ts` e um teste por caminho.
- **Docs:** atualizar o M4 em `docs/dev/security-assessment.md`.

### G3 · Sandbox dos cluster programs (#32)

- **Por quê:** com dado sigiloso no caso, código de usuário na thread principal é
  risco maior.
- **Arquivos:** `frontend/src/stores/cluster.ts`
  (`computeClustersFromProgram`), reaproveitando `workers/customMetricSandbox.ts` e o
  padrão de `customMetricWorker.ts`.
- **Aceite:**
  - [ ] Os programas rodam em worker, com timeout.
  - [ ] Os 3 programas padrão continuam funcionando.
- **Testes:** vitest do store e um teste de timeout.

### G4 · Medir o teto do grafo no browser

- **Arquivos:** `frontend/e2e/perf-report.ts` e `make perf-report`.
- **Passos:**
  1. Gerar grafos sintéticos de 50 mil, 100 mil e 200 mil arestas (gerador dev).
  2. Medir carga, `updateVisuals` e memória.
  3. Registrar o resultado no decision log.
- **Aceite:**
  - [ ] Um número `INVESTIGATION_MAX_WORKING_EDGES` decidido e justificado.
  - [ ] Esse número vira setting na F2.3 e responde a Q5 do README.

---

## F1 · Fundação

### F1.1 · Modelos, migração 016 e paridade em memória

- **Depende de:** G1.
- **Arquivos:**
  - `api/graphlagoon/db/models.py`;
  - `api/graphlagoon/alembic/versions/016_investigations.py` (novo; a última é a
    `015_groups_permissions.py`);
  - `api/graphlagoon/db/memory_store.py`.
- **Passos:**
  1. Criar as tabelas de [03 §2.2](03-arquitetura.md#22-tabelas-novas):
     - `investigations`, `investigation_shares`, `investigation_sources`;
     - `investigation_files`, `investigation_events`, `investigation_notes`;
     - `investigation_evidence`, `entity_matches`.
  2. Adicionar a `graph_contexts` as colunas `identity_keys` (JSON, padrão `[]`),
     `enrichment_tables` (JSON, padrão `[]`) e `edge_semantics` (JSON, padrão `{}`).
     Os campos novos do context entram já, com o mínimo de validação, para evitar uma
     segunda migração.
  3. Criar os equivalentes em memória (dataclasses `Memory…` e métodos CRUD), como
     `create_group` faz hoje.
- **Aceite:**
  - [ ] `alembic upgrade head` e `downgrade -1` rodam limpos.
  - [ ] `make dev` (memória) e `make dev-db` (Postgres) sobem.
- **Testes:** pytest de CRUD do memory store para cada entidade nova.
- **Admin:**
  - [ ] As tabelas novas entram em `CLEARABLE_TABLES` (`routers/admin_registry.py`).
  - [ ] `InMemoryStore.clear_all` limpa as entidades novas.

### F1.2 · API de investigações

- **Depende de:** F1.1.
- **Arquivos:**
  - `api/graphlagoon/routers/investigations.py` (novo; registrar onde os outros routers
    são incluídos em `app.py`);
  - `api/graphlagoon/services/investigations.py` (novo);
  - `models/schemas.py`, `services/permission_catalog.py`, `services/audit.py`;
  - `routers/admin_registry.py`;
  - `api/tests/test_admin_registry.py` (`ROUTER_MODULES`).
- **Passos:**
  1. Endpoints de [03 §3.1](03-arquitetura.md#31-investigações):
     - `GET`/`POST /api/investigations`;
     - `GET`/`PATCH`/`DELETE /api/investigations/{id}`;
     - `POST`/`DELETE /api/investigations/{id}/share`.
  2. Catálogo de permissões: `investigation.create` com gate em `POST`.
  3. O compartilhamento aceita **só e-mails nominais**: `*` e `*@dominio` levam 422 e a
     mensagem cita a vedação de tipping-off.
  4. Ações de auditoria: `investigation.create`, `.update`, `.delete`, `.share`,
     `.unshare`.
  5. As rotas mutáveis vão para `AUDITED_ROUTES`.
  6. O `DELETE` de caso com decisão registrada devolve 409 (retenção; ver F4.5).
- **Aceite:**
  - [ ] O dono, o responsável, quem tem share e o superuser veem o caso; os demais
    levam 404.
  - [ ] O share com curinga é recusado.
- **Testes:**
  - novo `api/tests/test_investigations.py`;
  - casos de allow e deny em `test_permission_routes.py`;
  - `test_admin_registry.py` verde.

### F1.3 · Fontes: adicionar e remover explorações

- **Depende de:** F1.2.
- **Arquivos:** `routers/investigations.py`, `services/investigations.py`,
  `utils/context_access.py` (reuso de `get_context_with_access`).
- **Passos:**
  1. `POST /api/investigations/{id}/sources` com `{kind:"exploration", exploration_id, mode:"live"|"frozen"}`.
     Exige escrita no caso **e** leitura na exploração **e** no context dela.
  2. `mode:"frozen"` copia o snapshot atual para
     `investigations/{id}/sources/{source_id}.json.gz`, com sha256.
  3. `GET .../sources` devolve `accessible:false` e **só** título, context e dono
     quando quem chama não lê o context. Nada de dados.
  4. Auditar a adição e a remoção de fonte.
- **Aceite:**
  - [ ] Explorações de dois contexts diferentes no mesmo caso.
  - [ ] Um usuário sem acesso a um dos contexts vê o placeholder e nenhum nó dele.
- **Testes:** `api/tests/test_investigation_sources.py`, cobrindo redação, acesso
  negado e o hash do congelamento.

### F1.4 · Chaves de identidade no context

- **Depende de:** F1.1.
- **Arquivos:**
  - backend: `models/schemas.py` (validação de `identity_keys`, ver
    [03 §2.1](03-arquitetura.md#21-colunas-novas-em-graph_contexts)),
    `routers/graph_contexts.py`;
  - frontend: `GraphContextFormModal.vue` (aba nova "Chaves de identidade"),
    `types/graph.ts`, `utils/identityKeys.ts` (novo: normalizadores de CPF/CNPJ e
    conta).
- **Aceite:**
  - [ ] Salvar e recarregar as chaves.
  - [ ] Normalizadores testados com CPF formatado e sem formatação, CNPJ e conta com
    zeros à esquerda.
- **Testes:**
  - pytest de validação;
  - `utils/__tests__/identityKeys.test.ts`;
  - teste do componente do formulário.
- **Tela:** a faixa "Chaves deste context" da `screens/T6-Context.png`.

### F1.5 · Frontend: rotas, store, API, fila (T1), adicionar (T3)

- **Depende de:** F1.2, F1.3.
- **Arquivos:**
  - `src/router/index.ts` (`/investigations`, `/investigations/:id`);
  - `src/types/investigation.ts` (novo), `src/services/api.ts`;
  - `src/stores/investigation.ts` (novo);
  - `src/views/InvestigationsView.vue` (novo, T1);
  - `src/components/investigation/AddToInvestigationModal.vue` (novo, T3);
  - entradas "Adicionar à investigação" em `ExplorationsView.vue` e na toolbar de
    `GraphVisualizationView.vue`;
  - link "Investigações" no topo (`Toolbar.vue` / navegação).
- **Aceite:**
  - [ ] A fila lista os casos com status, responsável, fontes e prazo
    (`screens/T1-Fila.png`).
  - [ ] O modal mostra as explorações por context, a restrita como placeholder e a
    prévia de sobreposição (`screens/T3-Adicionar.png`). A prévia pode ser
    aproximada na F1 e exata depois da F1.6.
  - [ ] "Nova investigação" fica escondida sem `investigation.create`
    (`usePermissions().can`).
- **Testes:**
  - vitest do store e das views;
  - E2E em `frontend/e2e/tests/investigations.spec.ts` com
    `seedInvestigations(page, …)` novo em `e2e/helpers/api-mocks.ts`.

### F1.6 · Grafo unificado e workspace (T2)

- **Depende de:** F1.4, F1.5.
- **Arquivos:**
  - `src/utils/unifyGraph.ts` (novo, **função pura**; ver
    [03 §5.1](03-arquitetura.md#51-unificação-do-grafo));
  - `src/stores/graph.ts`: modo "origem investigação" que carrega nós e arestas sem
    `currentContext`, e uma expansão que escolhe o context de origem e remapeia o
    resultado;
  - `src/views/InvestigationView.vue` (novo);
  - `src/components/investigation/SourcesPanel.vue`;
  - anéis de proveniência em `utils/graphAppearance.ts`.
- **Passos:**
  1. Carregar cada fonte: o snapshot da exploração pela API existente ou o snapshot
     congelado.
  2. Unificar pelas chaves de identidade. Cada nó ganha `__sources`.
  3. Abas por exploração (cada aba é a exploração como hoje) mais a aba "Visão
     unificada".
  4. Seleção vinculada: selecionar uma entidade destaca a mesma entidade nas outras
     abas.
- **Aceite:**
  - [ ] O layout segue `screens/T2-Workspace.png`.
  - [ ] Duas explorações que compartilham um CPF mostram um nó só, com dois anéis.
  - [ ] Expandir um nó unificado pergunta o context, quando há mais de um.
  - [ ] As comunidades **não** são apagadas ao carregar a vista unificada. Hoje o
    watcher em `stores/community.ts` limpa as comunidades a cada troca de `nodes`;
    corrigir ou contornar.
- **Testes:**
  - `utils/__tests__/unifyGraph.test.ts`: chaves, conflito de propriedade, fallback
    sem chave, arestas nunca fundidas entre fontes;
  - vitest do modo novo do `graph.ts`;
  - E2E de duas fontes.

### F1.7 · Papéis, notas e diário

- **Depende de:** F1.6.
- **Arquivos:**
  - `routers/investigations.py`: `.../events` (GET paginado, POST para eventos do
    cliente), `.../notes` (CRUD) e `PATCH .../state` (papéis e pins);
  - inspector em `InvestigationView.vue`: seletor de papel, aba de notas.
- **Passos:**
  1. O servidor grava evento para toda mutação.
  2. O cliente grava os eventos de UI listados em [03 §3.4](03-arquitetura.md#34-diário-eventos).
  3. Os eventos são imutáveis, sem `PUT` nem `DELETE`.
- **Aceite:**
  - [ ] Papel vítima, laranja, saída ou descartado muda o preenchimento do nó (legenda
    da T2).
  - [ ] O diário lista eventos com autor e hora.
- **Testes:** pytest de eventos (imutabilidade, paginação) e vitest do inspector.

### F1.8 · Área admin e seed

- **Depende de:** F1.2.
- **Arquivos:**
  - `routers/admin.py`: contagem em `AdminCounts`, transferência de dono do caso;
  - `views/AdminView.vue`: aba "Investigações";
  - `utils/adminView.ts`: `describeAudit` para as ações novas;
  - `graphlagoon/dev/seed.py`: 3 a 5 casos de exemplo com fontes de contexts
    diferentes.
- **Aceite:**
  - [ ] O superuser vê todos os casos e quem é dono de cada um.
  - [ ] O `make dev` semeia casos.
- **Testes:** `test_admin.py`, `test_dev_seed.py` e `test_admin_registry.py`.

### F1.9 · Docs públicas e E2E da fundação

- **Arquivos:**
  - `docs/guide/investigations.md` (novo, no estilo de `docs/guide/labels.md`, com o
    bloco TL;DR);
  - sidebar em `docs/.vitepress/config.ts`;
  - cenas em `frontend/e2e/screenshots/generate.ts`;
  - jornada em `e2e/tests/user-journeys.spec.ts`: criar caso → adicionar duas
    explorações → abrir a vista unificada.
- **Aceite:** `make docs-build` passa.

---

## FA · AI-first: agentes na investigação

Ver [03 §8](03-arquitetura.md#8-ai-first-agentes-na-investigação) e as telas
`screens/T10-Espaco.png` e `screens/T11-Agentes.png`. **Princípio:** o agente faz o
trabalho de análise e documentação; a pessoa decide.

### FA.1 · Tokens de agente, escopos e ator no diário

- **Depende de:** F1.2, F1.7.
- **Arquivos:**
  - `db/models.py` (`agent_tokens`, colunas de ator em `investigation_events`);
  - migração `017_agents.py`; `memory_store.py`;
  - `middleware/auth.py` (Bearer `glt_…`);
  - `utils/authz.py` (`require_agent_scope`, `forbid_agents`);
  - router `routers/agent_tokens.py`;
  - `config.py` (`agents_enabled`, `agent_token_max_days`, `agents_allow_unmasked_data`,
    `agent_rate_limit_per_minute`);
  - catálogo: `investigation.agent`;
  - admin: listar e revogar tokens.
- **Passos:**
  1. Gerar o token `glt_` + 32 bytes base64url; guardar só o sha256; mostrar uma vez.
  2. Escopos `read`, `analyze`, `write`, `propose`; validade máxima configurável.
  3. O token resolve para o e-mail do dono e marca o ator `agent`. Diário, auditoria e
     versões gravam o ator.
  4. `forbid_agents` em todas as rotas só humanas de [03 §8.7](03-arquitetura.md#87-registry-de-cobertura-teste).
  5. Limite de taxa por token.
- **Aceite:**
  - [ ] Token expirado ou revogado leva 401.
  - [ ] Agente em rota só humana leva 403, mesmo com o dono superuser.
  - [ ] Os eventos mostram "agente X em nome de Y".
  - [ ] Com `agents_enabled = false`, as rotas de token devolvem 404.
- **Testes:** novo `test_agent_tokens.py`; `test_permission_routes.py`;
  `test_admin_registry.py` (settings e rotas novas).

### FA.2 · Armazenamento do caso no Volume e espaço de artefatos (T10)

- **Depende de:** FA.1.
- **Arquivos:**
  - `services/blob_storage.py`: `save_stream(key, path)` local e Databricks;
  - `services/investigation_storage.py` (novo): layout de [03 §2.3](03-arquitetura.md#23-armazenamento-no-volume),
    streaming com sha256, nunca sobrescreve;
  - `config.py`: `investigations_volume_path`, `artifact_max_bytes`;
  - tabelas `investigation_artifacts` e `investigation_artifact_versions`;
  - rotas de [03 §8.5](03-arquitetura.md#85-espaço-do-caso-artefatos);
  - `views/InvestigationView.vue`: aba "Espaço do caso" com
    `components/investigation/ArtifactsSpace.vue` (novo).
- **Aceite:**
  - [ ] Em `make dev` os arquivos vão para o diretório local; com Databricks, para o
    Volume em `{investigations_volume_path}/{id}/artifacts/…`.
  - [ ] Um arquivo maior que a memória disponível do processo sobe sem estourar (teste
    com gerador em stream).
  - [ ] Nova versão nunca sobrescreve a anterior.
  - [ ] `html` e `svg` só para download.
  - [ ] Aprovar exige humano.
  - [ ] A tela segue `screens/T10-Espaco.png`.
- **Testes:**
  - novo `test_investigation_storage.py` (local e Databricks com Files API mockada);
  - novo `test_artifacts.py`;
  - vitest do `ArtifactsSpace`;
  - E2E de envio de nova versão e de aprovação.

### FA.3 · Propostas e aprovação humana (T11)

- **Depende de:** FA.1, F1.7.
- **Arquivos:**
  - tabela `investigation_proposals`;
  - rotas `GET`/`POST .../proposals`, `POST .../proposals/{pid}/accept|reject` (só
    humano);
  - `views/InvestigationAgentsView.vue` (novo, T11): conexão, tokens, propostas,
    atividade;
  - contador de propostas na barra do caso.
- **Passos:** aceitar chama o **mesmo** serviço da ação na UI (papel, match, hipótese,
  tipologia, status) e grava evento com quem propôs e quem aceitou.
- **Aceite:**
  - [ ] Uma proposta de papel aceita muda o papel exatamente como a ação manual.
  - [ ] Recusar exige motivo.
  - [ ] A tela segue `screens/T11-Agentes.png`.
- **Testes:** novo `test_proposals.py` e vitest da view.

### FA.4 · Servidor MCP em `/mcp`

- **Depende de:** FA.1, FA.2, FA.3.
- **Arquivos:**
  - `api/pyproject.toml`: extra opcional `mcp` com o SDK oficial;
  - `api/graphlagoon/mcp/server.py` (novo): FastMCP, Streamable HTTP montado em `/mcp`
    no `app.py` quando `agents_enabled`;
  - ferramentas de leitura e escrita da F1 e da FA ([03 §8.3](03-arquitetura.md#83-servidor-mcp)),
    resources e prompts.
- **Passos:**
  1. As ferramentas chamam a camada de serviço com a identidade do token, nunca HTTP
     para o próprio app.
  2. Respostas com `untrusted_data` e mascaramento conforme a política.
  3. Uma ferramenta de decisão, compartilhamento ou apagar **não existe**.
- **Aceite:**
  - [ ] `claude mcp add --transport http graphlagoon http://localhost:8000/mcp --header "Authorization: Bearer …"`
    lista as ferramentas.
  - [ ] Um cliente MCP de teste roda o roteiro: criar caso → adicionar fonte → ler grafo
    → anotar → subir artefato → propor papel. Tudo aparece no diário como agente.
  - [ ] CPF sai mascarado por padrão.
- **Testes:** novo `test_mcp_server.py`, com o cliente do SDK `mcp` em pytest.

### FA.5 · Ponte MCP local (stdio)

- **Por quê:** no Databricks Apps o agente pode não alcançar `/mcp` por causa do
  proxy (Q7).
- **Arquivos:**
  - `api/graphlagoon/cli.py`: subcomando `graphlagoon mcp-bridge --url <app>`. O CLI
    está quebrado hoje (decision log de 2026-09-15); conserte junto;
  - processo stdio que expõe as mesmas ferramentas e repassa para a API do app usando
    o OAuth do Databricks CLI (`databricks-sdk`) ou um token `glt_`.
- **Aceite:**
  - [ ] `claude mcp add graphlagoon -- graphlagoon mcp-bridge --url http://localhost:8000`
    funciona contra o `make dev`.
  - [ ] O guia documenta o uso com o Databricks.
- **Testes:** teste de smoke do CLI (não existe hoje).

### FA.6 · Registry de cobertura AI-first

- **Arquivos:** `api/graphlagoon/mcp/registry.py` e `api/tests/test_agent_registry.py`
  ([03 §8.7](03-arquitetura.md#87-registry-de-cobertura-teste)).
- **Aceite:**
  - [ ] O teste falha se uma rota de investigação não tiver ferramenta nem motivo de
    exceção.
  - [ ] O teste falha se uma rota só humana aceitar token de agente.
  - [ ] A regra AI-first do topo deste plano passa a valer para F2–F4.

### FA.7 · Guia público de agentes e E2E

- **Arquivos:**
  - `docs/guide/agents-mcp.md` (novo, com TL;DR): conectar Claude Code ou Desktop,
    escopos, política de mascaramento, o que agentes não fazem, ponte local;
  - sidebar;
  - prompts MCP `investigar_golpe_pix`, `revisar_lojista`, `montar_dossie`;
  - E2E: o agente (cliente MCP de teste) sobe um artefato e propõe um papel; a pessoa
    aceita na T11 e vê o artefato na T10.
- **Aceite:** `make docs-build` passa.

---

## F2 · Arquivos e enriquecimento

### F2.1 · Tabelas de enriquecimento no context

- **Depende de:** F1.1.
- **Arquivos:**
  - `models/schemas.py` (`EnrichmentTable`, [03 §2.1](03-arquitetura.md#21-colunas-novas-em-graph_contexts));
  - `routers/graph_contexts.py` (validação ao salvar);
  - `services/sql_scope.py` (`context_tables`);
  - `services/enrichment.py` (novo);
  - rota `POST /api/graph-contexts/{id}/enrichment/{name}/lookup`.
- **Passos:**
  1. Ao salvar um context com tabela nova ou alterada, exigir `context.create` e
     validar a tabela contra a allowlist `catalog.schema`, com a mesma checagem de
     autor de `check_scope`. Sem isso, 403.
  2. Incluir as tabelas de enriquecimento em `context_tables()`.
  3. A consulta monta um `SELECT <colunas declaradas> FROM <tabela> WHERE <coluna-chave> IN (…)`
     com identificadores validados (`services/sql_identifiers.py`) e valores
     parametrizados. Limite de chaves por chamada (setting novo) e limite de linhas.
  4. Auditar a leitura com `AuditAction` novo `enrichment.read` e entrada em
     `AUDITED_ROUTES`.
- **Aceite:**
  - [ ] Quem só tem share de escrita no context **não** consegue anexar tabela.
  - [ ] A consulta só devolve as colunas declaradas.
  - [ ] Um leitor sem `context.create` consegue consultar a tabela anexada.
- **Testes:**
  - `test_sql_scope.py` (escopo ampliado);
  - novo `test_enrichment.py` (colunas, chaves malformadas, injeção, limites);
  - `test_permission_routes.py`.
- **Tela:** `screens/T6-Context.png` (aba Enriquecimento).

### F2.2 · Aba de enriquecimento no inspector e "promover a nós"

- **Depende de:** F2.1, F1.6.
- **Arquivos:**
  - `components/investigation/EnrichmentTab.vue` (novo);
  - `stores/graph.ts` (`patchNodeProperties` já existe);
  - padrão de aresta derivada como em `stores/similarity.ts::injectEdges`.
- **Passos:**
  1. Cardinalidade "uma": as colunas viram propriedades do nó, num lote para os nós
     visíveis.
  2. Cardinalidade "várias": tabela no inspector com agregados.
  3. "Promover a nós" cria nós (ex.: Dispositivo) e arestas derivadas, marcados com
     `__derived` e registrados no diário.
- **Aceite:**
  - [ ] A aba segue `screens/T2-Workspace.png` (painel da direita).
  - [ ] Promover cria um nó Dispositivo ligando as contas.
- **Testes:** vitest do componente e da promoção.

### F2.3 · Upload de arquivos

- **Depende de:** F1.2, G2, FA.2 (armazenamento no Volume).
- **Arquivos:**
  - `routers/investigations.py`: `POST .../files` (multipart), `GET .../files`,
    `GET .../files/{fid}/content`;
  - `services/investigation_files.py`;
  - `services/investigation_storage.py` (criado na FA.2);
  - `config.py`: settings `investigation_file_max_bytes` e
    `investigation_max_working_edges` (vem da G4), classificados em
    `CONFIG_FIELD_KINDS`.
- **Passos:**
  1. Receber em **streaming** e calcular o sha256 enquanto grava num temporário.
     Depois gravar **no Volume** em `{investigations_volume_path}/{id}/files/{sha256}`
     com `save_stream`. Se a chave já existe, reaproveita; nunca sobrescreve
     ([03 §2.3](03-arquitetura.md#23-armazenamento-no-volume)).
  2. Papéis `graph`, `enrichment` e `attachment`.
  3. Catálogo de permissões: `investigation.upload`, com gate no `POST`.
  4. Auditar o upload e a leitura do conteúdo.
- **Aceite:**
  - [ ] O hash devolvido bate com o `sha256sum` local.
  - [ ] Acima do limite, 413.
  - [ ] Sem permissão, o botão some e a rota devolve 403.
- **Testes:** novo `test_investigation_files.py` e `test_permission_routes.py`.

### F2.4 · Especificação de mapeamento e presets

- **Depende de:** F2.3.
- **Arquivos:**
  - `frontend/src/utils/fileMapping.ts` (interpretador TS, para prévia);
  - `api/graphlagoon/services/file_mapping.py` (interpretador Python, **autoritativo**);
  - presets em `frontend/src/utils/fileMappingPresets.ts` e espelho em Python;
  - fixtures douradas em `frontend/src/__tests__/fixtures/fileMapping/`
    (`simba-mini/` com os 5 TXT, `qsa-mini.csv`, `generico.csv`, cada um com
    `spec.json` e `expected.json`).
- **Passos:**
  1. Implementar o formato de [03 §4](03-arquitetura.md#4-especificação-de-mapeamento-de-arquivo).
  2. Nos dois interpretadores, a mesma entrada com a mesma spec gera o **mesmo**
     `GraphResponse`.
  3. Preset SIMBA v3.1:
     - TAB, `ddmmaaaa`, centavos;
     - EXTRATO × ORIGEM_DESTINO viram arestas;
     - ag. 9999 / NAO-CORRENTISTA viram um nó "Desconhecido" por transação.
  4. Preset QSA da Receita: `;` como separador, sócio com CPF mascarado.
- **Aceite:**
  - [ ] Os testes de paridade (vitest e pytest lendo as mesmas fixtures) passam.
  - [ ] Os presets são sugeridos quando os cabeçalhos batem.
- **Testes:** `utils/__tests__/fileMapping.test.ts` e `api/tests/test_file_mapping.py`.

### F2.5 · Datasource `file` e assistente (T4)

- **Depende de:** F2.4.
- **Arquivos:**
  - `models/schemas.py` (`DatasourceType` ganha `"file"`);
  - `services/datasource/file.py` (novo) e `services/datasource/factory.py`;
  - `composables/useDatasourceCapabilities.ts`;
  - `components/investigation/FileImportWizard.vue` (novo, T4);
  - `POST .../files/{fid}/context`, que gera o grafo no servidor e cria o context de
    arquivo e a exploração.
- **Aceite:**
  - [ ] O assistente segue `screens/T4-Arquivo.png`: passos, detecção, tabela de
    mapeamento, qualidade, salvar mapeamento.
  - [ ] O grafo do arquivo abre como exploração do caso.
  - [ ] Capabilities do context `file`: sem SQL e sem transpile; a UI esconde o Query
    Console.
- **Testes:** pytest do datasource; vitest do assistente; E2E do upload do SIMBA mini
  até o grafo.

### F2.6 · Arquivo como enriquecimento do caso

- **Depende de:** F2.4, F2.2.
- **Passos:** um arquivo com papel `enrichment` aparece na aba de enriquecimento
  (junta por chave no cliente, com a mesma UI da F2.2), com escopo só do caso.
- **Aceite:**
  - [ ] O QSA mini enriquece os lojistas por CNPJ.
  - [ ] O QSA não aparece fora do caso.
- **Testes:** vitest.

### F2.7 · Gravar valores de métricas como propriedade

- **Arquivos:** `stores/metrics.ts`, `stores/customMetrics.ts`, `stores/graph.ts`
  (`patchNodeProperties`, `buildGraphSnapshot`).
- **Aceite:**
  - [ ] Uma ação "gravar como propriedade" persiste o valor no snapshot e o registra
    no diário.
- **Testes:** vitest.

### F2.8 · Resolução de entidades e revisão de matches (T8)

- **Depende de:** F1.6, F2.6.
- **Arquivos:**
  - `src/workers/erWorker.ts` (novo; algoritmo em [03 §6.2](03-arquitetura.md#62-resolução-de-entidades));
  - API `.../matches` (GET, POST, PATCH);
  - `views/InvestigationMatchesView.vue` (novo, T8).
- **Aceite:**
  - [ ] Match com CPF mascarado **nunca** vira merge automático.
  - [ ] Aceitar, recusar e adiar gravam o motivo no diário.
  - [ ] A tela segue `screens/T8-Matches.png`.
- **Testes:** vitest do worker (blocking, Jaro-Winkler, mascarado); pytest da API; E2E
  aceitar → anel cresce.

---

## F3 · Seguir o dinheiro

### F3.1 · Semântica de valor e horário

- **Arquivos:**
  - `graph_contexts.edge_semantics` (já criado na F1.1):
    `{amount_prop, time_prop, currency, direction?}`;
  - formulário do context;
  - mapeamento de arquivo (F2.4) preenche os mesmos campos.
- **Aceite:**
  - [ ] Um context com semântica declarada expõe valor e horário de cada aresta à UI e
    aos workers.
- **Testes:** pytest de validação e vitest.

### F3.2 · Soma de arestas paralelas e largura por valor

- **Depende de:** G1, F3.1.
- **Arquivos:** `src/utils/parallelEdges.ts` (novo) e `utils/graphAppearance.ts`.
- **Aceite:**
  - [ ] Agregação por (origem, destino, tipo) com soma, contagem e primeira e última
    data, só na exibição.
  - [ ] A largura da aresta é proporcional ao valor.
- **Testes:** vitest.

### F3.3 · Worker de rastreio temporal

- **Depende de:** F3.1.
- **Arquivos:**
  - `src/workers/traceWorker.ts` e `src/utils/trace.ts` (núcleo puro, testável fora do
    worker);
  - fixture `src/__tests__/fixtures/trace/golpe-pix.json`.
- **Passos:** implementar exatamente [03 §6.1](03-arquitetura.md#61-rastreio-temporal-seguir-o-dinheiro).
- **Aceite (fixture do golpe Pix, a mesma das telas):**
  - [ ] **FIFO:** saídas Saque 2.000, Exchange 1.550 e Bet 880 (total 4.430, 91%);
    retidos 4471-0 = 70, 8812-7 = 350, 3090-1 = 20.
  - [ ] **Proporcional:** Exchange = 1.597,73.
  - [ ] Respeita Δ: com Δ = 40 min, a saída das 15:05 em 8812-7 (54 min parada) não é
    seguida; as saídas de 5520-3 (31 min) e 3090-1 (16 min) são.
  - [ ] Respeita paradas, camadas e valor mínimo.
  - [ ] **LIBR** e **contaminação total** testados com casos próprios descritos em
    [03 §6.1](03-arquitetura.md#61-rastreio-temporal-seguir-o-dinheiro).
- **Testes:** `utils/__tests__/trace.test.ts`.

### F3.4 · Tela de rastreio (T5)

- **Depende de:** F3.2, F3.3.
- **Arquivos:**
  - `components/investigation/TracePanel.vue`, `TraceSankey.vue` (novos);
  - layout `trace-layers` em `utils/layoutModes.ts` e em `LAYOUT_ALGORITHMS`
    (`types/graph.ts`);
  - item "Seguir o dinheiro → para frente / para trás" no menu de contexto
    (`composables/useContextMenu.ts`).
- **Aceite:**
  - [ ] A tela segue `screens/T5-Rastreio.png` e `screens/T5-Rastreio-Sankey.png`.
  - [ ] O carimbo do método lista todos os parâmetros.
  - [ ] "Salvar como evidência" funciona depois da F4.1; até lá, o botão fica
    desabilitado com um tooltip.
- **Testes:** vitest dos componentes; E2E abrir caso → seguir o dinheiro → ver as
  saídas.

### F3.5 · Linha do tempo em raias

- **Arquivos:** `components/investigation/SwimlaneTimeline.vue` (novo).
- **Aceite:**
  - [ ] Uma raia por conta, com setas no horário e faixas de permanência.
  - [ ] Selecionar uma janela filtra o grafo e o Sankey.
- **Testes:** vitest.

### F3.6 · Caminhos

- **Arquivos:** `src/workers/pathWorker.ts` (novo) e um item de menu "Caminho até…".
- **Aceite:**
  - [ ] Caminho mais curto (BFS), ponderado (Dijkstra), k mais curtos (Yen, k ≤ 10).
  - [ ] Caminho que respeita o tempo (chegada mais cedo), conforme [03 §6.3](03-arquitetura.md#63-caminhos).
- **Testes:** vitest com grafos pequenos de resposta conhecida.

### F3.7 · Componentes conexos

- **Arquivos:** `services/algorithmRegistry.ts` e `workers/metricsWorker.ts`.
- **Aceite:**
  - [ ] Componentes fracos e fortes viram métrica (id do componente) e opção de
    cluster.
- **Testes:** vitest.

### F3.8 · Rastreio e caminhos no servidor, com ferramentas MCP

- **Por quê:** o agente não roda web workers. As análises que ele usa precisam existir
  no servidor, com o mesmo resultado.
- **Depende de:** F3.3, F3.6, FA.4.
- **Arquivos:**
  - `api/graphlagoon/services/trace.py` (porte de `utils/trace.ts`);
  - `services/paths.py`;
  - ferramentas MCP `trace_money` e `find_paths`, mais as rotas
    `POST .../analysis/trace` e `.../analysis/paths`.
- **Aceite:**
  - [ ] O teste pytest lê **a mesma** fixture `frontend/src/__tests__/fixtures/trace/golpe-pix.json`
    e chega aos mesmos números do vitest em todas as regras.
  - [ ] O resultado do rastreio pode virar evidência (F4.1) com o carimbo do método.
- **Testes:** `api/tests/test_trace.py` e `test_paths.py`.

---

## F4 · Dossiê e compliance

### F4.1 · Evidências congeladas

- **Arquivos:** API `.../evidence` (POST, GET) e um botão "fixar evidência" no T2 e no
  T5.
- **Aceite:**
  - [ ] A evidência guarda o snapshot gz, o sha256, os parâmetros e o autor.
  - [ ] A evidência é imutável.
- **Testes:** pytest (hash e imutabilidade).

### F4.2 · Hipóteses e tela do dossiê (T7)

- **Arquivos:** `views/InvestigationDossierView.vue` (novo); hipóteses no `state` do
  caso ([03 §2.2](03-arquitetura.md#22-tabelas-novas)).
- **Aceite:**
  - [ ] A tela segue `screens/T7-Dossie.png`: resumo, indicadores, hipóteses com
    evidências a favor e contra, evidências, diário.
- **Testes:** vitest e E2E.

### F4.3 · Selos de tipologia e anel de lojistas (T9)

- **Arquivos:**
  - `src/utils/typologies.ts` (registry; definições em [03 §6.4](03-arquitetura.md#64-tipologias));
  - `components/investigation/TypologyBadgesPanel.vue`;
  - preset de layout bipartido (hive com 2 eixos).
- **Aceite:**
  - [ ] Cada selo cita o item da CC 4.001.
  - [ ] Os selos sugerem; aceitar um selo grava evento.
  - [ ] A tela segue `screens/T9-Anel.png`.
  - [ ] Existe implementação Python espelhada (`services/typologies.py`) para a
    ferramenta MCP `run_typologies`, com paridade por fixtures comuns.
- **Testes:** vitest de cada tipologia com grafos pequenos.

### F4.4 · Status e prazos

- **Arquivos:** `services/investigations.py` (cálculo de prazos) e `InvestigationsView.vue`.
- **Aceite:**
  - [ ] Seleção em 45 dias a partir da criação; análise em 45 dias a partir de
    `selected_at`.
  - [ ] Com menos de 7 dias, o destaque fica laranja (como na T1).
- **Testes:** pytest com `freezegun` ou um relógio injetado, e vitest.

### F4.5 · Decisão, congelamento e retenção

- **Arquivos:** `POST .../decision` e `services/investigations.py`.
- **Passos:**
  1. Registrar o resultado (comunicar ou arquivar), as ações, a fundamentação, o autor
     e a hora.
  2. Congelar todas as fontes vivas.
  3. Calcular o `frozen_hash` do caso (canônico: estado, fontes, evidências, eventos).
  4. Depois disso, o caso fica só-leitura, e o `DELETE` devolve 409 para todos, exceto
     o superuser com motivo, auditado.
  5. Setting `investigation_retention_years` (padrão 10).
- **Aceite:**
  - [ ] Depois da decisão, nenhuma mutação é aceita.
  - [ ] O hash é reprodutível.
- **Testes:** pytest.

### F4.6 · Exportações

- **Depende de:** G2, F4.5.
- **Arquivos:**
  - `GET .../export?format=json|csv|simba|siscoaf`;
  - laudo PDF via página de impressão do dossiê (CSS print).
- **Passos:**
  1. Catálogo de permissões: `investigation.export`, com gate.
  2. Toda exportação é auditada e inclui o método do rastreio e os hashes dos arquivos.
- **Aceite:**
  - [ ] O CSV sai sem injeção (G2).
  - [ ] O SIMBA exportado relê com o preset da F2.4 (ida e volta).
- **Testes:** pytest e vitest.

---

## F5 · Escala e IA (opcional)

- **F5.1:** gravar o grafo de um context de arquivo como tabela Delta num schema de
  rascunho configurável. O context passa de `file` para `sql_warehouse`.
- **F5.2:** o rastreio da F3.3 reescrito como SQL iterativo (camada a camada), para
  grafos acima do teto da G4. O resultado tem de bater com a fixture do golpe Pix.
- **F5.3:** narrativa do resumo do dossiê assistida por LLM, sempre como rascunho
  editável e nunca como decisão (LGPD art. 20).
