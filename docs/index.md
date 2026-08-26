---
layout: home

hero:
  name: Graph Lagoon Studio
  text: Graph Exploration on Databricks. Zero ETL. Zero Extra Cost.
  tagline: Deploy on your own infrastructure with a few lines of code — explore fraud networks, supply chains, and entity relationships directly on your Delta tables
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/graphlagoon/graphlagoon

features:
  - title: No Extra Database
    details: Skip the dedicated graph DB — your Delta tables with Liquid Clustering, recursive CTEs, and Photon-powered SQL Warehouses already handle bounded-depth graph explorations (1–4 hops)
  - title: OpenCypher to SQL
    details: Write Cypher queries that gsql2rsql (open-source, MIT) transpiles to Databricks SQL — no new query language to deploy
  - title: Interactive Exploration
    details: 3D/2D force-directed visualization with filtering, label templates, community detection, metrics, and a right-click menu you can extend with your own actions
  - title: Databricks Apps Ready
    details: Deploy as a Databricks App or embed in any existing FastAPI application — single pip install, no extra infrastructure
  - title: Bring Your Own Graph Source
    details: SQL Warehouse tables, Amazon Neptune, custom REST connections, or precomputed graphs published by your pipelines — all behind the same UI
    link: /guide/rest-connections
  - title: Everything Is a Link
    details: Style presets (?style=), saved query templates (?template=), layout overrides (?layout=), and precomputed graphs (?precomputed=) compose into shareable URLs
    link: /guide/style-presets
---

<PricingCards />

## Screenshots

<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 24px;">

![Graph Visualization](/screenshots/index-graph.png)

![Contexts](/screenshots/index-contexts.png)

</div>

::: tip Auto-generated
These screenshots are generated automatically with Playwright. Run `make docs-screenshots` to update them.
:::
