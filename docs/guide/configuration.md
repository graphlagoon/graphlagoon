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

# Graph cache (see "Graph cache" below)
GRAPH_LAGOON_GRAPH_CACHE_ENABLED=true
GRAPH_LAGOON_GRAPH_CACHE_DIR=./tmp/graph-cache
# GRAPH_LAGOON_GRAPH_CACHE_VOLUME_PATH=/Volumes/catalog/schema/volume/graph-cache
GRAPH_LAGOON_GRAPH_CACHE_MAX_BYTES=209715200

# Style presets (see "Style presets" below)
GRAPH_LAGOON_STYLE_PRESETS_ENABLED=true
GRAPH_LAGOON_STYLE_PRESETS_DIR=./tmp/style-presets
# GRAPH_LAGOON_STYLE_PRESETS_VOLUME_PATH=/Volumes/catalog/schema/volume/style-presets
GRAPH_LAGOON_STYLE_PRESETS_MAX_PER_CONTEXT=100

# Development
GRAPH_LAGOON_DEV_MODE=true
GRAPH_LAGOON_SHOW_ERROR_DETAILS=true

# Access control (see "Access Control" below)
GRAPH_LAGOON_SUPERUSER_EMAILS=admin@company.com,ops@company.com
GRAPH_LAGOON_ALLOWED_SHARE_DOMAINS=company.com
```

## Graph cache

A **graph cache** is a query result stored under a name and reopened from a URL:

```
/graph/{context_id}?graph=fraude-2024
```

Anyone who can read the context can open its caches. Nothing is queried — the
stored nodes and edges are served straight from the volume — so a link opens in
about the time it takes to download them, no matter how expensive the original
query was.

| Variable | Default | Notes |
|---|---|---|
| `GRAPH_LAGOON_GRAPH_CACHE_ENABLED` | `true` | `false` makes every cache endpoint answer 404. |
| `GRAPH_LAGOON_GRAPH_CACHE_DIR` | `./tmp/graph-cache` | Local directory, used when no volume path applies. |
| `GRAPH_LAGOON_GRAPH_CACHE_VOLUME_PATH` | *(unset)* | Unity Catalog Volume path. Defaults to a `graph-cache` subdirectory of `GRAPH_LAGOON_DATABRICKS_VOLUME_PATH` when that is set. |
| `GRAPH_LAGOON_GRAPH_CACHE_MAX_BYTES` | `209715200` (200 MB) | Cap on one compressed entry. |

Entries live at `{root}/cache/{context_id}/{name}.jsonz` — gzip'd JSON. The
extension deliberately does not name the codec, and reads dispatch on magic
bytes, so the compression can change later without migrating a single file.
gzip specifically, rather than something denser, because the read endpoint hands
the stored bytes back untouched under `Content-Encoding: gzip`: the server never
decompresses or re-serializes the graph, and the browser unpacks it natively.

Names must match `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$` and are **case-sensitive**
— on a case-insensitive local filesystem (macOS) `Foo` and `foo` are one entry;
on a volume they are two.

### There is no way to list them

Entries are addressed by name, and the API deliberately offers **no listing
endpoint**. Enumeration is the one operation that does not survive scale: a
directory listing costs about 16 µs and 100 bytes of JSON per entry (measured
locally), so a context holding a million entries would mean a 16-second call
returning a 100 MB response. Paging would only have moved that cost around,
because the Databricks Files API has no server-side name filter to page
*toward*. Since every real use of a cache already knows the name it wants,
not offering the operation is the only answer that stays correct at every size.

The practical consequence: **keep the name when you create one.** The dev panel
shows the link immediately after saving, and a cache URL is the durable handle.

### Who can write

Reading is available wherever the feature is enabled. **Creating and deleting
through the API are restricted to superusers** (`GRAPH_LAGOON_SUPERUSER_EMAILS`)
— a graph cache is treated as a published, administered artifact, not a
personal one. Context ownership grants no special power over it: the context
owner gets no more write access to its caches than a stranger does, unlike a
[style preset](#style-presets), which anyone with context write access can
save. The toolbar's **Cache** button is visible only to a superuser, and its
two fields — save the graph on screen under a name, delete a cache by name —
answer 403 for anyone else.

Deletion is idempotent — with nothing to enumerate there is no way to check
first, so removing a name that was never there also succeeds.

Deleting a context purges its cache directory; that cleanup is not gated on
superuser status, since skipping it would leak storage permanently. It is one
request per entry against a volume, run with bounded concurrency.

::: warning Multi-replica deployments
Without a volume path, the cache is a directory local to one process. Behind more
than one replica the same URL lands on different replicas, and a cache appears
and disappears at random. Set `GRAPH_LAGOON_GRAPH_CACHE_VOLUME_PATH` (or
`GRAPH_LAGOON_DATABRICKS_VOLUME_PATH`) for any deployment that is not a single
process. The API logs a warning at startup when it detects this combination.
:::

### Cache or exploration?

Both persist a graph to the same kind of volume, which makes them easy to
confuse. They answer different questions:

| | Graph cache | Exploration |
|---|---|---|
| **Addressed by** | a name you chose | an opaque UUID |
| **Belongs to** | the context — everyone with access sees it | the user who saved it, plus whoever it is shared with |
| **Who can write** | superusers only | the user, for their own explorations |
| **Stores** | the query result: nodes, edges, properties | the result **plus** UI state — positions, communities, clusters, filters |
| **On open** | layout runs fresh | the saved layout is restored |
| **Use it for** | "here is the graph, look at this link" | "let me pick up where I left off" |

If you need node positions preserved, you want an exploration. A cache
deliberately does not carry them: it replays a query result, and the layout
settles again on load.

## Style presets

A **style preset** is how a context's graph looks, saved under a name and
applied from the URL:

```
/graph/{context_id}?style=investigacao
```

It carries three things — **style** (colors, icons, aesthetics), **labels**
(text formatting) and **layout** (algorithm, its parameters, 3D forces) — and
nothing about which data is shown. Applying one therefore never changes what is
on screen, only how it is drawn, which is why it is safe on any graph in the
context, before or after that graph loads. A graph loaded afterwards inherits
the look.

The two URL parameters compose, so a single link can pin both the data and its
appearance:

```
/graph/{context_id}?graph=fraude-2024&style=investigacao
```

| Variable | Default | Notes |
|---|---|---|
| `GRAPH_LAGOON_STYLE_PRESETS_ENABLED` | `true` | `false` makes every preset endpoint answer 404. |
| `GRAPH_LAGOON_STYLE_PRESETS_DIR` | `./tmp/style-presets` | Local directory, used when no volume path applies. |
| `GRAPH_LAGOON_STYLE_PRESETS_VOLUME_PATH` | *(unset)* | Unity Catalog Volume path. Defaults to a `style-presets` subdirectory of `GRAPH_LAGOON_DATABRICKS_VOLUME_PATH` when that is set. |
| `GRAPH_LAGOON_STYLE_PRESETS_MAX_PER_CONTEXT` | `100` | Presets are listed in full for the picker, so the count is bounded here rather than paginated at read time. |

Entries live at `{root}/style/{context_id}/{name}.jsonz`, gzip'd JSON, with the
same name rules as a graph cache.

### Permissions

Three levels, one more than elsewhere:

- **Read** — anyone with access to the context.
- **Write** — anyone with *write* access to it. Unlike a graph cache, which is
  superuser-only: a preset is a few kilobytes of preference, not a published,
  administered artifact.
- **Delete** — only the person who created that particular preset, or a
  superuser. Ownership is per preset, so one person's saved look cannot be
  thrown away by another — not even by whoever owns the context.

Overwriting an existing name keeps its original author, precisely so write
access cannot be used to take over someone else's preset and then delete it.

A preset the URL names but that does not exist **changes nothing and does not
break the page** — the graph loads and stays fully usable, and the status bar
reports that the styling was not applied. This differs from a missing `?graph=`,
which leaves nothing to look at.

::: warning Multi-replica deployments
The same caveat as the graph cache: without a volume path each replica keeps its
own copy, so a `?style=` link works intermittently. The API logs a warning at
startup when it detects this.
:::

### Preset, cache, or exploration?

| | Style preset | Graph cache | Exploration |
|---|---|---|---|
| **Stores** | how it looks | which nodes and edges | both, plus positions |
| **Scope** | the context | the context | one user, plus shares |
| **Addressed by** | `?style=name` | `?graph=name` | `?exploration=uuid` |
| **Combines with** | any graph | any style | — |

A preset and a cache are orthogonal on purpose: the same look applies to any
data, and the same data can be viewed in any look.

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
