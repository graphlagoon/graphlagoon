# Databricks Integration

This guide covers how to integrate Graph Lagoon Studio with Databricks SQL Warehouse, including database setup, automatic migrations, and authentication.

## Prerequisites

- A Databricks workspace with a SQL Warehouse
- Access token (personal access token or OAuth)
- PostgreSQL database (recommended for persistence)

## Minimal Setup

```python
from fastapi import FastAPI
from graphlagoon import create_mountable_app, Settings

app = FastAPI()

settings = Settings(
    databricks_mode=True,
    databricks_host="adb-xxx.azuredatabricks.net",
    databricks_token="dapi-xxx",
    databricks_warehouse_id="your-warehouse-id",
    databricks_catalog="main",
    database_enabled=True,
    database_url="postgresql+asyncpg://user:pass@localhost:5432/graphlagoon",
)

app.mount("/graphlagoon", create_mountable_app(
    settings=settings,
    mount_prefix="/graphlagoon",
))
```

## Environment Variables

You can also configure via environment variables instead of `Settings`:

```bash
GRAPH_LAGOON_DATABRICKS_MODE=true
GRAPH_LAGOON_DATABRICKS_HOST=adb-xxx.azuredatabricks.net
GRAPH_LAGOON_DATABRICKS_TOKEN=dapi-xxx
GRAPH_LAGOON_DATABRICKS_WAREHOUSE_ID=your-warehouse-id
GRAPH_LAGOON_DATABRICKS_CATALOG=main

# PostgreSQL persistence
GRAPH_LAGOON_DATABASE_ENABLED=true
GRAPH_LAGOON_DATABASE_URL=postgresql+asyncpg://user:pass@localhost:5432/graphlagoon
```

## Database & Automatic Migrations

When `database_enabled=true`, Graph Lagoon Studio uses PostgreSQL to persist graph contexts, explorations, and query templates.

### Automatic schema management

Graph Lagoon runs database migrations **automatically on startup** — you don't need to run any manual migration commands. The behavior depends on how you installed it:

| Installation | Migration strategy |
|---|---|
| **From source** (dev) | Alembic migrations run automatically (`alembic upgrade head`) |
| **pip package** (wheel) | Falls back to `Base.metadata.create_all` (creates missing tables) |

This means:
- **First deploy**: all tables are created automatically
- **Upgrades**: new columns and tables are added automatically on the next startup
- **No manual steps**: you never need to run `alembic upgrade` yourself in production

### How it works

On startup, Graph Lagoon checks if `alembic.ini` exists (present in source installs, absent in wheel installs):

```python
# Simplified — actual code in graphlagoon/db/database.py
async def create_tables():
    if alembic_ini.exists():
        # Dev/source: run full Alembic migrations
        command.upgrade(cfg, "head")
    else:
        # Wheel: create tables from SQLAlchemy models
        Base.metadata.create_all()
```

### Schema evolution

New features may add columns or tables. For example, query template options (`procedural_bfs`, `cte_prefilter`, `large_results_mode`) are stored as a JSON `options` field — this approach avoids schema changes when new options are added in the future.

### Without a database

If you don't need persistence (e.g., for demos or quick exploration), set `database_enabled=false`. Graph Lagoon will use an in-memory store that resets on restart.

## Authentication

### Static Token

The simplest approach — pass a Databricks personal access token:

```python
settings = Settings(
    databricks_mode=True,
    databricks_host="adb-xxx.azuredatabricks.net",
    databricks_token="dapi-xxx",
    databricks_warehouse_id="your-warehouse-id",
)
```

### Dynamic Token (OAuth / Token Refresh)

For production scenarios where tokens expire, use a `header_provider` — a sync or
async callable returning a fresh token string. It is called before each warehouse
request, and the returned token is automatically wrapped in an
`Authorization: Bearer` header.

#### Built-in Databricks OAuth provider

If you deploy as a Databricks App (or run anywhere the standard
`DATABRICKS_HOST` / `DATABRICKS_CLIENT_ID` / `DATABRICKS_CLIENT_SECRET`
environment variables are set), use the built-in `get_oauth_service()` — it
performs the OAuth M2M `client_credentials` exchange and caches/refreshes the
token for you:

```python
from graphlagoon import Settings, create_mountable_app, get_oauth_service

settings = Settings(
    databricks_mode=True,
    databricks_host="adb-xxx.azuredatabricks.net",
    databricks_warehouse_id="your-warehouse-id",
    # No databricks_token needed
)

app.mount("/graphlagoon", create_mountable_app(
    settings=settings,
    header_provider=get_oauth_service().get_token,
))
```

This is the recommended setup for Databricks Apps — see
[Deploy as a Databricks App](/guide/databricks-apps).

#### Custom provider

For other auth flows (Azure AD, a custom token service, etc.), pass your own
callable:

```python
from graphlagoon import Settings, create_mountable_app

class TokenService:
    async def get_token(self) -> str:
        # Your logic: OAuth refresh, Azure AD, etc.
        return "fresh-token"

token_service = TokenService()

settings = Settings(
    databricks_mode=True,
    databricks_host="adb-xxx.azuredatabricks.net",
    databricks_warehouse_id="your-warehouse-id",
)

app.mount("/graphlagoon", create_mountable_app(
    settings=settings,
    header_provider=token_service.get_token,
))
```

## Integration Modes

### Sub-Application (Recommended)

Mount as a complete sub-application (API + Frontend):

```python
from fastapi import FastAPI
from graphlagoon import create_mountable_app

app = FastAPI(title="My Application")

@app.get("/")
async def root():
    return {"message": "My API"}

sgraph_app = create_mountable_app(mount_prefix="/graphlagoon")
app.mount("/graphlagoon", sgraph_app)

# Access at: http://localhost:8000/graphlagoon/
```

### API Only

Include only the API routes (no frontend):

```python
from fastapi import FastAPI
from graphlagoon import create_api_router

app = FastAPI()
api_router = create_api_router()
app.include_router(api_router, prefix="/graph-api")
```

### Custom

Configure each component individually:

```python
from graphlagoon import create_api_router, create_frontend_router, Settings

app = FastAPI()

settings = Settings(
    database_enabled=True,
    database_url="postgresql+asyncpg://user:pass@localhost/mydb",
    databricks_mode=True,
    databricks_host="adb-xxx.azuredatabricks.net",
    databricks_token="dapi-xxx",
    databricks_warehouse_id="your-warehouse-id",
)

api_router = create_api_router(settings)
app.include_router(api_router, prefix="/my-graph/api")

frontend_router = create_frontend_router(
    settings,
    static_prefix="/my-graph/static",
    router_base="/my-graph/",
    api_prefix="/my-graph/api",
)
app.include_router(frontend_router, prefix="/my-graph")
```

## Troubleshooting

### Connection errors to Databricks

Verify your credentials:

```bash
curl -H "Authorization: Bearer dapi-xxx" \
  https://adb-xxx.azuredatabricks.net/api/2.0/sql/warehouses/
```

### Frontend not loading

Check if static assets are included in the wheel:

```python
import graphlagoon
from pathlib import Path

pkg_dir = Path(graphlagoon.__file__).parent
static_dir = pkg_dir / "static"
print(f"Static dir exists: {static_dir.exists()}")
```

### Database not connecting

```bash
psql -h localhost -U user -d graphlagoon -c "SELECT 1"
```

Or disable persistence:

```python
settings = Settings(database_enabled=False)
```
