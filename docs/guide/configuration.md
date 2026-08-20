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

# Amazon Neptune (see "Datasources" below)
GRAPH_LAGOON_NEPTUNE_ENDPOINT=my-cluster.cluster-abc.us-east-1.neptune.amazonaws.com
GRAPH_LAGOON_NEPTUNE_PORT=8182
GRAPH_LAGOON_NEPTUNE_USE_IAM=false
GRAPH_LAGOON_NEPTUNE_REGION=us-east-1

# Development
GRAPH_LAGOON_DEV_MODE=true
GRAPH_LAGOON_SHOW_ERROR_DETAILS=true

# Access control (see "Access Control" below)
GRAPH_LAGOON_SUPERUSER_EMAILS=admin@company.com,ops@company.com
GRAPH_LAGOON_ALLOWED_SHARE_DOMAINS=company.com
```

## Datasources

A graph context is queried through one of three kinds of backend, chosen when
the context is created and fixed from then on. For the two built-in kinds the
choice is a trade-off between completeness and latency:

| | Databricks (SQL Warehouse) | Amazon Neptune |
|---|---|---|
| **Workload** | Analytical, exploratory | Operational (OLTP) |
| **Data** | The complete graph — every node, edge and property | Whatever the serving graph carries, which may omit analytical properties |
| **Latency** | Higher; optimized for breadth | Low; optimized for traversal speed |
| **Use it to** | Investigate, cross-reference, follow a question wherever it leads | Answer known questions fast over live data |

The practical consequence: a Neptune context is the right tool when you know
what you are looking for and need it quickly, and the wrong one for drawing
analytical conclusions — confirm the properties you need are actually present
before you trust an answer.

### Databricks — SQL Warehouse (default)

The graph lives in two tables — an edge table and a node table — and Cypher is
transpiled to Spark SQL. This is what Databricks mode and the local PySpark
warehouse serve, and what every context created before datasources were
pluggable uses. Creating one of these contexts requires naming both tables and
mapping their structural columns.

### Amazon Neptune (openCypher)

A native property graph. Set `GRAPH_LAGOON_NEPTUNE_ENDPOINT` to enable it; the
"Amazon Neptune" option then appears when creating a context. Such a context
defines **no tables and no column mapping** — openCypher is sent to the cluster
as-is and its nodes and relationships map straight onto the graph.

| Variable | Default | Notes |
|---|---|---|
| `GRAPH_LAGOON_NEPTUNE_ENDPOINT` | *(unset)* | Cluster endpoint host, no scheme. Unset disables the datasource. |
| `GRAPH_LAGOON_NEPTUNE_PORT` | `8182` | |
| `GRAPH_LAGOON_NEPTUNE_USE_IAM` | `false` | SigV4 signing for IAM-auth clusters. Requires the `neptune-iam` extra. |
| `GRAPH_LAGOON_NEPTUNE_REGION` | *(unset)* | Required when `USE_IAM=true`. |
| `GRAPH_LAGOON_NEPTUNE_USE_TLS` | `true` | Set `false` only for the local emulator. |
| `GRAPH_LAGOON_NEPTUNE_TLS_VERIFY` | `true` | |
| `GRAPH_LAGOON_NEPTUNE_HTTP_TIMEOUT` | `120` | Seconds. |
| `GRAPH_LAGOON_NEPTUNE_DISCOVERY_SAMPLE_LIMIT` | `10000` | Row cap when discovering labels by sampling. |

For IAM auth, install the extra and configure the standard AWS credential chain:

```bash
uv sync --extra neptune-iam
```

**What differs for a Neptune context.** Queries are read-only openCypher, sent
unchanged. Everything that exists only because of the SQL warehouse is hidden in
the UI and rejected by the API: raw SQL queries, the transpile-to-SQL review and
its options, CTE pre-filters, schema-drift checking, and catalog/table browsing.
Explorations, snapshots, sharing, cluster programs, layouts and every
visualization feature work identically — they consume the same normalized graph.

**Connection scope.** Like the warehouse, the connection is server-level: one
cluster per deployment, shared by every user of that deployment.

**Cancellation.** Neptune's openCypher HTTP API returns no query id at submit
time, so cancelling stops the API-side request but does not guarantee the
cluster stops executing.

### REST connections

The third kind: any number of **named connections** to external graph-serving
HTTP APIs, registered in code by the app embedding Graph Lagoon (not by env
vars — there is nothing to configure here at the server level). A REST context
records the connection's name; the query language, the response mapping, auth
and which operations exist are all declared per connection.

See [REST Connections](/guide/rest-connections) for the full spec API. Under
`make dev-neptune`, three demo connections cover every feature (all
operations, response mapper, custom request builder, degraded query-only UI)
— all executing real openCypher against the seeded local graph database
through a REST facade mounted on the dev host.

### Trying Neptune locally

There is no official local Neptune. `make dev-neptune` starts a Neo4j container
(which speaks openCypher natively) behind a small emulator that presents
Neptune's HTTP contract, seeds a sample graph, and points the API at it — so the
real Neptune code path runs without an AWS account.

The seed is deterministic (106 nodes, 349 relationships, 4 labels, 7
relationship types) and shaped so the query controls are observable rather than
merely exercised: a 9-level `REPORTS_TO` chain where expanding outward reaches
exactly `depth` nodes, a 24-employee hub that overflows any sane edge limit, a
`KNOWS` ring with chords for dense undirected expansion, a layered `DEPENDS_ON`
DAG ending in sinks with no outgoing edges, and one component deliberately
disconnected from everything else.

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
- **Graph queries** — can open any context's graph and run queries (subgraph,
  expand, SQL, Cypher, and table queries) without a manually granted
  read/write share.

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
