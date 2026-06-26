# Graph Lagoon on Databricks Apps — Quickstart

Graph exploration on Databricks. Zero ETL. Zero extra database.

Graph Lagoon explores fraud networks, supply chains, and entity relationships directly on your Delta tables — no dedicated graph DB. Your Delta tables (Liquid Clustering, recursive CTEs, Photon SQL Warehouses) already handle bounded-depth explorations (1–4 hops). Write OpenCypher; `gsql2rsql` (MIT) transpiles it to Databricks SQL. The result is a 3D force-directed UI you deploy as a Databricks App or embed in any existing FastAPI app — single `pip install`, no extra infrastructure.

This guide stands up a brand-new FastAPI app on Databricks Apps that mounts Graph Lagoon. It targets the deployed path: service-principal OAuth, Lakebase persistence, Unity Catalog warehouses. Local/dev mode (`dev_mode`, personal tokens) is out of scope.

> Reference: the app in this folder (`mlops/platform/web_server`) already mounts Graph Lagoon in `app.py`. This doc distills the minimum to reproduce it.

---

# 1. Why a SQL Warehouse + Delta, not a graph DB

A dedicated graph database (Neo4j, TigerGraph, Neptune) is a second system with its own storage, its own ops, and its own copy of your data. For bounded-depth exploration (1–4 hops) on data that already lives in the lakehouse, that cost rarely pays off:

- **No second copy of the data.** The graph is your Delta tables. No ETL job syncing the lakehouse into a graph store, no drift between the two, no reconciliation. Nodes and edges are just rows you already have.
- **No extra storage bill.** You query the tables in place. There's no graph-DB cluster sitting idle, no duplicated terabytes, no separate backup/retention policy. Storage is the same Delta you already pay for.
- **No extra ops headcount.** Nothing new to provision, patch, scale, secure, or monitor. The SQL Warehouse autostops when idle and wakes on demand; Unity Catalog already governs access. The team that runs the lakehouse runs this.
- **One governance and security model.** Permissions, lineage, and audit come from Unity Catalog — the same grants you already manage. No second ACL system to keep in sync.
- **Photon does the work.** Liquid Clustering + recursive CTEs on a Photon warehouse make 1–4 hop traversals fast enough for interactive use, without a specialized engine.

The honest trade-off: this is **not** for deep, unbounded traversals (PageRank over the whole graph, shortest-path across millions of hops). For bounded-depth exploration and visualization on lakehouse data, skipping the dedicated DB is simpler, cheaper, and less to maintain.

---

# 2. How it works

`graphlagoon` exposes a self-contained, mountable FastAPI app (backend API + bundled frontend). You don't write graph endpoints — you call `create_mountable_app(...)` and `app.mount(...)` the result under a prefix.

In deployed mode it talks to three Databricks surfaces:

- **SQL Warehouse (Unity Catalog)** — reads graph node/edge tables.
- **Lakebase (managed Postgres)** — persists explorations, saved views, shares.
- **Unity Catalog Volume** — stores exploration snapshots.

Authentication is handled by Graph Lagoon's built-in OAuth service (`get_oauth_service()`), so you don't write token-refresh code yourself.

# 3. Prerequisites

Collect these from your Databricks workspace and Unity Catalog:

- **Workspace host** — e.g. `https://<workspace>.cloud.databricks.com`
- **SQL Warehouse ID** — the warehouse Graph Lagoon queries.
- **Unity Catalog catalog + schema** holding the graph tables. Catalog names with hyphens MUST be backtick-quoted: `` `stoneco-production-mlops-dev` ``.
- **Lakebase instance + database + Postgres schema** for persistence.
- **Unity Catalog Volume path** for snapshots, e.g. `/Volumes/<catalog>/<schema>/explorations`.
- **Service principal for M2M OAuth** — on Databricks Apps the platform injects this as the app's own identity, so no secret goes in your code or config.

---

# 4. Project layout

```text
my_graph_app/
├── app.py            # host FastAPI app; mounts graphlagoon
├── requirements.txt  # dependencies
├── app.yaml          # Databricks Apps runtime command + env
└── databricks.yml    # DAB bundle (Databricks Apps resource)
```

# 5. Dependencies (requirements.txt)

The basics needed to boot the app:

```
fastapi
uvicorn
graphlagoon
```



# IMPORTANT: graphlagoon still uses the old
# starlette.templating.TemplateResponse(name, context) signature, removed in
# starlette 1.0. Pin <1.0 until graphlagoon migrates.
starlette<1.0
