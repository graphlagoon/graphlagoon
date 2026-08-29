# Getting Started

::: tip TL;DR
Graph Lagoon explores the graph already living in your warehouse —
Cypher transpiled to SQL over Delta tables (or Neptune / REST sources),
rendered as an interactive 2D/3D graph. Zero ETL, no dedicated graph
database.

- **Use it when** you're investigating entity relationships — fraud
  rings, supply chains, org structures — with bounded-depth neighborhoods
  (1–4 hops) over data you already have in tables.
- **Not the tool for** deep or unbounded traversals and
  millisecond-latency graph serving (that's a dedicated graph database —
  though it can front Neptune); visualizing an entire warehouse at once
  (you explore query-sized subgraphs, and partial views are flagged
  `⚠ truncated`); or writing data — exploration is strictly read-only.
:::

## Installation

### As a pip package

```bash
pip install graphlagoon
```

### From source (development)

```bash
git clone https://github.com/graphlagoon/graphlagoon.git
cd graphlagoon
make install
```

## Quick Start

### Standalone

```bash
graphlagoon serve
# Open http://localhost:8000/graphlagoon/
```

### Embedded in FastAPI

```python
from fastapi import FastAPI
from graphlagoon import create_mountable_app

app = FastAPI()
app.mount("/graphlagoon", create_mountable_app(mount_prefix="/graphlagoon"))
```

> If you enable database persistence, the parent app must also delegate the
> mounted app's lifespan so migrations run on startup — see
> [Databricks Integration → Minimal Setup](/guide/integration#minimal-setup).

### Development mode

```bash
make dev
# Frontend: http://localhost:3000
# API:      http://localhost:8000
# Warehouse: http://localhost:8001
```

Use `make dev-stop` to stop all services.

### Sample data

`make dev` and `make dev-db` finish by seeding the running stack with
generated users, graphs, contexts, explorations and shares (30 / 5 / 60 / 200
by default), so there is something to click on immediately. The seed prints
which e-mails to log in as; `dev@graphlagoon.local` is a local superuser.
`SEED_DATA=0 make dev` starts empty; `make dev-seed` reseeds a running stack.

## Your First Graph

### 1. Sign in

In development mode there is no password — you identify yourself with an
email address, which becomes the owner of everything you create (contexts,
explorations, presets). In production deployments the surrounding platform
provides the identity instead — see
[Databricks Integration → Authentication](/guide/integration).

![Login](/screenshots/getting-started-login.png)

### 2. Create a graph context

A **context** tells Graph Lagoon where your graph lives: which table holds
the edges, which holds the nodes, and which columns identify them. It is a
pointer, not a copy — no data is imported or transformed.

On the **Contexts** page, click **Create Context**. The form asks for:

- **Title** — a name for this graph
- **Edge Table** — the table with one row per relationship, and which columns
  are the edge id, source, destination, and relationship type
- **Node Table** — the table with one row per entity, and which columns are
  the node id and node type

Both tables are picked in one panel, fed from your warehouse: browse
catalog → schema on the left and mark a row **Edges** or **Nodes**, or search
across every catalog when you already know the name. The panel shows the pair
you have chosen, with their shared `catalog.schema` written once, and warns if
the two end up in different schemas. A table your warehouse does not list
(only names containing `edge` or `node` are listed) can be named directly
with **Table not listed?**.

Optional property columns you select here become available for filtering,
labels, and the detail panel later.

![Contexts](/screenshots/index-contexts.png)

### Other table shapes and datasources

A messy warehouse is still a graph: an edge-only **triple store** (no node
table) and tables **without type columns** are both first-class — see
[Triple Stores & Typeless Tables](./triple-stores.md). And tables are not
the only backend: a context can also query [Amazon Neptune](./neptune.md)
(native openCypher) or any [REST connection](./rest-connections.md) your
deployment registers — the datasource picker at the top of the form shows
whatever is enabled.

### 3. Open it and explore

Click **Open** on the context card. Load data by running a query
(OpenCypher or SQL from the **Query** panel) or by expanding outward from
nodes you already see — right-click a node for its actions.

![Graph Visualization](/screenshots/index-graph.png)

The toolbar groups what you can do with a loaded graph:

| Panel | What it does |
|---|---|
| Filters | Show/hide nodes and edges by type or property values |
| Query | Run OpenCypher or SQL; results render as graph or table |
| Templates | Saved, parameterized queries — see [Query Templates](/guide/query-templates) |
| Style | Colors, sizes, icons; save the look as a preset — see [Style Presets](/guide/style-presets) |
| Labels | What text each node/edge shows, with a template language |
| Metrics | Degree and other per-node metrics, mappable to size/color |
| Clusters | Community detection and user-defined cluster programs |
| Behaviors | Per-context defaults, like auto-loading data on open |

### 4. Save what you found

An **exploration** captures the current state of your investigation so you
can come back to it or share it as a link (`?exploration=<id>`). Use
**Save** in the toolbar; find saved ones under **Explorations** or with
**Load**.

## Where next

- Connecting Databricks and configuring the warehouse:
  [Databricks Integration](/guide/integration)
- Deploying for your team: [Deploy as a Databricks App](/guide/databricks-apps)
- Graph sources beyond SQL tables:
  [Amazon Neptune](/guide/neptune),
  [REST Connections](/guide/rest-connections),
  [Precomputed Graphs](/guide/precomputed-graphs)
- Edge-only or typeless tables:
  [Triple Stores & Typeless Tables](/guide/triple-stores)
- Every environment variable: [Configuration](/guide/configuration)

## Prerequisites (for development)

- Node.js 18+
- Python 3.11+
- [uv](https://docs.astral.sh/uv/)
- Docker (optional, for PostgreSQL)
