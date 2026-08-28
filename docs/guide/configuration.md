# Configuration

::: tip TL;DR
The reference for every `GRAPH_LAGOON_*` environment variable and the
programmatic `Settings` equivalent: warehouse, database, Databricks,
Neptune, precomputed graphs, presets, superusers and share domains.

- **Use it when** you're deploying and need the exact knob — or setting
  up access control.
- **Not a tutorial** — start at [Getting Started](./getting-started.md)
  or [Databricks Integration](./integration.md); each feature's
  *behavior* is explained in its own guide, this page only lists what you
  can set.
:::

Graph Lagoon Studio is configured via environment variables or programmatically through `Settings`.

## Environment Variables

```bash
# Warehouse connection (local PySpark)
SQL_WAREHOUSE_URL=http://localhost:8001

# Database (optional — for persisting explorations/contexts)
GRAPH_LAGOON_DATABASE_ENABLED=true
GRAPH_LAGOON_DATABASE_URL=postgresql+asyncpg://user:pass@localhost:5432/sgraph
# Connection pool (defaults shown — see "Database connection pool" below)
GRAPH_LAGOON_DATABASE_POOL_SIZE=10
GRAPH_LAGOON_DATABASE_MAX_OVERFLOW=20
GRAPH_LAGOON_DATABASE_POOL_TIMEOUT=30
GRAPH_LAGOON_DATABASE_POOL_RECYCLE=3600

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

# Precomputed graphs (see "Precomputed graphs" below)
GRAPH_LAGOON_PRECOMPUTED_GRAPHS_ENABLED=true
GRAPH_LAGOON_PRECOMPUTED_GRAPHS_DIR=./tmp/precomputed-graphs
# GRAPH_LAGOON_PRECOMPUTED_GRAPHS_VOLUME_PATH=/Volumes/catalog/schema/volume/precomputed-graphs
GRAPH_LAGOON_PRECOMPUTED_GRAPHS_MAX_BYTES=209715200

# Style presets (see "Style presets" below)
GRAPH_LAGOON_STYLE_PRESETS_ENABLED=true
GRAPH_LAGOON_STYLE_PRESETS_DIR=./tmp/style-presets
# GRAPH_LAGOON_STYLE_PRESETS_VOLUME_PATH=/Volumes/catalog/schema/volume/style-presets
GRAPH_LAGOON_STYLE_PRESETS_MAX_PER_CONTEXT=100

# Custom metrics (see "Custom metrics" below)
GRAPH_LAGOON_CUSTOM_METRICS_ENABLED=true
GRAPH_LAGOON_CUSTOM_METRICS_AUTO_RUN_ENABLED=true

# Development
GRAPH_LAGOON_DEV_MODE=true
GRAPH_LAGOON_SHOW_ERROR_DETAILS=true

# Access control (see "Access Control" below)
GRAPH_LAGOON_SUPERUSER_EMAILS=admin@company.com,ops@company.com
GRAPH_LAGOON_ALLOWED_SHARE_DOMAINS=company.com
```

## Database connection pool

When PostgreSQL persistence is enabled, the API keeps a pool of connections
instead of opening one per request. The defaults suit a single-instance
deployment; tune them when many workers share one database or when the
database sits behind a connection limit.

| Variable | Default | Notes |
|---|---|---|
| `GRAPH_LAGOON_DATABASE_POOL_SIZE` | `10` | Persistent connections kept open per API process. |
| `GRAPH_LAGOON_DATABASE_MAX_OVERFLOW` | `20` | Extra connections allowed under load, closed when idle again. Worst case per process is `pool_size + max_overflow`. |
| `GRAPH_LAGOON_DATABASE_POOL_TIMEOUT` | `30` | Seconds a request waits for a free connection before failing — a bound, so exhaustion surfaces as an error instead of a hang. |
| `GRAPH_LAGOON_DATABASE_POOL_RECYCLE` | `3600` | Connections older than this many seconds are recycled, so idle ones don't outlive server-side or firewall timeouts. |

These apply to the standard PostgreSQL backend. The
[Databricks Lakebase](./integration.md) backend manages its own pool with a
shorter recycle interval, tied to its OAuth token lifetime — these variables
do not affect it.

## Precomputed graphs

A **precomputed graph** is a named graph resource resolved on the server and
opened from a URL:

```
/graph/{context_id}?precomputed=fraude-2024
/graph/{context_id}?precomputed=vizinhanca&seed=99872&hops=3
```

