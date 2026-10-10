# O que o agente de IA pode e não pode fazer numa investigação

> **Documento de revisão.** Registra a política em vigor no branch
> `feature/investigations` em 2026-10-09 e as perguntas que ficaram abertas. Ao
> mudar a política, atualize este arquivo, o registry e o decision log no mesmo
> commit.

**Princípio:** o agente faz o trabalho de análise e documentação; a pessoa decide
(README, Q9). O agente sempre age **em nome de uma pessoa**, com um token `glt_`, e
nunca tem mais acesso que ela. Tudo o que ele faz aparece no diário como "agente X em
nome de Y".

**Onde a política mora no código:**

| O quê | Arquivo |
|---|---|
| Rota → ferramenta MCP, ou motivo de não ter | `api/graphlagoon/mcp/registry.py` |
| Ferramentas MCP e escopo exigido | `api/graphlagoon/mcp/server.py` |
| Bloqueio de rotas só humanas | `forbid_agents` em `api/graphlagoon/utils/authz.py` |
| Teste que obriga a cobertura | `api/tests/test_agent_registry.py` |

## 1. Os quatro níveis

| Nível | Significado | Como é garantido |
|---|---|---|
| **Direto** | O agente faz sozinho; fica no diário | Ferramenta MCP + escopo do token |
| **Proposta** | O agente sugere; uma pessoa aceita ou recusa na T11 | Rota devolve `403 AGENT_MUST_PROPOSE`; o agente usa `propose` |
| **Só na interface** | Sem ferramenta MCP, mas não é proibido por princípio | Rota sem ferramenta, com motivo no registry |
| **Nunca** | Ação de pessoa, mesmo que o dono do token seja superuser | `forbid_agents` + motivo `human-only:`; o teste confere que a rota devolve 403 |

## 2. Matriz atual

### Caso

| Ação | Nível | Ferramenta / rota | Escopo |
|---|---|---|---|
| Listar e ler casos, fontes, diário, notas, dossiê | Direto | `list_investigations`, `get_investigation`, `list_events`, `list_notes`, `get_dossier` | `read` |
| Criar caso | Direto | `create_investigation` | `write` |
| Adicionar exploração como fonte | Direto | `add_source` | `write` |
| Adicionar nota | Direto | `add_note` | `write` |
| Mudar status ou tipologia | Proposta | `propose` (kind `status`, `typology`) | `propose` |
| Editar título ou descrição | Só na interface | `PATCH /investigations/{id}` | n/a |
| Editar ou apagar nota | Só na interface (só o autor) | `PATCH`/`DELETE .../notes/{id}` | n/a |
| Remover fonte | Só na interface | `DELETE .../sources/{id}` | n/a |
| Apagar caso | **Nunca** | n/a | n/a |
| Compartilhar ou descompartilhar | **Nunca** | n/a | n/a |
| Registrar a decisão (comunicar ou arquivar) | **Nunca** | n/a | n/a |
| Exportar (json, csv, SIMBA, Siscoaf) | **Nunca** | n/a | n/a |

### Grafo, entidades e análises

| Ação | Nível | Ferramenta | Escopo |
|---|---|---|---|
| Ler grafo unificado, buscar e ler entidades | Direto | `get_graph`, `search_entities`, `get_entity` | `read` |
| Consultar tabela de enriquecimento | Direto | `lookup_enrichment` | `read` |
| Seguir o dinheiro (rastreio) | Direto | `trace_money` | `analyze` |
| Caminhos | Direto | `find_paths` | `analyze` |
| Tipologias (selos CC 4.001) | Direto (só calcula) | `run_typologies` | `analyze` |
| Sugerir matches de entidades | Direto (só sugere) | `suggest_matches` | `analyze` |
| Aceitar, recusar ou adiar match | **Nunca** (o agente propõe kind `match`) | n/a | n/a |
| Atribuir papel (vítima, laranja, saída, descartado) | Proposta | `propose` (kind `role`) | `propose` |
| Criar hipótese ou mudar seu status | Proposta | `propose` (kind `hypothesis`, `hypothesis_status`) | `propose` |
| Aceitar um selo de tipologia | Proposta | `propose` (kind `typology`) | `propose` |

