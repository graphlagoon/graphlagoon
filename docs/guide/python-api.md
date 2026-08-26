# Python API Reference

::: tip TL;DR
The reference for **embedding** Graph Lagoon in your own FastAPI or
Databricks app: entry points, auth hooks, and the three extension
registries.

- **Use it when** you're mounting the studio inside an existing app,
  plugging in your auth, or registering similarity / REST / precomputed
  providers.
- **You don't need it** to just run the studio — `graphlagoon serve` and
  environment variables ([Configuration](./configuration.md)) cover the
  standalone case entirely.
:::

Everything the `graphlagoon` package exports for embedding the studio in
your own FastAPI application. This page is the map: signatures, the
contracts that aren't obvious from them, and links into the deep guides
that cover each subsystem. If you only read one section, read the
[mounting checklist](#the-mounting-checklist) — it covers the four things
every embedder gets wrong.

```python
from graphlagoon import (
    create_app, create_mountable_app, create_api_router,
    create_frontend_router, add_mount_redirect,
    configure_auth, get_oauth_service,
    register_similarity_endpoint, register_rest_connection,
    register_precomputed_graph_provider, volume_provider,
    Settings, get_settings,
)
```

## Entry points

### `create_mountable_app(...)` — embed in your app

```python
def create_mountable_app(
    settings: Settings | None = None,
    include_frontend: bool = True,
    mount_prefix: str = "/",
    header_provider: HeaderProvider | None = None,
    user_provider: UserProvider | None = None,
    databricks_catalog: str | None = None,
    databricks_schema: str | None = None,
    catalog_schemas: list[tuple[str, str]] | None = None,
    similarity_endpoints: list | None = None,
    rest_connections: list | None = None,
    precomputed_graph_providers: list | None = None,
) -> FastAPI
```

Builds a complete sub-application (API + SPA + static assets + `/health`)
meant for `parent.mount(prefix, ...)`. The full walkthrough lives in
[Databricks Integration → Minimal Setup](/guide/integration#minimal-setup).

### `create_app(...)` — standalone

Same options minus `mount_prefix`/`user_provider`, plus `cors_origins`.
The differences that matter:

| | `create_app` | `create_mountable_app` |
|---|---|---|
| Mount path | fixed `/graphlagoon` (`/` redirects) | your `mount_prefix` |
| CORS middleware | yes (`cors_origins` or `*`) | no — the parent decides |
| Auth middleware | **installed** | **not installed** (see below) |
| Identity hook | `configure_auth()` directly | `user_provider=` argument |

### Routers à la carte

`create_api_router(settings)` returns just the `/api/...` routers;
`create_frontend_router(...)` serves the SPA with config injection.
Combining them yourself means the `configure_*` wiring
`create_mountable_app` does is on you — see
[Integration → API-only](/guide/integration#api-only). The frontend router
registers a catch-all route: include it **last**.

## The mounting checklist

Four requirements, each with a silent failure mode:

**1. Delegate the lifespan** (mandatory with `database_enabled` or
`lakebase_enabled`). Starlette never runs a mounted app's lifespan, and
that's where migrations run and the Lakebase token refresh lives. Skipping
it produces `column ... does not exist` at first request.

```python
graphlagoon_app = create_mountable_app(settings=settings, mount_prefix="/graphlagoon")

@asynccontextmanager
async def lifespan(app: FastAPI):
    async with graphlagoon_app.router.lifespan_context(graphlagoon_app):
        yield

app = FastAPI(lifespan=lifespan)
```

**2. Match `mount_prefix` to the actual mount path.** It drives the SPA's
router base and API prefix; a mismatch renders a blank page.

**3. Add the redirect before mounting.**
`add_mount_redirect(app, "/graphlagoon")` makes the no-trailing-slash URL
work. It must be called **before** `app.mount(...)`.

**4. Install auth on the host.** `create_mountable_app` does **not**
install `AuthMiddleware` — see the next section, because this is the one
that fails silently.

## Authentication: `configure_auth` and `UserProvider`

```python
UserProvider = Callable[[Request], str | Awaitable[str]]

def configure_auth(user_provider: UserProvider | None = None) -> None
```

A `UserProvider` maps an incoming request to the user's email — the
identity that owns contexts and explorations, matches
[superusers](/guide/configuration#superusers), and receives shares. Plug
your existing auth in:

```python
# Your middleware already authenticated the request:
configure_auth(lambda request: request.state.current_user.email)

# Or async:
async def provider(request):
    return (await get_user_from_token(request.headers["authorization"])).email
configure_auth(provider)
```

Resolution order at request time: your provider → the `x-forwarded-email`
header (what Databricks Apps inject) → in `dev_mode`, the fallback
`dev@graphlagoon.local` → otherwise the request is rejected.

::: warning The provider only runs inside `AuthMiddleware`
`create_mountable_app(user_provider=...)` alone does nothing — the
middleware that calls the provider is only installed by `create_app`. When
mounting, add it on the **host** so it covers the mounted routes:

```python
from graphlagoon.middleware.auth import AuthMiddleware  # not in __all__

app = FastAPI(lifespan=lifespan)
app.add_middleware(AuthMiddleware)
```

Alternatively, skip Graph Lagoon's middleware entirely and have your own
middleware set `request.state.user_email` — Starlette propagates request
state into mounted apps, and every handler reads it.
:::

Two more behaviors worth knowing:

- **A provider that raises is silently skipped** and resolution falls
  through to headers / dev default. A broken provider therefore looks like
  "everyone is `dev@graphlagoon.local`", not like an error — log inside
  your provider.
- **`dev_mode` defaults to `true`.** A deployment that forgets
  `GRAPH_LAGOON_DEV_MODE=false` authenticates every anonymous request as
  the dev user. Set it explicitly in production.

The provider is a process-wide global: one per interpreter, cleared with
`configure_auth(None)`.

## Warehouse auth: `HeaderProvider` and Databricks OAuth

```python
HeaderProvider = Callable[[], str | Awaitable[str]]
```

A zero-argument callable returning a **bearer token string** (not a header
dict); the framework wraps it as `Authorization: Bearer <token>` on every
warehouse call. It takes precedence over `settings.databricks_token`, and
is the way to do token refresh:

```python
from graphlagoon import create_mountable_app, get_oauth_service

app = create_mountable_app(
    header_provider=get_oauth_service().get_token,  # cached, auto-refreshing
    ...,
)
```

`get_oauth_service()` returns a cached `DatabricksOAuthService` configured
from the `DATABRICKS_HOST` / `DATABRICKS_CLIENT_ID` /
`DATABRICKS_CLIENT_SECRET` environment variables that a Databricks App
injects — the zero-token setup described in
[Databricks Apps → Authentication](/guide/databricks-apps). You can also
construct `DatabricksOAuthService(workspace_url, client_id, client_secret)`
yourself. Tokens are cached with a five-minute expiry margin;
`refresh_token()` forces a re-exchange.

## Extension registries

Three registries let the parent app plug custom capabilities in. Each has
a dedicated guide; the signatures and registration gotchas are summarized
here.

### Similarity endpoints

```python
register_similarity_endpoint(SimilarityEndpointSpec(
    name="embedding-knn",
    description="Nearest neighbours by embedding",
    endpoint="/my/similarity/knn",   # absolute path on YOUR app
    params=[SimilarityEndpointParam(name="k", type="int", default=10)],
))
```

Graph Lagoon only advertises the endpoint; your app implements it and the
browser calls it directly. Contract and parameter types:
[Similarity System](/guide/similarity#registering-endpoints). Registering
the same name twice silently overwrites — the one registry that does.

### REST connections

```python
register_rest_connection(RestConnectionSpec(
    name="fraud-api",
    ui=RestConnectionUI(label="Fraud Graph Service"),
    base_url="https://fraud.internal",
    response_mapper=my_mapper,
))
```

Validated eagerly at registration (name pattern, URL, callables); a
different spec under an existing name raises. Capabilities (expand,
subgraph, node fetch, discovery) come from which builders you declare —
there is no override flag. Secrets never reach the browser: only the UI
payload is exposed. Full contract:
[REST Connections](/guide/rest-connections#registering-connections).

### Precomputed graph providers

```python
register_precomputed_graph_provider(PrecomputedGraphProvider(
    name="volume-bfs",
    resolve=my_async_resolver,          # must be async def
    params=[ParamSpec(name="depth", type="int", min=1, max=4, default=2)],
))
```

Providers form a chain consulted in order; `resolve` returning `None`
declines to the next one. `resolve` must be `async def` (checked at
registration), `delete` requires `save`, and the param names `precomputed`,
`style`, `exploration` and the `layout*` prefix are reserved. The built-in
`volume_provider(writable=False)` is the right shape for a store fed by a
batch job. Chain semantics, guarantees, and six worked examples:
[Precomputed Graphs](/guide/precomputed-graphs#writing-a-provider).

::: tip Registries are process-wide
Similarity, REST, and precomputed registrations — like the auth provider —
live in module globals shared by every app instance in the process. The
precomputed chain is the exception: `create_mountable_app` resets it on
every call, so passing `precomputed_graph_providers=None` keeps the
default `volume_provider()` while `[]` disables precomputed graphs.
:::

## `Settings` and `get_settings`

`Settings` is a Pydantic settings class reading `GRAPH_LAGOON_*`
environment variables (and `.env`); every field can also be set in code:

```python
from graphlagoon import Settings, create_mountable_app

settings = Settings(
    databricks_mode=True,
    databricks_host="adb-123.azuredatabricks.net",
    databricks_warehouse_id="abc123",
    database_enabled=True,
)
app = create_mountable_app(settings=settings, ...)
```

The full variable-by-variable reference is
[Configuration](/guide/configuration). Behaviors to know:

- `lakebase_enabled=True` forces `database_enabled=True` and requires
  `lakebase_instance_name` — enforced at construction.
- Some Databricks fields are validated **lazily**: a missing
  `databricks_warehouse_id` surfaces at the first query, not at startup.
- A missing `databricks_token` is fine when a `header_provider` is
  supplied.
- `get_settings()` is cached (`lru_cache`); tests that mutate env vars
  must call `get_settings.cache_clear()`.
- Passing `databricks_catalog`/`databricks_schema`/`catalog_schemas` to an
  app factory rebuilds the `Settings` object — the instance you passed is
  not the one used afterwards.

## Data models

The vocabulary used by precomputed providers and anything constructing
graphs in Python:

```python
class Node:  node_id: str; node_type: str; properties: dict | None
class Edge:  edge_id: str; src: str; dst: str; relationship_type: str
             properties: dict | None

class PrecomputedGraphData:   nodes: list[Node]; edges: list[Edge]
                              truncated: bool = False
class PrecomputedGraphSource: kind: "cypher"|"sql"|"subgraph"|"manual"
                              query: str | None
class PrecomputedGraphPayload: ...   # envelope: name, context_id, counts,
                                     # source, created_by, graph
```

Two rules save real debugging time:

- These are the **internal** field names. The REST-connection wire format
  is different by design (`id`/`label`, `source`/`target`) — your
  `response_mapper` translates between them; see
  [REST Connections → Response Contract](/guide/rest-connections#the-response-contract).
- Never hand-assemble a `PrecomputedGraphPayload`. Use
  `PrecomputedGraphResult.from_graph(...)`, which derives the counts,
  version, and completeness flags; `from_raw(...)` accepts bytes that are
  already `gzip(json(payload))` and streams them through untouched.

## Importable from submodules

Useful symbols that are intentionally not in the top-level `__all__`:

| Symbol | Module | Why you'd need it |
|---|---|---|
| `AuthMiddleware` | `graphlagoon.middleware.auth` | Host-level auth when mounting |
| `get_current_user` | `graphlagoon.middleware.auth` | Your own routes sharing Graph Lagoon identity |
| `clear_registry` / `clear_rest_registry` / `clear_precomputed_graph_registry` | respective registry modules | Test isolation |
| `is_superuser` | `graphlagoon.utils.authz` | Reusing the superuser check |
