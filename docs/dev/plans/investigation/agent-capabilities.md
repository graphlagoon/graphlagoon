# O agente numa investigação: o que faz, o que vira sugestão, o que nunca faz

> **Documento de referência da política em vigor** (05-plano-v2 §6, F5, 2026-10-10).
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
| Mascaramento | `api/graphlagoon/services/masking.py` |
| Biblioteca (playbooks) e vocabulários da org | `api/graphlagoon/services/org_library.py`, `org_vocabularies.py` |
| Testes que obrigam a cobertura | `api/tests/test_agent_registry.py`, `test_mcp_server.py`, `test_agent_tokens.py`, `test_agent_route_scoping.py`, `test_org_library.py` |

## 1. Os três níveis

| Nível | Significado | Como é garantido |
|---|---|---|
| **Direto** | O agente faz sozinho; o item/anotação nasce `confirmed` com o chip de agente; fica no diário | Ferramenta MCP = mesma função de serviço da rota REST, com `_current_actor` = token |
| **Sugerido** | A escrita existe, com autor, mas `status=suggested`; uma pessoa confirma ou recusa **no lugar** (lista de material, inspetor) | `write_status(inv, kind)`: `kind ∈ settings.agent_suggest_kinds` (padrão `role, tag, hypothesis_status, same_as, status_change, typology`; o ⚙ do caso pode acrescentar `group`, `note` ou retirar) |
| **Nunca** | Ato de pessoa, mesmo com dono superuser | Sem ferramenta; rota com `forbid_agents` + motivo `human-only:` no registry; o teste confere 403 `AGENT_FORBIDDEN` |

Não existe "só na interface" como categoria de política: as poucas rotas sem
ferramenta que não são humanas (apagar item/anotação, bytes de arquivo) têm o motivo
no registry e o teste exige que ele exista.

## 2. Ferramentas e sua rota humana

| Ferramenta | Rota humana equivalente | Observação |
|---|---|---|
| `list_cases`, `get_case`, `create_case`, `update_case` | `GET/POST /investigations`, `GET/PATCH /{id}` | `create_case` exige `investigation.create` da pessoa; token `scope=case` não cria; `update_case` não atribui responsável (handler recusa) e a mudança de status de um agente vira anotação `status_change` sugerida |
| `get_brief`, `write_brief` | `GET/PUT /{id}/brief` | nova versão do item `document/brief` por escrita |
| `list_items`, `read_item`, `update_item`, `search_case` | `GET /{id}/items`, `GET /items/{item}` + `/versions` + `/text`, `PATCH /items/{item}`, `GET /{id}/search` | `read_item` pagina texto já mascarado; nunca bytes |
| `add_item`, `add_note`, `add_document`, `add_table`, `save_query`, `import_file`, `create_exploration` | `POST /{id}/items` (e `POST /items/{item}/versions`) | `import_file`/csv exige `investigation.upload`; `create_exploration` exige `exploration.save` |
| `run_query`, `join_tables`, `compare_tables`, `promote_tables` | `POST /items/{item}/run`, `/items/join`, `/compare`, `/promote` | cada run é uma versão com `run` |
| `pin_evidence` | `POST /items/{item}/pin` | imutável; exploração viva é congelada antes |
| `annotate`, `list_annotations` | `POST/GET /{id}/annotations` | `role, tag, same_as, hypothesis, hypothesis_status, typology` |
| `group` | `POST /{id}/annotations`, `PATCH /annotations/{a}` | create / add / remove; valor `{name, color, by: "agent"}` |
| `get_graph`, `search_entities`, `get_entity`, `lookup_enrichment` | `GET /{id}/graph`, `GET /items/{item}/snapshot`, `POST /graph-contexts/{c}/enrichment/{n}/lookup` | ids mascarados são traduzidos de volta no servidor |
| `run_analysis` (`trace`, `paths`, `typologies`, `er`, `links`, `communities`) | `POST /{id}/analysis/trace|paths|typologies|er`, `POST /{id}/events` | `er` cria `same_as` sugeridos; `links` e `communities` rodam no servidor sobre o grafo unificado; `save=true` grava `table/result` ou `graph/derived` com `provenance {tool, params, engine}` |
| `list_events`, `changes_since` | `GET /{id}/events` (+ items, annotations) | `changes_since` devolve `now` para a próxima chamada |
| `get_playbook`, `list_vocabulary` | `GET /api/org/library[/{slug}]`, `GET /api/org/vocabularies[/{kind}]` | leitura da biblioteca e dos vocabulários da org |

