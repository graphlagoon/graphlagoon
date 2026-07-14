# Configuration

Graph Lagoon Studio is configured via environment variables or programmatically through `Settings`.

## Environment Variables

```bash
# Warehouse connection (local PySpark)
SQL_WAREHOUSE_URL=http://localhost:8001

# Database (optional — for persisting explorations/contexts)
GRAPH_LAGOON_DATABASE_ENABLED=true
GRAPH_LAGOON_DATABASE_URL=postgresql+asyncpg://user:pass@localhost:5432/sgraph

# Databricks mode (replaces local warehouse)
GRAPH_LAGOON_DATABRICKS_MODE=false
GRAPH_LAGOON_DATABRICKS_HOST=adb-xxx.azuredatabricks.net
GRAPH_LAGOON_DATABRICKS_TOKEN=dapi-xxx
GRAPH_LAGOON_DATABRICKS_WAREHOUSE_ID=xxx
GRAPH_LAGOON_DATABRICKS_CATALOG=main

# Development
GRAPH_LAGOON_DEV_MODE=true
GRAPH_LAGOON_SHOW_ERROR_DETAILS=true

# Access control (see "Access Control" below)
GRAPH_LAGOON_SUPERUSER_EMAILS=admin@company.com,ops@company.com
GRAPH_LAGOON_ALLOWED_SHARE_DOMAINS=company.com
```

## Access Control

### Superusers

`GRAPH_LAGOON_SUPERUSER_EMAILS` is a comma-separated list of emails granted
**superuser** access. Matching is case-insensitive and whitespace around each
entry is ignored.

A superuser bypasses ownership and sharing checks everywhere:

- **Graph contexts** — sees all contexts in listings; can edit, delete, share,
  and unshare any context.
- **Explorations** — sees all explorations (including in contexts they don't
  own); can open, edit, delete, share, and unshare any exploration.
- **Query templates** — sees and can edit/delete other users' *private*
  templates, change any template's visibility, and create shared templates in
  any context.

What superusers do **not** bypass:

- Share-target validation: wildcard shares (`*@domain`) still require the
  domain to be listed in `GRAPH_LAGOON_ALLOWED_SHARE_DOMAINS`.
- Identity: the user's email still comes from the platform
  (`X-Forwarded-Email` header in Databricks Apps).

The list is read at startup — restart the app after changing it. The list
itself is never exposed to the frontend; each user only receives a boolean
`is_superuser` flag for themselves.

```python
# Programmatic equivalent
settings = Settings(superuser_emails="admin@company.com,ops@company.com")
```

### Share domains

`GRAPH_LAGOON_ALLOWED_SHARE_DOMAINS` is a comma-separated list of domains for
which wildcard sharing (`*@domain`) is allowed. When unset, wildcard shares
are rejected; sharing with individual emails is always allowed.

## Programmatic Configuration

```python
from graphlagoon import Settings, create_mountable_app

settings = Settings(
    sql_warehouse_url="http://my-warehouse:8001",
    database_enabled=True,
    database_url="postgresql+asyncpg://user:pass@db:5432/graphs",
)

app = create_mountable_app(settings=settings)
```

## Deployment Modes

| Mode | Warehouse | Database | Command |
|------|-----------|----------|---------|
| Local dev (in-memory) | PySpark (local) | None | `make dev` |
| Local dev (persistent) | PySpark (local) | PostgreSQL | `make dev-db` |
| Databricks | Databricks SQL | None | `make api-databricks` |
| Databricks + local DB | Databricks SQL | PostgreSQL | `make api-databricks-localdb` |
| Embedded | Configured by host app | Configured by host app | `pip install graphlagoon` |
