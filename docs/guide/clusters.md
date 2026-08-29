# Cluster Programs

::: tip TL;DR
Write (or ask an AI to write) a small JavaScript function that groups the
loaded graph into named clusters — collapsed shapes or colored groups —
using your domain rules.

- **Use it when** the grouping is *knowledge you have* ("collapse leaves
  per hub", "group accounts by email domain", "everything 2 hops from
  here") rather than something an algorithm should discover.
- **Not the tool for** statistical community detection (use
  [Louvain](./communities-metrics.md)); anything needing data beyond the
  loaded graph (programs run in your browser and see only what's on
  screen); or heavy computation — code runs synchronously on the UI
  thread, so an expensive program on a large graph will freeze the page
  while it runs.
:::

Sometimes the grouping you need doesn't exist in any algorithm menu:
"collapse every leaf node hanging off a hub", "group accounts by the
domain of their email", "everything within 2 hops of this node". A
**cluster program** is a small piece of JavaScript you write (or ask an AI
to write) that turns the loaded graph into named groups — drawn either as
collapsed shapes or as colored communities.

Programs run entirely in your browser. The code is never sent to the
server, and it can't see anything beyond the graph data already on your
screen.

Open the panel from the toolbar **Clusters** button; cluster programs live
in its **Programs** tab.

![Cluster programs](/screenshots/clusters-programs.png)

## Writing a program

Your code is the body of a function with five variables in scope:

```js
nodes            // [{ node_id, node_type, properties? }]
edges            // [{ edge_id, src, dst, relationship_type, properties? }]
selectedNodeIds  // ids currently selected in the canvas
selectedEdgeIds
params           // your declared parameters, already type-coerced
```

It must **return an array of clusters**:

```js
const clusters = {};
for (const node of nodes) {
  (clusters[node.node_type] ??= []).push(node.node_id);
}
return Object.entries(clusters).map(([type, node_ids], i) => ({
  cluster_name: type,          // required
  node_ids,                    // required — ids must exist in the graph
  figure: 'hexagon',           // circle | box | diamond | hexagon | star
  state: 'closed',             // 'closed' collapses; 'open' keeps nodes visible
  color: ['#42b883', '#3e63dd', '#e5484d'][i % 3],
  cluster_class: 'by-type',    // free-form tag, used by the cluster list filter
  description: `All ${type} nodes`,
}));
```

`nodes` and `edges` are the **full loaded graph**, not the filtered view.
A **closed** cluster collapses its members into a single shaped node (its
edges are re-pointed there); an **open** cluster keeps members visible. A
node may belong to several clusters — it stays visible if any of them is
open. Click a collapsed cluster node to open a searchable table of its
members with CSV export.

The editor (New → **JavaScript Code**) has syntax highlighting,
autocomplete for the injected variables, and insertable snippets. Three
built-in programs double as worked examples — **Group by Node Type**,
**Orphan Clusters** (leaves grouped per hub), and **BFS from Node** — they
can't be deleted, and edits to them last only until reload.

## Parameters

Declare parameters in the editor (text, number, boolean, dropdown;
optional defaults, required flag) and read them as `params.<id>`. A
program with parameters opens a **Run** dialog; one without runs
immediately.

A parameter can also be **bound to a node** — its id, its type, or a
property. That's what powers the next section.

## Running from the right-click menu

Check **"Show in node right-click menu"** and the program appears as an
action in the node [context menu](./context-menu-actions.md). Node-bound
parameters take their values from the clicked node — the built-in *BFS
from Node* binds `start_node_id` this way, giving you "show everything
within N hops of this node" in two clicks.

Menu runs execute the program as a **community algorithm**: nodes are
recolored by group instead of collapsed, and a toast summarizes the result
(see [Communities & Metrics](./communities-metrics.md)). A missing bound
property aborts the run with a toast naming the property, rather than
running with a hole in the inputs.

## Where programs are saved

| Scope | Saved to | Who sees it |
|---|---|---|
| **Context** | The graph context, immediately | Everyone who can open the context, in every exploration |
| **Exploration** | The exploration's saved state | Whoever opens that exploration |
| Built-in | Nowhere — recreated from code | Everyone |

The "Save to" choice appears only if you have write access to the context;
read-only users' programs are exploration-scoped automatically. The
**clusters a program produces** (unlike the program itself) are saved with
the exploration — and cleared automatically whenever new graph data loads,
because their node ids may no longer exist.

## When something is wrong

Every run — success or failure — lands in the program's **Recent
Executions** with its duration or error. The validator names the exact
problem before anything is drawn:

- `Program must return an array of clusters. Got: object`
- `Cluster at index 0 missing required field: cluster_name`
- `Cluster "X": invalid node_ids: a, b, c (and 12 more)`
- `Cluster "X": invalid figure "blob". Must be one of: circle, box, diamond, hexagon, star`
- `Missing required parameter: depth`

Anything your own code throws surfaces with its message (the built-in BFS
throws `Start node "…" not found in the graph`). There's no step debugger
— for anything intricate, develop with the browser DevTools console open.

## Asking an AI to write one

The **robot** button generates a copy-paste prompt containing the
execution contract, the rules above, a worked example, and *this graph's
real node types, edge types and properties* — paste it into any assistant
and describe the grouping you want. The same workflow exists for
[labels](./labels.md) and [context-menu actions](./context-menu-actions.md).

## Managing the results

Once clusters exist, the Clusters panel's **Results** tab lists them — the
tab shows how many, and the status bar under the graph gains an **N
clusters** chip that opens it. The list filters by state and class, toggles
each cluster open/closed (or all at once), and shows per-cluster stats.
**Clear Clusters** in the Programs tab wipes the current groups without
touching the programs.