Anyone who can read the context can open one. Where the graph comes from is the
deploying developer's decision, expressed as a **provider**: a file published by
a batch job, a query against Lakebase computed from the link's own arguments, a
Delta table. Providers are registered in an ordered chain and each may decline,
so one deployment can serve a volume in one context and a live query in another.

The full guide, including worked examples for each of those, is
[Precomputed Graphs](./precomputed-graphs.md). What follows is the configuration
of the built-in **volume provider** — the default, and what the in-app publish
panel writes to.

| Variable | Default | Notes |
|---|---|---|
| `GRAPH_LAGOON_PRECOMPUTED_GRAPHS_ENABLED` | `true` | `false` makes every endpoint answer 404, before any authorization check. |
| `GRAPH_LAGOON_PRECOMPUTED_GRAPHS_DIR` | `./tmp/precomputed-graphs` | Local directory, used when no volume path applies. |
| `GRAPH_LAGOON_PRECOMPUTED_GRAPHS_VOLUME_PATH` | *(unset)* | Unity Catalog Volume path. Defaults to a `precomputed-graphs` subdirectory of `GRAPH_LAGOON_DATABRICKS_VOLUME_PATH` when that is set. |
| `GRAPH_LAGOON_PRECOMPUTED_GRAPHS_MAX_BYTES` | `209715200` (200 MB) | Cap on one compressed entry written through the volume provider. |

Entries live at `{root}/precomputed/{context_id}/{name}.jsonz` — gzip'd JSON.
The extension deliberately does not name the codec, and reads dispatch on magic
bytes, so the compression can change later without migrating a single file.
gzip specifically, rather than something denser, because the read endpoint hands
the stored bytes back untouched under `Content-Encoding: gzip`: the server never
decompresses or re-serializes the graph, and the browser unpacks it natively.

Names must match `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$` and are **case-sensitive**
— on a case-insensitive local filesystem (macOS) `Foo` and `foo` are one entry;
on a volume they are two.

### Arguments are part of the link

Every query parameter the frontend does not own is forwarded to the resolving
provider as an argument. The provider declares which it accepts, with types and
bounds; anything undeclared is a 400 rather than a silently ignored key, because
a typo in an argument would otherwise return *different data* with nothing on
screen to say so.

Reserved keys, never forwarded: `precomputed`, `style`, `exploration`, anything
starting with `layout` or `template`, and the usual tracking parameters
(`utm_*`, `fbclid`, `gclid`) so a link pasted into a chat client still works.

### There is no way to list them

Entries are addressed by name, and the API deliberately offers **no listing
endpoint**. Enumeration is the one operation that does not survive scale: a
directory listing costs about 16 µs and 100 bytes of JSON per entry (measured
locally), so a context holding a million entries would mean a 16-second call
returning a 100 MB response. Paging would only have moved that cost around,
because the Databricks Files API has no server-side name filter to page
*toward*. Since every real use of a link already knows the name it wants, not
offering the operation is the only answer that stays correct at every size.

The collection URL answers with **capabilities** — what this context can do —
never with an inventory.

The practical consequence: **keep the name when you create one.** The panel
shows the link immediately after publishing, and that URL is the durable handle.

### Who can write

Reading is available wherever the feature is enabled. Writing needs two
independent things:

