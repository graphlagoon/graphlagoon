# O agente numa investigação: o que faz, o que vira sugestão, o que nunca faz

> **Documento de referência da política em vigor** (05-plano-v2 §6, F5, 2026-10-10;
> atualizado pelo plano 06, P1–P8, 2026-10-20: sem máscara, tipos de caso, decisões
> múltiplas com proposta do agente, tarefas, entidade em outros casos).
> Substitui a matriz "direto / propõe / nunca" do plano antigo, que não existe mais:
> não há `propose`, tabela de propostas nem tela própria. Ao mudar a política,
> atualize este arquivo, `mcp/registry.py` e o decision log no mesmo commit.

**Princípio:** o agente é **um analista com a identidade da pessoa**. Com um token
`glt_` ele faz no caso o que a pessoa faz, pelas mesmas funções de serviço que a tela
usa, e nunca tem mais acesso que ela. Toda escrita registra `author_kind=agent` +
`agent_token_id`; só alguns tipos entram como `suggested`; uma lista curta de atos
irreversíveis fica sem ferramenta.

**Onde a política mora no código:**

| O quê | Arquivo |
|---|---|
| Ferramenta → rota humana equivalente (`TOOL_ROUTES`), rota sem ferramenta → motivo (`AGENT_EXEMPT_ROUTES`) | `api/graphlagoon/mcp/registry.py` |
| Ferramentas, recursos e prompts MCP (cada ferramenta carimba `meta.human_equivalent`) | `api/graphlagoon/mcp/server.py` |
| Autoria e `suggested` (`author_fields`, `write_status`, `DEFAULT_SUGGEST_KINDS`) | `api/graphlagoon/services/cases.py` |
| Allowlist de caminhos e escopo `user|case` do token | `api/graphlagoon/middleware/auth.py` |
| Bloqueio de rotas só humanas (`forbid_agents`) | `api/graphlagoon/utils/authz.py` |
| Biblioteca (playbooks, templates de relatório, mapeamentos) e tipos de caso | `api/graphlagoon/services/org_library.py`, `case_types.py`, `reports.py` |
| Testes que obrigam a cobertura | `api/tests/test_agent_registry.py`, `test_mcp_server.py`, `test_agent_tokens.py`, `test_agent_route_scoping.py`, `test_org_library.py` |

## 1. Os três níveis

| Nível | Significado | Como é garantido |
|---|---|---|
| **Direto** | O agente faz sozinho; o item/anotação nasce `confirmed` com o chip de agente; fica no diário | Ferramenta MCP = mesma função de serviço da rota REST, com `_current_actor` = token |
| **Sugerido** | A escrita existe, com autor, mas `status=suggested`; uma pessoa confirma ou recusa **no lugar** (lista de material, inspetor) | `write_status(inv, kind)`: `kind ∈ settings.agent_suggest_kinds` (padrão `role, tag, hypothesis_status, same_as, status_change, task`; o ⚙ do caso pode acrescentar `group`, `note` ou retirar). Proposta de decisão (`decision_proposal`) e relatório do agente são sempre sugeridos |
| **Nunca** | Ato de pessoa, mesmo com dono superuser | Sem ferramenta; rota com `forbid_agents` + motivo `human-only:` no registry; o teste confere 403 `AGENT_FORBIDDEN` |

Não existe "só na interface" como categoria de política: as poucas rotas sem
ferramenta que não são humanas (apagar item/anotação, bytes de arquivo) têm o motivo
no registry e o teste exige que ele exista.

## 2. Ferramentas e sua rota humana

| Ferramenta | Rota humana equivalente | Observação |
|---|---|---|
| `list_cases`, `get_case`, `create_case`, `update_case` | `GET/POST /investigations`, `GET/PATCH /{id}` | fila paginada; `create_case` com tipo, campos e `external_ref` idempotente, exige `investigation.create`; token `scope=case` não cria; status do agente vira `status_change` sugerido |
| `get_brief`, `write_brief` | `GET/PUT /{id}/brief` | nova versão do `document/brief` |
| `list_items`, `read_item`, `update_item`, `search_case` | `GET /{id}/items`, `/items/{item}` + `/versions` + `/text`, `PATCH /items/{item}`, `GET /{id}/search` | `read_item` pagina o texto e devolve PNG/JPEG/GIF/WebP como conteúdo de imagem (até `agent_image_max_bytes`); `update_item(chart=…)` |
| `add_item`, `add_note`, `add_document`, `add_table`, `save_query`, `import_file`, `create_exploration` | `POST /{id}/items` (e `POST /items/{item}/versions`) | `graph/view` e `graph/selection` validados; `import_file` exige `investigation.upload` |
| `run_query`, `join_tables`, `compare_tables`, `promote_tables` | `POST /items/{item}/run`, `/items/join`, `/compare`, `/promote` | cada run é uma versão |
| `pin_evidence` | `POST /items/{item}/pin` | imutável |
| `annotate`, `list_annotations`, `group` | `POST/GET /{id}/annotations`, `PATCH /annotations/{a}` | `role, tag, same_as, hypothesis, hypothesis_status`, grupos |
| `list_tasks`, `add_task`, `update_task` | `GET /investigations/tasks`, `POST/PATCH /annotations` | o agente edita só as tarefas que escreveu ou atribuídas ao nome do seu token (`TASK_NOT_YOURS`) |
| `propose_decision` | `POST /{id}/annotations` | rascunho `decision_proposal`, sempre sugerido; a pessoa grava com `proposal_id` |
| `render_report` | `POST /{id}/reports`, `GET /api/org/library` | rascunho markdown sugerido a partir de um template da org |
| `get_graph`, `search_entities`, `get_entity`, `lookup_enrichment`, `find_entity_cases` | `GET /{id}/graph`, `/items/{item}/snapshot`, enrichment lookup, `GET /investigations/entities/cases` | `find_entity_cases` só vê casos legíveis (e o escopo do token) |
| `run_analysis` (`trace`, `paths`, `er`, `links`, `communities`) | `POST /{id}/analysis/trace|paths|er`, `POST /{id}/events` | `er` cria `same_as` sugeridos; o rastreio usa os padrões do tipo |
| `list_events`, `changes_since` | `GET /{id}/events` (+ items, annotations) | `changes_since` devolve `now` |
| `get_playbook`, `get_case_type` | `GET /api/org/library[/{slug}]`, `GET /api/org/case-types[/{slug}]` | biblioteca e tipos de caso |

