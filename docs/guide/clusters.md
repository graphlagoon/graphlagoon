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
  screen); or heavy computation — a program that takes longer than
  10 seconds is stopped.
:::

Sometimes the grouping you need doesn't exist in any algorithm menu:
"collapse every leaf node hanging off a hub", "group accounts by the
domain of their email", "everything within 2 hops of this node". A
**cluster program** is a small piece of JavaScript you write (or ask an AI
to write) that turns the loaded graph into named groups — drawn either as
collapsed shapes or as colored communities.

Programs run entirely in your browser. The code is never sent to the
server, and it can't see anything beyond the graph data already on your
screen: each run happens in a **dedicated Web Worker** whose network,
storage and messaging APIs (`fetch`, `XMLHttpRequest`, `WebSocket`,
`importScripts`, nested `Worker`s, `indexedDB`, `navigator`…) are removed
before your code executes, with no access to the page (`window`, the DOM)
either. A run that does not finish within **10 seconds** has its worker
terminated, and the page stays responsive while a program runs. The
clusters it returns are validated back on the page before anything is
drawn — return plain data only (no functions).

Open the panel from the toolbar **Clusters** button (on a case, the
**Clusters** button of the canvas toolbar). It reads top to bottom:

1. **Run bar** — **Group by** picks Louvain, weak/strong components or any
   cluster program, with its parameters inline; **Output** is **Color** (each
   group gets a color, nodes stay where they are) or **Collapse** (each group
   becomes one cluster node you can open from the list); **Run**. Once there
   is a result the bar folds into one line (`Louvain · resolution 1.0 ·
   Color`) — **change** opens it again.
2. **Groups** — what the run made, as layers: click a group to **show only
   it**, click it again to show every node; **Shift+click** or the eye adds a
   group to what is shown or hides it. The **⋯** menu selects its nodes,
   opens the members table, or deletes a program's cluster.
3. **Display** (folded) — color by group, radial or hive layout, the group
   column in the Data Table, and clearing the results.

The program library is behind **Programs…**: create, import, export, edit,
delete, or **Use** one (it becomes the run bar's *Group by*). **Similarity**
(it adds edges, not groups) is the panel's second tab.

![The Clusters panel: run bar, groups, display](/screenshots/clusters-panel.png)

![The program library](/screenshots/clusters-programs.png)

## Writing a program

Your code is the body of a function with five variables in scope:

```js
nodes            // [{ node_id, node_type, properties? }]
edges            // [{ edge_id, src, dst, relationship_type, properties? }]
selectedNodeIds  // ids currently selected in the canvas
selectedEdgeIds
params           // your declared parameters, already type-coerced
metric           // (ref, id) => value — session-computed metrics by name or id
metrics          // [{ id, name, target, valueType }] — what's computed right now
```

`metric('PageRank', node.node_id)` reads a metric computed in the [Metrics
panel](./communities-metrics.md) — built-in degree, algorithm runs, or custom
metrics. It returns `undefined` when the metric is not computed or has no
value for that item, so guard with `?? 0` (or skip the node). A name shared
by a node metric and an edge metric resolves node-first; pass the metric's id
to disambiguate. Metrics are session-only — a saved program that depends on
one does nothing useful until the metric is recomputed. Don't declare your
own top-level `const metric` or `const metrics`; both names are already in
scope.

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

A parameter can also be **bound to a node** — its id, its type, a
property, or a session-computed metric (`metric:<name>`). That's what
powers the next section.

You don't have to type parameters one card at a time: **Import JSON** in
the program editor fills the name, description, code, the right-click flag
and every parameter from one JSON object:

```json
{
  "program_name": "Same city",
  "description": "Nodes that share the clicked node's city",
  "show_in_context_menu": true,
  "code": "return [{ cluster_name: params.city, node_ids: nodes.filter(n => n.properties?.city === params.city).map(n => n.node_id) }]",
  "parameters": [
    { "id": "city", "type": "text", "label": "City", "node_binding": "prop:city" },
    { "id": "minSize", "type": "number", "default": 3, "required": false },
    { "id": "mode", "type": "select", "options": ["strict", "loose"], "default": "strict" }
  ]
}
```

`type` is `text`, `number`, `boolean` or `select` (a `select` needs
`options`); `required` defaults to `true`; `node_binding` is `node_id`,
`node_type`, `prop:<name>` or `metric:<name>`. The box also takes a list of
programs, a ```` ```json ```` fence, or a file written by **Export JSON**. In an
existing program the button reads **Edit as JSON** and starts from the
program as it is. **Manage programs…** in the Clusters panel has
**Import…** (several programs at once) and **Export all** (your programs,
not the built-ins) for moving a library between contexts.

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
running with a hole in the inputs. A `metric:` binding aborts the same way
when the metric has no value for the clicked node — including after a
reload, since metrics are session-computed; the toast says to recompute it
in the Metrics panel.

When a parameter is **required, has no default and no node binding**, the
menu can't fill it, so the run dialog opens pre-filled with the defaults and
the node-bound values; you type the rest and **Run** colors the graph the
same way.

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
- `Timed out after 10s` — the program did not finish in time (an endless
  loop, or too much work for the loaded graph)
- `Program result cannot be transferred: …` — the returned value contains
  something other than plain data, such as a function

Anything your own code throws surfaces with its message (the built-in BFS
throws `Start node "…" not found in the graph`). There's no step debugger
— for anything intricate, develop with the browser DevTools console open.

## Asking an AI to write one

The **robot** button generates a copy-paste prompt containing the
execution contract, the rules above, a worked example, and *this graph's
real node types, edge types and properties* — paste it into any assistant
and describe the grouping you want. The assistant answers with **one JSON
object** (name, description, code and parameters, in the format shown under
[Parameters](#parameters)); paste it into **Import JSON** and every field is
filled. The robot button inside the editor of an existing program builds a
prompt that embeds that program, so the assistant changes it instead of
starting over. The same workflow exists for
[labels](./labels.md) and [context-menu actions](./context-menu-actions.md).

## Managing the results

Running a program from the library (**Programs… → Run**) collapses its
clusters into cluster nodes; they show in the panel's group list — with
**Colors | Clusters** to switch when a coloring exists too — and the status
bar under the graph gains an **N clusters** chip that opens it. Each row
opens or collapses its cluster, and **show only** works the same as for
communities. **Display → Clear program clusters** removes them without
touching the programs.

## Showing only some groups

Clicking a group (in the panel, in the legend over the canvas while the
panel is closed, or **right-click → Show only this community / cluster**)
hides every other node. The layout stays; the status bar says
**Showing only: …** and its **✕** shows every node again. What is shown is
saved with the [exploration](./explorations.md) and with a case's saved
views, as a rule ("community 3"), so it applies again when they open.
