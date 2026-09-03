# Communities & Metrics

::: tip TL;DR
Community detection colors the loaded graph by who-clusters-with-whom;
metrics (degree, PageRank, betweenness, …) size nodes by importance.

- **Use them when** you want structure to jump out of a hairball: factions
  in a network, brokers between groups, the hubs that matter.
- **Not the tool for** warehouse-scale analytics — everything computes in
  your browser over the *loaded subgraph*, so results describe what's on
  screen, not the full dataset. For graph algorithms over billions of
  edges, compute in a Spark job and publish the result as a
  [precomputed graph](./precomputed-graphs.md). Metrics are session-only:
  they aren't saved with explorations and go stale when the graph changes.
:::

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
- **Community column in Data Table** adds each node's community as a
  filterable column in the [Data Table](./exploring-the-graph.md)'s Nodes
  tab (and its CSV export). The setting is saved with explorations; the
  column disappears whenever the detection results do.

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

### Metrics in the Data Table

![Metric columns in the Data Table](/screenshots/communities-metrics-table-columns.png)

Every computed metric in the list carries a **Show as Data Table column**
checkbox. Check it and the metric's per-node (or per-edge) values appear
as a numeric column in the [Data Table](./exploring-the-graph.md) — node
metrics on the **Nodes** tab, Edge Betweenness on the **Edges** tab. The
column sorts and filters like any other, feeds the table→graph filter
sync, and is included in the table's CSV export. Uncheck the box (or
delete the metric) and the column is gone.

Two things to know:

- The columns are as **session-only** as the metrics themselves — they
  are not saved with explorations or style presets.
- The table's **global search box does not scan metric values** (it
  searches the id, type, and property text). Use the metric column's own
  numeric filter instead.

### Mapping metrics to visuals

The **Visual Mapping** tab drives node size from any computed metric —
out of the box, nodes are already sized by degree (min 4, max 20). Pick a
metric and the size range; *None* returns to fixed size, and **Reset to
Defaults** restores the stock mapping.

Each mapping has a **Scale**: *Linear*, *Logarithmic*, or *Square Root*.
Log and square-root scales compress the top of the range, which is what
you want for skewed metrics like PageRank — with a linear scale one hub
node dwarfs everything and the rest of the graph reads as uniform dots.

![Node Color mapping driven by the built-in Degree metric](/screenshots/communities-metrics-color-mapping.png)

**Node Color** paints nodes along a two-color gradient driven by a numeric
metric — pick the metric, the low/high colors and a scale, and *None*
returns to normal coloring. When a node has a value, the gradient color
**wins over community and type colors** (you turned it on explicitly;
community coloring is ambient) — nodes *without* a value keep their normal
color, which conveniently flags coverage gaps. Off by default.

**Edge Weight** works the same way for edges: pick an edge metric (e.g.
Edge Betweenness) and a width range, and edge thickness follows the
metric. Edges the metric has no value for keep the base width from the
Style panel.

The mapping is part of the graph's look, so
[style presets](./style-presets.md) and explorations save and restore it.
A restored mapping that names a metric not yet computed on the current
graph falls back to base sizing (or normal coloring) until that metric is
computed — the panel says so next to the select.

Metrics reach beyond the mapping tab: label templates and context-menu
actions accept `{metric:<name>}` and `{if:metric:...}` (see
[Labels](./labels.md) and [Context-menu actions](./context-menu-actions.md)),
cluster programs get a `metric()` lookup ([Clusters](./clusters.md)), and
the hive layout's *Axes by* / *Position by* selects accept metrics
alongside properties.

### Two honest caveats

