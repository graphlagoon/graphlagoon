# Amazon Neptune

::: tip TL;DR
A native property-graph datasource: set `GRAPH_LAGOON_NEPTUNE_ENDPOINT` and
"Amazon Neptune" appears in the context-creation picker. openCypher goes to
the cluster as-is — no tables, no column mapping, no transpilation.

- **Use it when** you have an operational (OLTP) graph and known questions
  to answer fast over live data — traversals, lookups, serving-path
  queries.
- **Not the tool for** analytical conclusions: the serving graph may omit
  analytical properties, and raw SQL, CTE pre-filters and schema-drift
  checks don't exist here. For the complete graph in Delta tables, use a
  [SQL warehouse context](./getting-started.md#_2-create-a-graph-context);
  for graphs behind your own HTTP API, use a
  [REST connection](./rest-connections.md).
:::

Graph Lagoon queries a graph context through one of three kinds of backend,
fixed at creation time: the **SQL warehouse** (Databricks or the local
PySpark warehouse — the default, and the only one with table configuration),
**Amazon Neptune**, and [REST connections](./rest-connections.md). For the
two built-in kinds the choice is a completeness-vs-latency trade-off:

| | Databricks (SQL Warehouse) | Amazon Neptune |
|---|---|---|
| **Workload** | Analytical, exploratory | Operational (OLTP) |
| **Data** | The complete graph — every node, edge and property | Whatever the serving graph carries |
| **Latency** | Higher; optimized for breadth | Low; optimized for traversal speed |
| **Use it to** | Investigate, cross-reference, follow a question | Answer known questions fast over live data |

A Neptune context is the right tool when you know what you are looking for
and need it quickly — and the wrong one for drawing analytical conclusions.
Confirm the properties you need are actually present in the serving graph
before you trust an answer.

## Enabling the datasource

The connection is **server-level**: one cluster per deployment, shared by
every user, exactly like the warehouse. A graph context only records that it
is a "neptune" context. Setting the endpoint is what enables the option:

| Variable | Default | Notes |
|---|---|---|
| `GRAPH_LAGOON_NEPTUNE_ENDPOINT` | *(unset)* | Cluster endpoint host, no scheme. Unset disables the datasource entirely. |
| `GRAPH_LAGOON_NEPTUNE_PORT` | `8182` | |
| `GRAPH_LAGOON_NEPTUNE_USE_IAM` | `false` | SigV4 signing for IAM-auth clusters. Requires the `neptune-iam` extra. |
| `GRAPH_LAGOON_NEPTUNE_REGION` | *(unset)* | Required when `USE_IAM=true`. |
| `GRAPH_LAGOON_NEPTUNE_USE_TLS` | `true` | Set `false` only for the local emulator. |
| `GRAPH_LAGOON_NEPTUNE_TLS_VERIFY` | `true` | |
| `GRAPH_LAGOON_NEPTUNE_HTTP_TIMEOUT` | `120` | Seconds. |
| `GRAPH_LAGOON_NEPTUNE_DISCOVERY_SAMPLE_LIMIT` | `10000` | Row cap when discovering labels by sampling. |

For IAM auth, install the extra and configure the standard AWS credential
chain:

```bash
uv sync --extra neptune-iam
```

The same variables are listed in the
[configuration reference](./configuration.md#datasources).

## Creating a Neptune context

With the endpoint set, the datasource picker in **Create Context** offers
"Amazon Neptune" next to the warehouse. A Neptune context defines **no
tables and no column mapping** — the database already knows its own shape,
so the whole table half of the form simply is not shown. **Discover** reads
the cluster's own label catalog to fill in node and relationship types.

## What differs from a warehouse context

Queries are **read-only openCypher, sent unchanged** — no transpilation.
Everything that exists only because of the SQL warehouse is hidden in the UI
and rejected by the API:

| Not available | Why |
|---|---|
| Raw SQL console queries | There is no SQL engine behind the context |
| Transpile-to-SQL review and its options | Nothing is transpiled |
| CTE pre-filters | A SQL-text feature |
| Schema-drift checking | No stored table snapshot to drift from |
| Catalog / table browsing | No catalog |

Everything else — explorations, snapshots, sharing, cluster programs,
communities and metrics, layouts, labels, style presets, every
visualization feature — works identically: they all consume the same
normalized graph.

**Cancellation caveat:** Neptune's openCypher HTTP API returns no query id
at submit time, so cancelling a query stops the API-side request but does
not guarantee the cluster stops executing it.

## Trying it locally

There is no official local Neptune. `make dev-neptune` starts a Neo4j
container (which speaks openCypher natively) behind a small emulator that
presents Neptune's HTTP contract, seeds a sample graph, and points the API
at it — the real Neptune code path runs without an AWS account.

The seed is deterministic (106 nodes, 349 relationships, 4 labels, 7
relationship types) and shaped so the query controls are observable: a
9-level `REPORTS_TO` chain where expanding outward reaches exactly `depth`
nodes, a 24-employee hub that overflows any sane edge limit, a `KNOWS` ring
with chords for dense undirected expansion, a layered `DEPENDS_ON` DAG, and
one deliberately disconnected component.

## When something is wrong

- **The Neptune option doesn't appear** in the picker: the endpoint is not
  set (or the API was not restarted after setting it).
- **Queries fail with connection errors**: check port/TLS settings — the
  local emulator needs `GRAPH_LAGOON_NEPTUNE_USE_TLS=false`; a real cluster
  needs network reachability from the API host (Neptune is VPC-only).
- **IAM clusters reject requests**: `USE_IAM=true` needs the `neptune-iam`
  extra installed, `GRAPH_LAGOON_NEPTUNE_REGION` set, and AWS credentials
  available through the standard chain.
- **A property you expect is missing**: the serving graph may simply not
  carry it — that is the trade-off in the table above, not a bug.
