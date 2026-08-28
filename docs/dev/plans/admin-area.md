# Plano — Área de Superusuário (Admin) no Graph Lagoon Studio

> Status: **implementado** em 2026-08-28 (ver decision_log). Mantido como registro do desenho aprovado.

## Context

O app já tem o **conceito** de superusuário (`GRAPH_LAGOON_SUPERUSER_EMAILS` → `is_superuser()` em [authz.py](api/graphlagoon/utils/authz.py); flag `is_superuser` injetada em `window.__GRAPH_LAGOON_CONFIG__`; `usePersistence().isSuperuser` no frontend), mas **não tem lugar** para administrar o ambiente. Hoje o superusuário só ganha botões extras espalhados (Share/Delete em itens alheios, publicar precomputed graph). Não existe:

- visão do ambiente (modo, persistência, versão, migração, datasources, flags, saúde do warehouse/DB);
- inventário de usuários e de quem é dono de quê;
- ação de transferir posse (usuário saiu da empresa → contexts órfãos);
- trilha de auditoria (a tabela `usage_logs` existe desde a migração 001 e **nunca é escrita**);
- gate de superusuário no único endpoint destrutivo (`DELETE /api/dev/clear-all` só checa `dev_mode` — achado **A1** do [security-assessment.md](docs/dev/security-assessment.md)).

Objetivo: uma rota `/admin` no SPA, visível só para superusuários, servida por um router `/api/admin/*` onde **é impossível registrar uma rota sem o gate de superusuário**, com auditoria de toda mutação administrativa, e com **testes que forçam a atualização da área** quando o ambiente ganha uma nova entidade, setting ou ação privilegiada (a parte "quando atualizar" do pedido é resolvida por CI, não só por documento).

Premissas (do modelo de ameaça do security-assessment): identidade vem do proxy (`X-Forwarded-Email`); em `dev_mode` o e-mail é escolhido pelo cliente, então a área admin em dev é "trust-everyone" por construção — a UI mostra um banner avisando isso.

---

## Decisões de design

| # | Decisão | Por quê |
|---|---|---|
| 1 | **Gate no nível do `APIRouter`** (`APIRouter(prefix="/api/admin", dependencies=[Depends(require_superuser)])`) + teste que itera `admin.router.routes` e exige 403 para não-superusuário em cada uma | Um handler novo não consegue "esquecer" o gate; o teste pega regressão se alguém trocar o router. |
| 2 | **Reusar listagens existentes** (`GET /api/graph-contexts`, `GET /api/explorations`, presets, precomputed) — elas já têm branch de superusuário que devolve tudo | Menos superfície nova; a admin só adiciona **mutações** que não existem (transferir posse, limpar ambiente). |
| 3 | **Config efetiva por allowlist classificada**, não blocklist | Cada campo de `Settings` precisa ser classificado `public` / `secret` / `hidden`; teste falha se um campo novo não estiver classificado → é o mecanismo "quando atualizar" para env vars. Segredos aparecem só como `set` / `not set`. |
| 4 | **Auditoria via `usage_logs`** (já existe) + lista em memória no `InMemoryStore` para `make dev` | Sem migração de schema para auditoria; mesma dupla DB/memória do resto do app. |
| 5 | `DELETE /api/dev/clear-all` passa a exigir `dev_mode` **e** superusuário; `.env.example` passa a listar `dev@graphlagoon.local` como superuser | Fecha A1 sem quebrar `make dev` (a identidade default de dev vira superuser local) e resolve B8 (e-mail pessoal no example). |
| 6 | Lista de superusuários **é** exposta — mas só dentro de `/api/admin/*` | Admin precisa saber quem mais é admin; o decision-log de 2026-07-13 só vetava expor ao cliente comum, o que continua valendo. |
| 7 | Guard de rota no frontend é **UX**, nunca segurança | O backend rejeita; o guard só evita tela vazia. |
| 8 | Sem tabela de roles | Coerente com a decisão 2026-07-13 (identidade por header, sem FK para user). Adicionar superuser continua sendo env + restart; a UI diz isso. |
| 9 | **Gerador de dados dev em escala (`--users/--contexts/--explorations`, determinístico por `--seed`), por HTTP, ligado por default no `make dev`/`make dev-db`** | Um só código para memória e Postgres; passa por auth, shares e auditoria de verdade; dezenas de usuários e centenas de recursos deixam o sistema (e a área admin) explorável de verdade, incluindo paginação/filtros; `SEED_DATA=0` desliga. |