- Algorithm metrics are **session-only**: they are not saved into
  explorations, and they are not recomputed automatically when the graph
  changes — a stale metric keeps its values until you delete or recompute
  it. ([Custom metrics](#custom-metrics) are the exception: their
  definitions are saved on the context and they recompute on their own.)
- Metrics compute over the loaded graph; the built-in Degree counts all
  loaded edges even when filters hide some of them.

## Custom metrics

![Custom tab of the Metrics panel](/screenshots/communities-metrics-custom.png)

The **Custom** tab of the Metrics panel lets a user with **write access**
to the context define new metrics as small JavaScript snippets, evaluated
once per node (or per edge) of the loaded graph. A custom metric may
produce a **number**, a **text** value or a **boolean** — so it doubles as
a *derived column*: a domain extracted from an e-mail, a category assigned
by regex, a ratio of two properties, or a structural score such as the
mean degree of a node's neighbours.

Definitions are saved on the context, so every writer sees the same set.
Each one has a **Run automatically when the graph loads** switch:

- **on** — the metric evaluates whenever the graph loads, whenever the
  loaded node/edge population changes, and when node properties arrive
  late; the card shows *auto*;
- **off** (the default) — it evaluates only when someone clicks
  **Recompute**, or when its author saves it. Until then the card reads
  *not computed*; once the graph changes under a computed manual metric it
  reads *stale* and keeps its old values until recomputed.

The list shows a status per metric (queued, running, done in *n* ms with
an item-error count, stale, or the error). A deployment can forbid
automatic runs altogether with
`GRAPH_LAGOON_CUSTOM_METRICS_AUTO_RUN_ENABLED=false`, or turn the whole
feature off with `GRAPH_LAGOON_CUSTOM_METRICS_ENABLED=false` — see
[Configuration](./configuration.md#custom-metrics).

### Who can see them

Only users with write access to the context (owner, "Read & Write" share,
or a superuser) receive the definitions — the API returns an empty list
to read-only users, so they never see a custom metric, its values, or the
code behind it. A shared label template or style preset that references
one simply falls back (a `[metric:name]` sentinel, base node sizing) for
them.

### Writing one

![Custom metric editor with a test run](/screenshots/communities-metrics-custom-editor.png)

A definition is the body of `function(item, ctx)`:

```js
// item  — the node: { id, type, properties }
//         or the edge: { id, relationship_type, src, dst, properties }
// ctx   — see below
// Return a number, a string or a boolean matching the metric's value type,
// or null when there is no value. Anything else becomes null.
const m = /@([^@\s]+)$/.exec(String(item.properties.email ?? ''));
return m ? m[1].toLowerCase() : null;
```

`ctx` gives structural access without any bookkeeping on your side:

| Member | Meaning |
|---|---|
| `ctx.degree` | This node's degree (nodes only) |
| `ctx.degreeOf(id)`, `ctx.neighbors(id)`, `ctx.outNeighbors(id)`, `ctx.inNeighbors(id)` | Adjacency, undirected `neighbors` deduped |
| `ctx.edgesOf(id)`, `ctx.hasEdge(src, dst)`, `ctx.isConnected(a, b)` | Edge lookups (directed / undirected) |
| `ctx.node(id)` | Another node's item, or `undefined` |
| `ctx.metrics` | `{ name: value }` of the built-in and algorithm metrics for this item |
| `ctx.metric(ref, id?)` | One metric value by algorithm id (`'pagerank'` → latest run), name or id; `id` defaults to this item |
| `ctx.community(id)` | Community id from the last detection, or `null` |
| `ctx.graph` | `{ nodeCount, edgeCount, meanDegree, density }` |
| `ctx.nodes`, `ctx.edges` | The whole loaded population (read-only) |
| `ctx.cache` | An object shared by every item of one run — do global work once |

Custom metrics never see other custom metrics (no ordering, no cycles).

### Examples

Text:

```js
// Full name from two columns, whitespace collapsed
const f = String(item.properties.first_name ?? '').trim();
const l = String(item.properties.last_name ?? '').trim();
return (f + ' ' + l).replace(/\s+/g, ' ').trim().toUpperCase();

// CNPJ formatted from digits
const d = String(item.properties.cnpj ?? '').replace(/\D/g, '');
return d.length === 14 ? d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5') : d;

// Entity kind by regex on the name
const n = String(item.properties.name ?? '');
if (/\b(LTDA|S\.?A\.?|EIRELI|ME)\b/i.test(n)) return 'company';
if (/^\p{Lu}\p{Ll}+( \p{Lu}\p{Ll}+)+$/u.test(n)) return 'person';
return 'unknown';

// Bucket by the latest PageRank run
const p = ctx.metric('pagerank') ?? 0;
return p > 0.01 ? 'hub' : p > 0.001 ? 'mid' : 'leaf';

// Edge: endpoint types
return `${ctx.node(item.src)?.type ?? '?'} → ${ctx.node(item.dst)?.type ?? '?'}`;
```

Numbers:

```js
// Mean degree of the neighbours
const ns = ctx.neighbors(item.id);
return ns.length ? ns.reduce((s, n) => s + ctx.degreeOf(n), 0) / ns.length : 0;

// Local clustering coefficient
const ns = ctx.neighbors(item.id);
if (ns.length < 2) return 0;
let t = 0;
for (let i = 0; i < ns.length; i++)
  for (let j = i + 1; j < ns.length; j++)
    if (ctx.isConnected(ns[i], ns[j])) t++;
return 2 * t / (ns.length * (ns.length - 1));

// Ratio with guards (never Infinity)
const r = Number(item.properties.revenue), e = Number(item.properties.employees);
return Number.isFinite(r) && e > 0 ? r / e : null;

// Percentile rank — the sort runs once thanks to ctx.cache
if (!ctx.cache.sorted) {
  ctx.cache.sorted = ctx.nodes.map(n => Number(n.properties.revenue)).filter(Number.isFinite).sort((a, b) => a - b);
}
const v = Number(item.properties.revenue);
if (!Number.isFinite(v)) return null;
const s = ctx.cache.sorted;
let lo = 0, hi = s.length;
while (lo < hi) { const m = (lo + hi) >> 1; if (s[m] <= v) lo = m + 1; else hi = m; }
return lo / s.length;

// Edge: Jaccard similarity of the endpoints' neighbourhoods
const a = new Set(ctx.neighbors(item.src)), b = ctx.neighbors(item.dst);
const i = b.filter(x => a.has(x)).length;
const u = a.size + b.length - i;
return u ? i / u : 0;
```

Booleans:

```js
return ctx.degree > ctx.graph.meanDegree * 2;          // super-hub
return /\.gov\.br$/i.test(String(item.properties.website ?? ''));
return ctx.hasEdge(item.dst, item.src);                 // edge is reciprocal
```

The editor's **Test on current graph** button runs a draft over the first
50 items and shows the values, how many items threw (with the first
error), and a hint when the returned type disagrees with the declared
value type.

Not sure how to write one? The **robot button** (in the Custom tab and
next to the code field) opens a copy-pasteable prompt for any AI
assistant — the same pattern as [label templates](./labels.md),
[context-menu actions](./context-menu-actions.md) and cluster programs. It
embeds this graph's types, properties and available metrics, the
`item`/`ctx` contract, the sandbox rules and worked examples, and asks the
AI to interview you first and then answer with a JSON block whose fields
(`name`, `target`, `value_type`, `description`, `code`) map onto the
editor.

### Importing and exporting

The AI's answer — or a file from another context — goes back in through
**Import JSON**:

- in the editor, it **fills the form** (name, target, value type,
  description, code) so you can review, test and save. When editing an
  existing metric the button reads **Edit as JSON** and the box starts
  with the metric's current JSON — tweak it (or paste a new version) and
  apply; the metric keeps its id and **Save** writes it back;
- in the Custom tab, it handles **several metrics at once**: a pasted
  metric with the same id — or, failing that, the same name — as an
  existing one **updates it in place**; the others are added.

Both accept the bare JSON object the AI answers with (a ```` ```json ````
fence is fine), an array of them, or the envelope written by **Export
JSON**. Export is available per metric (in the editor) and for the whole
context (Custom tab); the envelope records the schema of the graph it
came from, like style presets and context-menu actions.

Code from another graph usually names properties (`item.properties.x`)
or metrics (`ctx.metric('pagerank')`) this graph does not have. The import
box scans the code and lists them; the **Ask an AI to adapt it** button
then opens the robot prompt in *adapt* mode, with the old and the new
schema, asking the AI to rewrite the references and answer with JSON you
paste back.

### Where the values go

- **Data Table** — the *Table column* checkbox (on the card or in the
  editor). Unlike the session-only toggle of algorithm metrics, this one
  is **saved with the definition**, so the column is there for every writer
  on every load. Number metrics become numeric columns, text becomes a
  text column with its filter, booleans a true/false categorical column.
- **Node size / edge width** — numeric custom metrics appear in the
  Visual Mapping selects. Their id is stable (`custom:<id>`), so a style
  preset or exploration that references one keeps working after a reload.
- **Side panel and detail modal** — listed with the other metrics.
- **Labels and tooltips** — `{metric:<name>}` in any
  [label template](./labels.md#placeholders).

### Security notes

A custom metric is JavaScript written by one writer and executed in the
browser of every writer who opens the context. The code runs in a
**dedicated Web Worker** whose network, storage and messaging APIs
(`fetch`, `XMLHttpRequest`, `WebSocket`, `importScripts`, nested
`Worker`s, `indexedDB`, `caches`, `navigator`, `postMessage`…) are removed
before any user code executes; a definition that does not finish within
**10 seconds** has its worker terminated and is reported as timed out
while the others continue. The graph data handed to the code is frozen,
every returned value is coerced to the declared type (text capped at 500
characters), and the worker's replies are re-validated on the main thread.

Honest residual risks: the code can still burn CPU and memory inside its
worker until the timeout fires; `Function`/`eval` and `console` remain
available inside the (already stripped) worker scope; and the browser has
no Content-Security-Policy yet that would add a second fence. The
strongest guarantee is the visibility rule above — the code only ever runs
for users who could have written it themselves — and, since automatic
execution is opt-in per metric (and can be disabled server-wide), nothing
runs in another writer's browser unless a writer deliberately asked for
that.