**Recursos:** `case://{id}/brief`, `case://{id}/items`, `case://{id}/items/{item}` (texto),
`case://{id}/graph?offset&limit`, `case://{id}/changes?since`, `org://playbooks/{slug}`,
`org://case-types/{slug}`. **Prompts:** um por playbook da biblioteca (semeados:
`claude_code_quickstart`, `triage`, `assemble_brief`) mais `playbook(slug)`.

## 3. O que fica sem ferramenta

| Rota | Nível | Motivo |
|---|---|---|
| `POST /{id}/decisions`, `POST /{id}/decisions/{d}/review` | **Nunca** | a decisão e os quatro olhos são de pessoas; o agente propõe (`propose_decision`) |
| `POST /{id}/share`, `DELETE /{id}/share/{email}` | **Nunca** | compartilhar com novas pessoas |
| `DELETE /{id}` | **Nunca** | apagar caso |
| `POST /{id}/reopen` | **Nunca** | reabrir caso fechado |
| `GET /{id}/export` | **Nunca** | o que sai do app é decisão da pessoa |
| `POST /items/{i}/confirm|reject`, `POST /annotations/{a}/confirm|reject` | **Nunca** | o agente não confirma as próprias sugestões |
| `/api/agent-tokens*` | **Nunca** | o agente não emite nem revoga token |
| `DELETE /items/{i}`, `DELETE /annotations/{a}` | sem ferramenta | o agente acrescenta e versiona, não remove |
| `GET /items/{i}/content` | sem ferramenta | binário nunca pela REST; o agente lê `/text`, e imagens pelo `read_item` |
| Qualquer rota fora da allowlist (`/api/admin`, `/api/graph-contexts` exceto consultas, share de contexto/exploração) | **Nunca** | `AGENT_FORBIDDEN` no middleware |

`agents_allow_irreversible` (05 §6) não foi implementado: nenhuma instalação pediu
liberar decisão/share/apagar para agentes; quando pedir, é um flag no `forbid_agents`.

## 4. Proteções que valem para tudo

1. **Escopo do token:** `user` (todos os casos que a pessoa lê) ou `case` (só os
   `investigation_ids`); vale igual em REST e MCP (`can_read_case` consulta o ator).
2. **Sem máscara** (plano 06): o agente vê o que a pessoa vê; a minimização é das
   colunas expostas pelo context, dos shares e dos tokens de caso.
3. **Binário:** extração de texto server-side (`text_extract.py`); imagens até
   `agent_image_max_bytes` como conteúdo de imagem MCP; o resto nunca.
4. **`untrusted_data`:** todo conteúdo do caso vai embrulhado nas respostas, contra
   prompt injection; nenhuma ferramenta executa código.
5. **Leituras auditadas** (`agent.read`); escritas auditadas como as humanas
   (`investigation.item_add`, …) com o ator agente.
6. **Limites:** `agents_enabled=false` desliga tudo (padrão); `agent_token_max_days=90`;
   `agent_rate_limit_per_minute=120` por processo; `last_used_at` por token.
7. **Caso fechado:** toda mutação devolve 409, para agente e pessoa, exceto tarefas e
   relatórios rascunhados.

## 5. Como mudar a política

1. Ferramenta nova → `mcp/server.py` com `tool("nome")` **e** a entrada em
   `TOOL_ROUTES` (o helper carimba `meta.human_equivalent` a partir dela).
2. Rota nova em `routers/investigations.py` ou `routers/org.py` → ferramenta em
   `TOOL_ROUTES` ou motivo em `AGENT_EXEMPT_ROUTES` (`human-only:` exige `forbid_agents`).
3. Tipo que deixa de ser sugestão → `DEFAULT_SUGGEST_KINDS` em `services/cases.py` e
   `caseVocabulary.ts`; por tipo de caso (`agent_suggest_kinds`) e por caso, o ⚙.
4. Rode `test_agent_registry.py`, `test_mcp_server.py`, `test_agent_route_scoping.py`, `test_case_tasks.py`;
   atualize este arquivo, `docs/guide/agents-mcp.md` e o decision log.