**Recursos:** `case://{id}/brief`, `case://{id}/items`, `case://{id}/items/{item}` (texto),
`case://{id}/graph?offset&limit`, `case://{id}/changes?since`, `org://playbooks/{slug}`,
`org://vocabularies/{kind}`. **Prompts:** um por playbook da biblioteca (6 semeados:
`investigar_golpe_pix`, `revisar_lojista`, `montar_dossie`, `analise_credito_grupo`,
`fuga_garantia`, `fraude_sintetica`) mais `playbook(slug)` para qualquer doc.

## 3. O que fica sem ferramenta

| Rota | Nível | Motivo |
|---|---|---|
| `POST /{id}/decision` | **Nunca** | a decisão é da pessoa (LGPD art. 20) |
| `POST /{id}/share`, `DELETE /{id}/share/{email}` | **Nunca** | compartilhar com novas pessoas |
| `DELETE /{id}` | **Nunca** | apagar caso |
| `POST /{id}/reopen` | **Nunca** | reabrir caso decidido |
| `GET /{id}/export` | **Nunca** | sai sem máscara e prepara a comunicação |
| `POST /items/{i}/confirm|reject`, `POST /annotations/{a}/confirm|reject` | **Nunca** | o agente não confirma as próprias sugestões |
| `/api/agent-tokens*` | **Nunca** | o agente não emite nem revoga token |
| `DELETE /items/{i}`, `DELETE /annotations/{a}` | sem ferramenta | o agente acrescenta e versiona, não remove |
| `GET /items/{i}/content` | sem ferramenta | binário nunca chega ao agente; ele lê `/text` |
| Qualquer rota fora da allowlist (`/api/admin`, `/api/graph-contexts` exceto consultas, share de contexto/exploração) | **Nunca** | `AGENT_FORBIDDEN` no middleware |

`agents_allow_irreversible` (05 §6) não foi implementado: nenhuma instalação pediu
liberar decisão/share/apagar para agentes; quando pedir, é um flag no `forbid_agents`.

## 4. Proteções que valem para tudo

1. **Escopo do token:** `user` (todos os casos que a pessoa lê) ou `case` (só os
   `investigation_ids`); vale igual em REST e MCP (`can_read_case` consulta o ator).
2. **Mascaramento no serviço:** CPF, CNPJ, contas e os valores de identidade do caso
   saem mascarados em itens, texto, grafo, anotações, eventos e snapshots quando
   `token.unmasked=false`; `unmasked` efetivo = org permite ∧ token marcado. Texto é
   mascarado **antes** de paginar.
3. **Binário nunca:** extração de texto server-side (`text_extract.py`); PDF escaneado
   → metadados + aviso.
4. **`untrusted_data`:** todo conteúdo do caso vai embrulhado nas respostas, contra
   prompt injection; nenhuma ferramenta executa código.
5. **Leituras auditadas** (`agent.read`); escritas auditadas como as humanas
   (`investigation.item_add`, …) com o ator agente.
6. **Limites:** `agents_enabled=false` desliga tudo (padrão); `agent_token_max_days=90`;
   `agent_rate_limit_per_minute=120` por processo; `last_used_at` por token.
7. **Caso decidido:** toda mutação devolve 409, para agente e pessoa.

## 5. Como mudar a política

1. Ferramenta nova → `mcp/server.py` com `tool("nome")` **e** a entrada em
   `TOOL_ROUTES` (o helper carimba `meta.human_equivalent` a partir dela).
2. Rota nova em `routers/investigations.py` ou `routers/org.py` → ferramenta em
   `TOOL_ROUTES` ou motivo em `AGENT_EXEMPT_ROUTES` (`human-only:` exige `forbid_agents`).
3. Tipo que deixa de ser sugestão → `DEFAULT_SUGGEST_KINDS` em `services/cases.py` e
   `casePresets.ts`; por caso, o ⚙.
4. Rode `test_agent_registry.py`, `test_mcp_server.py`, `test_agent_route_scoping.py`;
   atualize este arquivo, `docs/guide/agents-mcp.md` e o decision log.