---

## Fase 1 — Backend

### 1.1 Gate reutilizável
[api/graphlagoon/utils/authz.py](api/graphlagoon/utils/authz.py): adicionar
```python
def require_superuser(request: Request) -> str:
    """FastAPI dependency: returns the email or raises 403 FORBIDDEN (same error envelope as precomputed_graphs._require_superuser)."""
```
- Resolve a identidade via `get_current_user(request)` (não via `request.state`): `create_mountable_app` ([app.py:403-611](api/graphlagoon/app.py#L403-L611)) **não instala** `AuthMiddleware` (o `main.py` standalone instala; um host que embute o app depende do próprio middleware), e os testes montam routers sem middleware.
- **Pré-requisito de segurança (bug pré-existente que a área admin transformaria em escalada de privilégio):** `get_current_user` ([auth.py:154-185](api/graphlagoon/middleware/auth.py#L154-L185)) **ignora o `user_provider`** configurado por `configure_auth` e cai direto no header `X-Forwarded-Email`. Num host embutido com provider próprio e sem `AuthMiddleware`, um cliente forjaria o header e passaria por superuser. Corrigir: `get_current_user` consulta `get_user_provider()` antes do header (provider síncrono; se o host registrou provider **async**, `get_current_user` levanta 500 explícito pedindo `AuthMiddleware` — ou tornar `require_superuser` async e aguardar o provider). Teste: provider configurado + header forjado → identidade vem do provider.
- Refatorar `_require_superuser` em [precomputed_graphs.py:84](api/graphlagoon/routers/precomputed_graphs.py#L84) para delegar a ele (um só lugar).
- Teste garante que `AuthMiddleware.PUBLIC_PATHS/PUBLIC_PREFIXES` nunca cobrem `/api/admin`.

### 1.1b Registro de usuários (DB **e** memória, e fora do middleware)
Hoje `AuthMiddleware` só chama `ensure_user_exists` quando há DB ([auth.py:129-134](api/graphlagoon/middleware/auth.py#L129-L134)); `InMemoryStore.ensure_user` nunca é chamado; e em modo embutido o middleware pode nem rodar. Extrair `services/users.py: async def touch_user(email)` (cria se não existe; atualiza `last_seen_at` se `null` ou > 15 min; DB → `User`, memória → `InMemoryStore.ensure_user`), chamado pelo middleware **e** por `require_superuser`/handlers admin. Nota: `InMemoryStore.users` é chaveado pelo e-mail cru — o badge superuser na aba Users usa `is_superuser(email)` (case-insensitive), nunca comparação de string.

### 1.1c Payload de config construído uma vez
Extrair `build_public_config(user_email) -> dict` (novo `services/public_config.py`) usado por [routers/config.py:33-57](api/graphlagoon/routers/config.py#L33-L57) e [app.py:259-280](api/graphlagoon/app.py#L259-L280) (hoje duplicados; `version` até diverge: `importlib.metadata` vs `__version__`). O overview do admin reusa o mesmo helper para o card de flags/datasources → **uma flag nova aparece no admin automaticamente**, sem teste de sincronia.

### 1.2 Auditoria — novo `api/graphlagoon/services/audit.py`
- `async def record(user_email, action, resource_type=None, resource_id=None, metadata=None)` → grava `UsageLog` quando `is_database_available()`, senão `InMemoryStore.usage_logs` (deque bounded, ex. 10 000; adicionar ao [memory_store.py](api/graphlagoon/db/memory_store.py) + limpar em `clear_all`).
- `async def list_entries(page, page_size, user_email=None, action=None)` paginado, mais recente primeiro.
- Constantes de ação (`AuditAction` enum/str literal): `context.delete`, `context.share`, `context.unshare`, `context.transfer`, `exploration.delete/share/unshare/transfer`, `precomputed.publish`, `precomputed.delete`, `preset.delete`, `admin.clear_all`.
- `UsageLog.resource_id` é UUID ([models.py:175](api/graphlagoon/db/models.py#L175)): precomputed graphs e presets são chaveados por nome → identificador vai em `log_metadata` (`{"name": …, "context_id": …}`), `resource_id` = context. `metadata` limitado (ex. 4 KB, truncar) para não virar vetor de inchaço.
- Pontos de chamada: os handlers correspondentes em `routers/graph_contexts.py`, `explorations.py`, `precomputed_graphs.py`, `style_presets.py`, `graph.py` (clear-all). Nunca falhar a request por erro de auditoria (log + segue).
- Migração `014_usage_logs_index.py`: índices em `usage_logs(created_at DESC)`, `(user_email)`, `(action)`.

### 1.3 Novo router `api/graphlagoon/routers/admin.py` (prefix `/api/admin`, `dependencies=[Depends(require_superuser)]`)

| Rota | Retorna / faz |
|---|---|
| `GET /overview` | `version` (`graphlagoon.__version__`), `dev_mode`, `databricks_mode`, backend de persistência (`memory` / `postgres` / `lakebase`), `alembic_version` atual (select na tabela; `null` em memória; `"unmanaged"` se a tabela não existe — o fallback `create_all` de [database.py:136-167](api/graphlagoon/db/database.py#L136-L167) não a cria; conferir que `alembic/versions/` está no wheel, hoje o `force-include` só lista `alembic.ini` e `script.py.mako`), contagens (users, contexts, explorations, templates — presets/precomputed **não** são enumeráveis entre contexts por design, ficam de fora), `superusers` (lista), `public_config` (= `build_public_config`), **storage**: caminho/volume efetivo de presets, precomputed e snapshots (os avisos de `_prepare_*_storage` em [app.py:395-401](api/graphlagoon/app.py#L395-L401) são a configuração errada mais comum), `health.database` = `{status, latency_ms}` via `SELECT 1` |
| `POST /health/warehouse` | probe **sob demanda** (botão na UI), não dentro do overview: não existe `ping` no `WarehouseClient` e o `http_timeout` default é 300 s; usar `httpx` próprio com timeout 3 s contra o endpoint mais barato do backend ativo; acordar um SQL warehouse parado custa minutos/dinheiro, por isso nunca automático |
| `GET /config` | lista `[{key, value, kind}]` a partir de `CONFIG_FIELD_KINDS` (allowlist; ver 1.4). `secret` → `value: "set"/"not set"`; `hidden` → omitido. URLs que podem embutir credenciais (`database_url`, `sql_warehouse_url`, `lakebase_*`, `neptune_endpoint`…) são `secret`, não só `databricks_token` |
| `GET /users?q=&page=&page_size=` | `email, display_name, created_at, last_seen_at, is_superuser, contexts_owned, explorations_owned` (DB: `User` + counts; memória: `InMemoryStore.users`) |
| `POST /contexts/{id}/transfer` body `{new_owner_email}` | troca `owner_email`; remove share redundante do novo dono; `touch_user(new_owner)`; audita. 404 se não existe; 422 via **novo** `validate_owner_email` em `utils/sharing.py` (rejeita `is_public_share`/`is_domain_wildcard` — `validate_share_email` aceita `*` e `*@domain`, não serve) |
| `POST /explorations/{id}/transfer` | idem |
| `GET /audit?page=&page_size=&user=&action=` | `services.audit.list_entries` |
| `POST /environment/clear` | (POST, não DELETE com body — proxies descartam body de DELETE) move a lógica de `clear_all_data` ([graph.py:822-864](api/graphlagoon/routers/graph.py#L822-L864)) para `services/environment.py`; exige `dev_mode` **além** do gate; body `{confirm: "CLEAR ALL"}`; `usage_logs` **sai** da lista de truncate e a entrada `admin.clear_all` é gravada **depois** (senão o próprio clear apaga o registro). `DELETE /api/dev/clear-all` vira alias do mesmo service (mantém `DevGeneratorView`), agora também com `require_superuser`. |

- `last_seen_at`: migração `014` adiciona `users.last_seen_at` (nullable); atualizado por `touch_user` (1.1b) só se `null` ou > 15 min (evita write por request; o SELECT por request já existe em [auth.py:138](api/graphlagoon/middleware/auth.py#L138)). Memória: campo em `MemoryUser`.
- Registrar em `create_api_router` ([app.py:210-218](api/graphlagoon/app.py#L210-L218)).
- Schemas Pydantic em `models/schemas.py` (`AdminOverview`, `AdminConfigEntry`, `AdminUser`, `TransferOwnershipRequest`, `AuditEntry`, `ClearEnvironmentRequest`).

### 1.4 Mecanismo "quando atualizar" (forcing functions) — `api/graphlagoon/routers/admin_registry.py`
```python
CONFIG_FIELD_KINDS: dict[str, Literal["public","secret","hidden"]] = {
    "dev_mode": "public", "databricks_token": "secret", "database_url": "secret", ...
}
CLEARABLE_TABLES: tuple[str, ...] = ("exploration_shares","explorations","graph_context_shares","query_templates","graph_contexts","users")
PRESERVED_TABLES: set[str] = {"usage_logs", "alembic_version"}   # com justificativa em comentário
AUDITED_ROUTES: set[tuple[str,str]] = {("DELETE","/api/graph-contexts/{context_id}"), ...}
AUDIT_EXEMPT_ROUTES: dict[tuple[str,str], str] = {("POST","/api/graph-contexts"): "create is owner-scoped, low blast radius", ...}
```
O service de clear-all **consome** `CLEARABLE_TABLES` (não uma lista própria), para que o teste registry-vs-metadata não seja tautológico. Testes em `api/tests/test_admin_registry.py`:
- todo campo de `Settings.model_fields` está em `CONFIG_FIELD_KINDS` (mensagem: "classifique o novo setting e, se público, ele aparece na aba Config do admin");
- toda tabela em `Base.metadata.tables` está em `CLEARABLE_TABLES ∪ PRESERVED_TABLES` (mensagem: "nova entidade persistida → adicionar contagem no overview, ao clear-all e ao inventário");
- memória: após `InMemoryStore.clear_all()`, **toda** coleção em `vars(store)` está vazia (pega uma coleção nova que alguém esqueceu de limpar);
- **rotas auditadas por registro, não por grep de fonte** (o `is_superuser` aparece em branches de leitura e dentro de `can_manage`, um `inspect.getsource` daria falso positivo/negativo): iterar `app.routes`, e toda rota **não-GET** sob `/api` precisa estar em `AUDITED_ROUTES` ou em `AUDIT_EXEMPT_ROUTES` com motivo. Rotas sob `/api/admin` são auditadas por construção (exceto GETs). Complemento comportamental em `test_audit.py`: para cada rota em `AUDITED_ROUTES`, exercitar o handler em memória e assertar que a entrada aparece no deque.

### 1.5 Seed de ambiente dev (grafos + usuários fake por default)

Hoje `POST /api/dev/random-graph` ([graph.py:792](api/graphlagoon/routers/graph.py#L792), NetworkX: `barabasi_albert`/`watts_strogatz`/…, `RandomGraphRequest` em [schemas.py:895](api/graphlagoon/models/schemas.py#L895)) gera só tabelas no warehouse; usuários, contexts, shares, explorations e auditoria precisam ser criados à mão. Para testar a área admin com dados realistas:

- **Novo módulo `api/graphlagoon/dev/seed.py`** — gerador **em escala e parametrizável**:
  ```
  uv run python -m graphlagoon.dev.seed --api http://localhost:8000 \
      --users 30 --contexts 60 --explorations 200 --graphs 5 --seed 42 [--reset] [--no-graphs]
  ```
  Roda **via HTTP** contra a stack já de pé, com `X-Forwarded-Email` do usuário "autor" de cada recurso — funciona igual em memória e Postgres, passa pelo `touch_user` (usuários aparecem), pelos gates de share e pela auditoria. Recusa rodar se `GET /api/config.dev_mode` for `false`. `--seed` torna a geração **determinística** (mesmos e-mails/títulos a cada run — útil para screenshots e para o e2e).
- **Usuários (`--users N`):** nomes gerados de listas internas (sem dependência nova; `random.Random(seed)`), e-mails `<first>.<last>@example.com`, distribuídos em 3 perfis para o admin ter o que enxergar: ~20 % *power users* (muitos contexts/explorations, compartilham muito), ~60 % *normais*, ~20 % *inativos* (só login → candidatos a "órfão"/transfer). Sempre inclui `dev@graphlagoon.local` (superuser local).
- **Grafos (`--graphs G`, via `/api/dev/random-graph`):** G tabelas em `dev_catalog.graphs.seed_<i>_{nodes,edges}` alternando modelos (`barabasi_albert`, `watts_strogatz`, `erdos_renyi`…), tamanhos 50 → 5 000 nós, tipos de nó/aresta variados, `extra_node_columns` (city, score, created_at) para labels/filters/metrics terem propriedades reais.
- **Contexts (`--contexts C`):** cada um aponta para um dos G grafos, dono sorteado por perfil, título/descrição/tags gerados (tags de um vocabulário fixo: `fraud`, `supply`, `social`, `qsa`, `demo`…), `default_behaviors` variados; ~30 % com share (`*` público / `*@example.com` / usuário específico em `read` ou `write` — exige `GRAPH_LAGOON_ALLOWED_SHARE_DOMAINS=example.com`); ~25 % com 1–3 query templates (mistura `shared`/`private`); alguns com `cluster_programs`/`context_menu_actions` de exemplo (reusa os defaults já existentes no frontend/backend).
- **Explorations (`--explorations E`):** distribuídas pelos contexts (poisson-ish, alguns contexts com dezenas), estado salvo real: seleciona um nó do grafo, `expand` 1–2 hops via `/api/graph-contexts/{id}/subgraph|expand`, salva com `viewMode`/layout/preset variados; ~30 % compartilhadas. Timestamps não são forjáveis pela API — a ordem de criação já espalha `created_at`.
- **Atividade para o Audit:** ao final, ~5 % dos recursos são deletados/des-compartilhados pelos donos e o superuser faz 2–3 `transfer` de inativos → Audit nasce com dezenas de entradas variadas.
- **Idempotência & escala:** contexts recebem tag `seed:<hash(params)>`; rerun com os mesmos parâmetros → "already seeded"; parâmetros diferentes acrescentam; `--reset` faz `POST /api/admin/environment/clear` antes. Requests em paralelo limitado (`asyncio.Semaphore(8)`, `httpx.AsyncClient`) com barra de progresso simples; 30/60/200 roda em < 1 min em memória.
- **Makefile:** `make dev-seed` (variáveis `USERS=30 CONTEXTS=60 EXPLORATIONS=200 GRAPHS=5 SEED=42`; espera `/health` 200 com retry), e `dev`/`dev-db`/`dev-gsql2rsql*` chamam-no **por default** ao final com esses defaults (`SEED_DATA=0 make dev` pula; `make dev-seed-big` = 200/500/2 000 para testar paginação/performance das listas; `dev-databricks*`/`dev-neptune*` **não** seedam). Listar em `help` e `.PHONY`. No fim imprime "log in as <power user> / <inactive> / dev@graphlagoon.local (admin)".
- **`.env.example` / `.env` de dev:** `GRAPH_LAGOON_SUPERUSER_EMAILS=dev@graphlagoon.local`, `GRAPH_LAGOON_ALLOWED_SHARE_DOMAINS=example.com`.
- **Teste `api/tests/test_dev_seed.py`:** roda o gerador contra `TestClient` em memória com `--no-graphs` (warehouse mockado; explorations salvas sem expand) e `--users 8 --contexts 12 --explorations 20 --seed 1`: asserta contagens exatas, determinismo (dois runs com o mesmo seed geram os mesmos e-mails/títulos), perfis presentes (≥ 1 inativo sem recursos), shares válidos, ≥ 5 entradas de audit, rerun é no-op, `dev_mode=false` → recusa.
- **E2E/screenshots:** as cenas da área admin usam mocks (padrão do repo), mas o `MOCK_ADMIN_*` é gerado a partir de uma execução `--seed 42` pequena para as screenshots parecerem com o `make dev` real.
- **Docs:** `docs/guide/getting-started.md` ganha "o `make dev` já sobe com dados de exemplo; personas em …"; `docs/dev/admin-area.md` explica como estender o seed quando uma entidade nova nasce (linha extra na tabela "Se você… → atualize…": *nova entidade com dono → adicionar ao seed para a área admin ter o que mostrar*).

---

## Fase 2 — Frontend

### 2.1 Rota e guard — [router/index.ts](frontend/src/router/index.ts)
- `{ path: '/admin', name: 'admin', component: () => import('@/views/AdminView.vue'), meta: { superuserOnly: true } }`
- No `beforeEach` ([L46-57](frontend/src/router/index.ts#L46-L57)): se `to.meta.superuserOnly && window.__GRAPH_LAGOON_CONFIG__?.is_superuser !== true` → `next({ name: 'contexts' })` (depois da checagem de login existente). Ler do config, não do `authStore` (que só tem e-mail).
- Aproveitar para **enforçar `meta.devOnly`** (hoje declarado em `/dev/generator` e ignorado pelo guard — página escondida mas alcançável por URL): mesmo branch, redireciona se `!devMode`.
- **Flag obsoleta após login em dev com build servido pelo backend:** o template calcula `is_superuser` para a navegação HTML (sem header → `dev@graphlagoon.local`); se o usuário loga como outro e-mail, `window.__GRAPH_LAGOON_CONFIG__.is_superuser` fica errado até reload. Após `authStore.login()` (e no `logout`), refazer `GET /api/config` com o header e atualizar `window.__GRAPH_LAGOON_CONFIG__` (mesmo fetch que já existe em [main.ts:11-26](frontend/src/main.ts#L11-L26) — extrair para `services/config.ts: refreshRuntimeConfig()`). Resolve também a limitação conhecida do decision log 2026-07-13.

### 2.2 Navegação — [Toolbar.vue:131-134](frontend/src/components/Toolbar.vue#L131-L134)
`<RouterLink v-if="isSuperuser" to="/admin" data-testid="nav-admin">Admin</RouterLink>` ao lado de DEV.

### 2.3 Tipos, API, store
- `types/admin.ts` — espelha os schemas de 1.3.
- [services/api.ts](frontend/src/services/api.ts) — `getAdminOverview`, `probeWarehouse`, `getAdminConfig`, `getAdminUsers`, `transferContextOwnership`, `transferExplorationOwnership`, `getAuditLog`, `clearEnvironment` (POST). `clearAllData` existente ([api.ts:496-505](frontend/src/services/api.ts#L496-L505)) continua apontando para o alias.
- `stores/admin.ts` — state por aba (overview/config/users/audit), `loading`/`error`, ações; padrão do `contexts` store.

### 2.4 `views/AdminView.vue` (+ componentes em `components/admin/`)
Layout igual a [ContextsView.vue](frontend/src/views/ContextsView.vue): classes globais de `assets/main.css` (`.container`, `.page-header`, `.card`, `.list-item*`, `.badge`, `.modal-overlay/.modal-header/.modal-footer`, `.empty-state`, `.btn-*`), `useToast().error(getErrorMessage(e, …))`, `isOwner/canManage` idiom. Tabelas simples (`<table>`) para Config e Audit; `.list-item` para Users/Contexts/Explorations. **Lógica pura (filtro, agrupamento por owner, formatação de config, predicados) em `src/utils/adminView.ts`** para ser testada de verdade por `AdminView.logic.test.ts` (lição registrada em [ContextsView.logic.test.ts:1-8](frontend/src/views/__tests__/ContextsView.logic.test.ts#L1-L8)). "Danger zone" segue o padrão do [DevGeneratorView.vue:679](frontend/src/views/DevGeneratorView.vue#L679). Abas:
1. **Overview** — cards: versão, modo, persistência + `alembic_version`, contagens, storage (presets/precomputed/snapshots), saúde do DB (latência) + botão **"Probe warehouse"** (sob demanda, com aviso de que pode acordar o warehouse), superusuários, share domains, feature flags, datasources/conexões. Banner amarelo se `dev_mode` ("identidade escolhida pelo cliente — área admin não é uma fronteira de segurança em dev").
2. **Config** — tabela `key / value / kind` com busca; segredos como badge `set`/`not set`.
3. **Users** — tabela com busca, badge superuser, contagens; clique → filtra Contexts/Explorations por owner.
4. **Contexts** e **Explorations** — reusa `api.getGraphContexts()` / `api.getExplorations()` (superuser já vê tudo); colunas owner, datasource, shares, updated; ações: **Transfer** (modal: e-mail + confirmar), **Delete** (reusa DELETE existente), abrir.
5. **Audit** — tabela paginada, filtros user/action.
6. **Danger zone** — só se `dev_mode`: "Clear environment", exige digitar `CLEAR ALL` (padrão do `PrecomputedGraphPanel`).
`data-testid`: `admin-view`, `admin-tab-<name>`, `admin-transfer-btn`, `admin-transfer-confirm`, `admin-clear-env`.
- `DevGeneratorView` continua funcionando (alias mantido).

---

## Fase 3 — Testes

**Backend** (`api/tests/`, padrão de `test_superuser.py`: stub gsql2rsql com try/except, `monkeypatch.setenv` + `get_settings.cache_clear()`, memória):
- `test_admin.py`: (a) parametrizado sobre `admin.router.routes` (introspecção, não probing de URL — um `/api/admin/typo` cai no catch-all do SPA e devolve 200 HTML) → 403 sem superuser com body válido; snapshot da lista de rotas esperadas; (a') `get_current_user` honra `user_provider` sobre header forjado; (b) overview/config/users 200 com shape; (c) config nunca contém o valor de `GRAPH_LAGOON_DATABRICKS_TOKEN` definido no teste; (d) transfer muda owner e gera audit; 404/422; (e) `/environment` 403 sem dev_mode mesmo para superuser, 400 sem `confirm`; (f) `/api/dev/clear-all` 403 para não-superuser (regressão A1); (g) `last_seen_at` populado.
- `test_admin_registry.py`: forcing functions de 1.4.
- `test_audit.py`: `record`/`list_entries` em memória, paginação, filtros, bounded.

**Frontend unit** (`vitest`, Pinia real):
- `router/__tests__/guards.test.ts` (novo): `/admin` redireciona sem flag, passa com flag.
- `stores/__tests__/admin.test.ts`, `views/__tests__/AdminView.logic.test.ts`, `components/__tests__/TransferOwnershipModal.test.ts` (Teleport → `document.body`).
- `usePersistence.test.ts` já cobre `isSuperuser`.

**E2E** (`frontend/e2e/tests/admin.spec.ts`; usar o fixture **já existente** `superuserTest`/`superuserPage` em [test-fixtures.ts:38-56](frontend/e2e/fixtures/test-fixtures.ts#L38-L56); mocks em `helpers/api-mocks.ts` → `seedAdmin(page, {overview, users, audit})` no padrão de `seedContexts`; `MOCK_ADMIN_OVERVIEW`/`MOCK_ADMIN_USERS`/`MOCK_AUDIT` em `fixtures/mock-data.ts`):
- [navigation.spec.ts:51-54](frontend/e2e/tests/navigation.spec.ts#L51-L54): par "link Admin visível para superuser / ausente para `authenticatedPage`"; `/admin` direto redireciona para `/contexts` sem a flag;
- transferir posse (modal → confirmar → toast → tabela atualizada);
- danger zone só com `dev_mode`, botão desabilitado até digitar `CLEAR ALL`.
- `user-journeys.spec.ts`: jornada "admin encontra context de usuário desligado → transfere → novo dono vê em /contexts" (cross-page, vale o journey).

---

## Fase 4 — Docs, governança e "quando atualizar a área admin"

1. **Guia público** `docs/guide/admin.md` (TL;DR: "Use it when…/Not the tool for…"), tabela de abas, tabela de permissões (o que superuser pode/não pode), seção "when something is wrong" (403, dev-mode banner, superuser precisa de restart). Sidebar em [docs/.vitepress/config.ts](docs/.vitepress/config.ts) (grupo Deployment, após Configuration). Cross-links em `configuration.md#superusers` e `databricks-apps.md`. Cena `admin-overview` no `SCENES` de [generate.ts](frontend/e2e/screenshots/generate.ts) com `prepare` que re-roteia `/api/config` com `is_superuser: true` (o `setupPage` compartilhado não seta a flag; modelo: `enableDatasources`) → `make docs-screenshots`. `make docs-build` deve passar.
2. **Política de manutenção** — `docs/dev/admin-area.md`, tabela "Se você… → então atualize…":

   | Mudança no ambiente | Atualizar na área admin | Enforced por |
   |---|---|---|
   | Novo campo em `Settings` / env var | classificar em `CONFIG_FIELD_KINDS` (aparece na aba Config) | `test_admin_registry` |
   | Nova tabela / entidade persistida (DB **e** memory store) | contagem no Overview, `CLEARABLE_TABLES` ou `PRESERVED_TABLES`, limpeza no `InMemoryStore.clear_all`, aba de inventário se tiver dono | `test_admin_registry` |
   | Nova ação gated por `is_superuser` / `can_manage` destrutiva | `audit.record` + nova `AuditAction` + filtro na aba Audit | `test_admin_registry` (ações auditadas) |
   | Novo datasource type / connection / provider | probe de saúde no Overview | revisão (checklist) |
   | Nova feature flag em `/api/config` | nada — `build_public_config` é compartilhado, o Overview mostra automaticamente | por construção (1.1c) |
   | Nova migração Alembic | nada (overview lê `alembic_version`) | — |
   | Novo endpoint mutável em qualquer router (`POST/PUT/DELETE`) | decidir: `AUDITED_ROUTES` (+ `audit.record`) ou `AUDIT_EXEMPT_ROUTES` com motivo | `test_admin_registry` |
   | Novo endpoint sob `/api/admin` | nenhum gate extra — herda do router; o teste 403 parametrizado sobre `admin.router.routes` cobre (enviar body válido: FastAPI valida JSON **antes** das dependencies, senão sai 422 em vez de 403) | `test_admin` |
3. **Skill** [skill_feature_creation/SKILL.md](.claude/skills/skill_feature_creation/SKILL.md): novo **Step 4.2b "Admin-area impact"** com a tabela acima e a frase obrigatória no decision log ("No admin-area impact" ou lista do que foi atualizado) — mesmo padrão do gate de docs públicas.
4. **Decision log** — entrada de planejamento (ao iniciar) e de implementação (ao terminar), e cópia deste plano em `docs/dev/plans/admin-area.md` (pasta criada hoje; linkar no `docs/dev/README.md`).
5. `security-assessment.md`: marcar A1 (parte do gate) e o `usage_logs` inerte como endereçados.

---

## Segurança — checklist que o PR deve provar
- [ ] Toda rota `/api/admin/*` herda `require_superuser` (teste parametrizado).
- [ ] Nenhum segredo sai em `/config` (allowlist + teste com valor sentinela).
- [ ] Toda mutação admin auditada (transfer: antes do commit, na mesma transação; clear-all: **depois**, porque `usage_logs` é preservada e o registro precisa sobreviver); clear-all exige `dev_mode` + superuser + confirmação textual.
- [ ] `get_current_user` honra `configure_auth(user_provider)` — sem isso um host embutido sem `AuthMiddleware` aceitaria header forjado como superuser.
- [ ] Transfer valida e-mail (sem wildcard/público) e não permite transferir para si mesmo silenciosamente sem auditar.
- [ ] Paginação obrigatória em users/audit (`page_size` ≤ 200).
- [ ] Nada no frontend decide permissão — flag só esconde UI.
- [ ] Sem novos sinks de HTML (tudo `{{ }}`).
- [ ] Erros seguem o envelope `{error:{code,message,details}}` existente.

## Fora de escopo (registrar no decision log)
- Editar superusuários pela UI (continua env + restart) — decisão 8.
- Editar settings / datasources / conexões REST em runtime: `get_settings()` é `lru_cache` e as conexões são registradas em `create_app(...)` — exigiria camada de persistência nova. A área admin **mostra**, não edita.
- Inventário cross-context de style presets e precomputed graphs (storage por nome, sem enumeração por design).
- Corrigir IDOR M1 (`GET /graph-contexts/{id}`) e demais achados do assessment — PRs separados.
- Impersonation ("ver como usuário X").

---

## Verificação end-to-end
1. `cd api && uv run pytest tests/test_admin.py tests/test_admin_registry.py tests/test_audit.py tests/test_dev_seed.py tests/test_superuser.py` — verde; suite completa `make test-api`/`pytest` sem regressão.
2. `cd frontend && npx vue-tsc --noEmit && npm run test:run` (ESLint está quebrado no repo — usar vue-tsc como gate).
3. `npm run e2e -- admin.spec.ts user-journeys.spec.ts` e depois suite completa.
4. Manual `make dev` (seed automático 30/60/200): login como `dev@graphlagoon.local` (superuser via `.env`) → link Admin aparece → Overview mostra `memory`, 31 usuários, 60 contexts, 200 explorations, banner dev; Users mostra power users com muitos recursos e inativos com zero; Contexts/Explorations paginam e filtram por owner; Audit tem dezenas de entradas (deletes, shares, transfers). Login como um power user → link some, `/admin` redireciona, `curl -H 'X-Forwarded-Email: <ele>' localhost:8000/api/admin/overview` → 403; em /contexts ele vê os próprios + compartilhados. `make dev-seed` de novo → "already seeded"; `make dev-seed-big` → listas com 500 contexts continuam usáveis; `SEED_DATA=0 make dev` sobe vazio.
5. Manual `make dev-db`: Overview mostra `postgres` + `alembic_version = 014`; seed persiste entre restarts; transferir um context de dave → aparece em Audit; `users.last_seen_at` populado.
6. `make docs-build` e `make docs-screenshots` passam; PNG `admin-overview.png` gerado.