### Evidências, arquivos e artefatos

| Ação | Nível | Ferramenta | Escopo |
|---|---|---|---|
| Fixar evidência (inclusive um rastreio) | Direto | `pin_evidence` | `write` |
| Editar ou apagar evidência | Ninguém: evidência é imutável | n/a | n/a |
| Subir arquivo (SIMBA, QSA, CSV) | Direto | `upload_file` | `write` |
| Mapear arquivo e gerar grafo dele | Direto | `set_file_mapping`, `create_file_graph` | `write` |
| Criar artefato ou subir nova versão | Direto (entra como rascunho) | `upload_artifact` | `write` |
| Aprovar versão de artefato | **Nunca** | n/a | n/a |
| Ler artefatos e arquivos | Direto | `list_artifacts`, `get_artifact`, `list_files`, `get_file` | `read` |

### Tokens e administração

| Ação | Nível |
|---|---|
| Criar, listar ou revogar tokens | **Nunca** (o agente não emite token para si) |
| Qualquer rota `/api/admin` | **Nunca** (`require_superuser` recusa agentes) |

## 3. Proteções que valem para tudo

1. **Mascaramento:** CPF, CNPJ e conta saem mascarados por padrão
   (`agents_allow_unmasked_data = false`, Q8). Um id mascarado que o agente devolve é
   traduzido de volta no servidor.
2. **Dados marcados `untrusted_data`:** o conteúdo do caso vai embrulhado nas
   respostas MCP, contra prompt injection. Nenhuma ferramenta executa código ou expõe
   caminho do Volume.
3. **O servidor não confia no número do agente:** `pin_evidence` de um rastreio roda
   o rastreio de novo no servidor.
4. **Sem sobrescrita:** artefatos e evidências só ganham versões novas.
5. **Leituras auditadas:** toda ferramenta de leitura grava `agent.read`.
6. **Limites:**
   - `agents_enabled = false` desliga tudo (o padrão);
   - validade máxima do token: `agent_token_max_days = 90`;
   - taxa por token: `agent_rate_limit_per_minute = 120`.
7. **Caso decidido:** depois da decisão, toda mutação devolve 409, para agente e
   pessoa.

## 4. Pontos em aberto para revisão

| # | Pergunta | Hoje | Opções |
|---|---|---|---|
| R1 | O agente pode editar **título e descrição** do caso? | Só na interface (escolha de implementação, não da Q9) | Ferramenta `update_investigation` restrita a título e descrição |
| R2 | O agente pode **editar as próprias notas**? | Não; só acrescenta | Permitir editar nota cujo autor é o próprio token |
| R3 | O agente pode **remover uma fonte que ele mesmo adicionou**? | Não | Permitir dentro da mesma sessão, ou via proposta |
| R4 | O agente pode **exportar** com dados mascarados? | Não; lê o caso via `get_dossier` | Exportação mascarada só para agentes |
| R5 | Artefatos **binários** saem sem mascaramento | Sim (atalho da FA.4) | Bloquear binários para agentes ou mascarar o texto extraível |
| R6 | O grafo do servidor (que o agente lê) **ignora matches aceitos** | Sim (lacuna) | Aplicar matches aceitos no `services/case_graph.py` |
| R7 | **Proposta em lote** (vários papéis de uma vez) | Uma por chamada | Kind `batch` com aceite parcial |
| R8 | **Status por proposta** é suficiente para o prazo legal? | Sim | Alerta para o responsável quando houver proposta de status pendente perto do prazo |

## 5. Como mudar a política

1. Altere a rota (`forbid_agents`, `AGENT_MUST_PROPOSE` ou uma ferramenta nova em
   `mcp/server.py`).
2. Atualize `mcp/registry.py`. O `test_agent_registry.py` falha se rota e registry
   divergirem.
3. Atualize este documento, a seção de agentes em `docs/guide/agents-mcp.md` e o
   decision log.
