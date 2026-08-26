# Communities & Metrics

Two complementary ways to see structure the raw picture hides: **community
detection** colors the graph by who-clusters-with-whom, and **metrics**
size nodes by importance. Communities live in the **Clusters** panel
(first tab); metrics have their own **Metrics** panel.

## Community detection

Open **Clusters → Communities**, pick an algorithm, and press **Detect**.

**Louvain** (the default) is classic modularity-based community detection.
It runs in a background worker, so the UI stays responsive, and reports
the community count and modularity (**Q**). Options:

- **Resolution** (0.1–5.0, default 1.0) — higher finds more, smaller
  communities.
- **Edge types** — restrict which relationship types count as connections
  (shown when the graph has more than one). Self-loops are ignored;
  parallel edges merge into one weighted edge.

Louvain runs on the **filtered** graph, so active filters change the
result — often deliberately: filter to one relationship type and detect
communities within it.

**Any cluster program** can also be run as a community algorithm — the
dropdown lists every program by name (see
[Cluster Programs](./clusters.md)). Instead of collapsing nodes, the
program's clusters become colored communities named after the clusters; a
node in several clusters takes the first, and uncovered nodes form an
**"Others"** community. Programs with parameters show their inputs inline.

### What you see

- **Color by community** (on by default) recolors nodes with a
  qualitative palette, overriding node-type colors.
- **Layout**: *None* keeps the force layout; **Radial** pulls each
  community to its own sector of a circle (switching the view to 2D);
  **Hive plot** puts each community on its own axis.
- The results list shows every community with its color, label and size;
  right-click any member node → **View community members** for a
  searchable, CSV-exportable table.

Community assignments and colors are saved with an
[exploration](./explorations.md) and restored when it reopens. Loading new
graph data clears them — the node set changed, so the answer did too.

## Metrics

![Metrics panel](/screenshots/communities-metrics-metrics.png)

Toolbar → **Metrics**. The **Compute** tab starts from **Graph Info** —
node/edge counts, connected components, density, and a *Disconnected
Graph* warning when relevant — because several algorithms only make sense
on a connected graph.

**Degree** is built in and always available. Beyond it, compute:

| Algorithm | Measures | Notes |
|---|---|---|
| Degree / Weighted Degree | Connection count (optionally by a weight property) | Direction: all / in / out |
| PageRank | Influence via important neighbours | Damping, iterations, tolerance |
| Eigenvector | Influence, stricter form | Needs a connected graph |
| Betweenness | Bridge-ness: how often a node sits on shortest paths | |
| Closeness | Average distance to everyone else | Needs a connected graph |
| HITS Authority / Hub | Pointed-to vs pointing-at importance | Needs a connected graph |
| Edge Betweenness | The same bridge idea, for edges | |

Every algorithm accepts an **edge-type** allow-list (empty = all).
Computation runs in background workers with a **priority** setting (Low
keeps the UI smoothest, High finishes fastest); long runs show progress
with pause/resume and cancel, and the **Resource Monitor** (the activity
icon) shows workers, memory, and a history of past runs.

Each run produces a *named* metric — `PageRank (14:32:07)` — so you can
compute the same algorithm with different parameters and compare. Results
show min/max/mean; a selected node's individual values appear in the side
panel and detail modal.

### Mapping metrics to visuals

The **Visual Mapping** tab drives node size from any computed metric —
out of the box, nodes are already sized by degree (min 4, max 20). Pick a
metric and the size range; *None* returns to fixed size, and **Reset to
Defaults** restores the stock mapping.

### Two honest caveats

- Metrics are **session-only**: they are not saved into explorations, and
  they are not recomputed automatically when the graph changes — a stale
  metric keeps its values until you delete or recompute it.
- Metrics compute over the loaded graph; the built-in Degree counts all
  loaded edges even when filters hide some of them.