1. **Superuser status** (`GRAPH_LAGOON_SUPERUSER_EMAILS`). A precomputed graph
   is a published, administered artifact, not a personal one. Context ownership
   grants no special power over it — the owner gets no more write access than a
   stranger does, unlike a [style preset](#style-presets), which anyone with
   context write access can save.
2. **A provider that declares the capability.** Most do not: a graph computed
   from a Lakebase query has nowhere to write back to, and answers 405. The
   toolbar's **Precomputed** panel asks the server what this context supports
   rather than assuming, so it shows an explanation instead of a button that
   would fail.

Deletion is idempotent — with nothing to enumerate there is no way to check
first, so removing a name that was never there also succeeds.

Deleting a context asks **every** registered provider to purge it, not just the
one that would have served a read: a context's graphs can live in several
backends at once. That cleanup is not gated on superuser status, since skipping
it would leak storage permanently.

::: warning Multi-replica deployments
Without a volume path, the volume provider is a directory local to one process.
Behind more than one replica the same URL lands on different replicas, and a
graph appears and disappears at random. Set
`GRAPH_LAGOON_PRECOMPUTED_GRAPHS_VOLUME_PATH` (or
`GRAPH_LAGOON_DATABRICKS_VOLUME_PATH`) for any deployment that is not a single
process. The API logs a warning at startup when it detects this combination —
and only when a registered provider actually uses that directory.
:::

### Precomputed graph or exploration?

Both persist a graph to the same kind of volume, which makes them easy to
confuse. They answer different questions:

| | Precomputed graph | Exploration |
|---|---|---|
| **Addressed by** | a name you chose, plus arguments | an opaque UUID |
| **Belongs to** | the context — everyone with access sees it | the user who saved it, plus whoever it is shared with |
| **Who can write** | superusers, where the provider allows it | the user, for their own explorations |
| **Stores** | the data: nodes, edges, properties | the result **plus** UI state — positions, communities, clusters, filters |
| **On open** | layout runs fresh | the saved layout is restored |
| **Use it for** | "here is the graph, look at this link" | "let me pick up where I left off" |

If you need node positions preserved, you want an exploration. A precomputed
graph deliberately does not carry them: it is data, and the layout settles again
on load.

## Style presets

A **style preset** is how a context's graph looks, saved under a name and
applied via `?style=<name>` — see [Style Presets](./style-presets.md) for
saving, applying, permissions, and how it composes with a precomputed graph
and with layout URL overrides.

| Variable | Default | Notes |
|---|---|---|
| `GRAPH_LAGOON_STYLE_PRESETS_ENABLED` | `true` | `false` makes every preset endpoint answer 404. |
| `GRAPH_LAGOON_STYLE_PRESETS_DIR` | `./tmp/style-presets` | Local directory, used when no volume path applies. |
| `GRAPH_LAGOON_STYLE_PRESETS_VOLUME_PATH` | *(unset)* | Unity Catalog Volume path. Defaults to a `style-presets` subdirectory of `GRAPH_LAGOON_DATABRICKS_VOLUME_PATH` when that is set. |
| `GRAPH_LAGOON_STYLE_PRESETS_MAX_PER_CONTEXT` | `100` | Presets are listed in full for the picker, so the count is bounded here rather than paginated at read time. |

## Custom metrics

[Custom metrics](./communities-metrics.md#custom-metrics) are JavaScript
snippets, written by users with write access to a context, evaluated per
node/edge in a sandboxed worker of every writer's browser. Two flags let a
deployment turn the feature — or just its automatic execution — off:

| Variable | Default | Notes |
|---|---|---|
| `GRAPH_LAGOON_CUSTOM_METRICS_ENABLED` | `true` | `false` hides every definition from API responses (writers included), rejects writes of `metric_definitions` with `400 CUSTOM_METRICS_DISABLED`, and removes the **Custom** tab. Stored definitions are kept and reappear when re-enabled. |
| `GRAPH_LAGOON_CUSTOM_METRICS_AUTO_RUN_ENABLED` | `true` | `false` ignores the per-metric **Run automatically when the graph loads** flag: every custom metric then evaluates only on **Recompute** (or when its author saves it). The checkbox is shown disabled with the reason. |

Both are reported to the frontend as `custom_metrics_enabled` /
`custom_metrics_auto_run_enabled` in `GET /api/config`.

## Layout URL overrides

Layout parameters — which node an ego layout centers on, traversal direction,
hop limits — can be set field by field from the URL, on top of whatever a
style preset restored. There is no dedicated setting: see
[Layout URL Overrides](./layout-url-overrides.md) for the full grammar,
settable fields per mode, and worked examples.

## Run a saved query template from a link

A saved, parameterized query can be executed straight from a URL —
`?template=<name>&template.<param>=<value>`. See
[Query Templates](./query-templates.md#running-a-template-from-a-link) for the
grammar, its all-or-nothing validation rules, and the full comparison against
style presets, precomputed graphs, and explorations.

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
pluggable uses. Creating one of these contexts requires naming the edge table
and mapping the structural columns; the node table and the type columns are
optional — an edge-only triple store derives its nodes from the edge
endpoints (see [Triple Stores & Typeless Tables](/guide/triple-stores)).

### Amazon Neptune (openCypher)

A native property graph. Set `GRAPH_LAGOON_NEPTUNE_ENDPOINT` to enable it; the
"Amazon Neptune" option then appears when creating a context. Such a context
defines **no tables and no column mapping** — openCypher is sent to the cluster
as-is and its nodes and relationships map straight onto the graph. See the
[Amazon Neptune guide](/guide/neptune) for the full picture.

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

The list is read at startup — restart the app after changing it. Regular users
never receive the list; each user only gets a boolean `is_superuser` flag for
themselves.

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
