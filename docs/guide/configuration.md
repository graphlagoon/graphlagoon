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
```

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
