# Exploring the Graph

::: tip TL;DR
The daily loop: **filter** what you see → **query** for more → **inspect**
the rows behind the picture → **export** what you found. Filtering hides
without re-running the layout; the Query Console is for tabular results
while the graph query panel draws; cancel genuinely frees warehouse
compute; and the status bar tells you when the view is partial
(`⚠ truncated`) — trust it before drawing conclusions.
:::

This page covers the Filters panel, the Query Console, the Data Table,
selection and camera controls, neighbor expansion, and export. To put graphs from several contexts on one canvas,
follow money across them and record evidence, open them in an
[investigation](./investigations.md); its **Sum parallel edges** and
**Width by amount** switches (Aesthetics → Edges) work in any graph whose
context names an [amount and a time](./investigations.md#amount-and-time).

![Filters](/screenshots/exploring-the-graph-filters.png)

## Filters

Toolbar → **Filters**. Three sections:

- **Search** — matches node ids and node types (case-insensitive
  substring).
- **Node Types** — one checkbox per type, with the same color swatch the
  canvas uses. Unchecking hides that type immediately.
- **Edge Types** — the same, per relationship type.

**Filtering hides; it never re-runs the layout.** Hidden nodes keep their
positions, counts and tables update, and re-checking the box brings
everything back exactly where it was. All boxes checked means no filter at
all. **Reset** clears types, search and any [show only](#show-only) in one
click. An edge hides whenever either of its endpoints is hidden. Closing the
panel keeps the filter: the status bar says **Filtered: N types hidden ✕**,
and reopening the panel shows which boxes are unchecked. If the filters hide
every node, the canvas says so and offers **Clear filters**. **Escape** inside
any panel of the left dock closes it.

What search does with matches is a choice — **Behaviors → Search
Behavior**:

- **Highlight** (default): matches grow to 1.5×, everything else turns
  grey and shrinks. Nothing leaves the screen.
- **Hide**: non-matches disappear and drop out of the counts.

### Show only

To look at one part of the graph without losing the rest of the layout,
**show only** it:

- click a community or cluster in the **Clusters** panel, or in its legend
  over the canvas (Shift+click adds another);
- right-click a node → **Show only this community** / **Show only this
  cluster**;
- a context's own right-click actions of the kind **Show only nodes with…**
  ([context-menu actions](./context-menu-actions.md#show-only-nodes-with)) —
  e.g. the accounts of the same branch as the one you clicked.

Every other node hides (the selected node always stays). The status bar
says **Showing only: …**; its **✕**, or right-click → **Show all nodes**,
brings everything back. It is saved with the exploration.

## Query Console

Canvas footer → **Console** opens a resizable bottom drawer for *tabular*
results (drag its top edge; the Console and the Data Table each remember their
height in this browser, and start at no more than half the window) — any projection is allowed, unlike the graph query path which
must return edges. Run with the **▶** button or **Ctrl/⌘ + Enter**.

- **OpenCypher | SQL tabs.** After a Cypher run, the SQL tab always shows
  the *actually executed* transpiled SQL — never stale text. On a REST
  connection the tab is named after the connection's own query language
  and SQL is absent.
- **Run / cancel / progress.** Fast queries return inline. Longer ones
  show a spinner with an elapsed timer and a **Cancel** button — cancel
  genuinely releases warehouse compute, not just the browser request.
- **Results** render in a virtual-scrolled grid with per-column filters
  and sorting; `NULL` renders as grey italic to distinguish it from an
  empty string. Export as **CSV** or **Copy** (TSV to clipboard). The
  footer shows `N rows · M cols · X ms (transpile Y ms)`.
- **Rows link back to the graph.** A column matching the context's node id
  column (or `node_id` / `~id`) renders as a clickable link that selects
  and focuses that node; Ctrl/⌘/Shift-click multi-selects. The detection
  reads column *names*, so `RETURN n.node_id AS x` won't activate it.
- **Errors** show an error-code badge inline; **Details** opens the full
  modal with the failing query, stack trace, copy buttons, and a *Review
  schema* shortcut.
- **Save** turns the query into a reusable
  [query template](./query-templates.md). Whether a template renders as
  graph or table is chosen when it is *run*, not when it is saved.

The **⚙ gear** opens the transpile & optimization settings shared with the
graph query panel: Procedural BFS (on by default) with its per-strategy
optimization flags, CTE fallback on error (a failed procedural run retries
once in `WITH RECURSIVE` mode — with toasts, unless silent fallback is
on), materialization strategy, and large-results mode.

## Data Table

Canvas footer → **Table**. Where the Query Console shows arbitrary query
results, the Data Table mirrors **the graph currently on screen** — the
same nodes and edges, as rows. The two drawers are mutually exclusive.

- **Nodes / Edges tabs** with counts; columns for id, type, and every
  property present; all sortable; virtual scrolling instead of pagination.
- **Per-column filters** (the funnel in each header) adapt to the column:
  date picker, number input, multi-select for categorical values, text
  otherwise.
- **Table filters drive the canvas**: filtering rows hides everything else
  in the graph too, so the picture and the table always agree. Clearing,
  switching tabs, or closing the table restores the full graph.
- **Row click** selects in the graph and focuses the camera
  (Ctrl/⌘/Shift-click multi-selects). **Double-click a cell** to see the
  full untruncated value with a copy button.
- **CSV** exports the current tab, respecting active filters.
- Computed **metrics and communities can join the table** as extra
  columns — see
  [Metrics in the Data Table](./communities-metrics.md#metrics-in-the-data-table).

### Focusing on a subset of properties

When a context carries dozens of properties and an analysis needs three,
limit what the property surfaces show: **Style panel → Property Visibility**,
one allowlist for node properties and one for edge properties. (This is about
*which properties exist for you*; to drop the ones that merely have no value on
the item you are looking at, see [hiding empty values](#hiding-empty-values).) It prunes
every place properties are *displayed* — the Data Table, the community and
cluster node tables, **Open details**, and the side panel — and the CSV
export follows the visible columns.

![The Property Visibility picker in the Style panel, and the pruned Data Table with its "Showing N of M properties" hint](/screenshots/exploring-the-graph-property-visibility.png)

Wherever something is hidden, the surface says so: a
**"Showing N of M properties · Show all"** hint, where **Show all** clears
the allowlist in one click. So a pruned table can never be mistaken for
missing data. Two things to know:

- The allowlist never touches configuration pickers, label templates,
  query autocomplete, or [filters](#filters) — those always see every
  property. It changes what is displayed, not what exists.
- Changing the allowlist rebuilds the table's columns, which resets any
  active per-column filters on that tab.

The subset is part of the *look*: saving a [style preset](./style-presets.md)
captures it, so `?style=<name>` can hand a whole team the same focused view,
and explorations restore it like everything else.

### Hiding empty values

A sparse table is the normal case: most columns are filled for some rows and
blank for others, and a metric that failed to compute for one node has no value
there. Rendering those anyway turns the detail views into a wall of `null` and
`—` that buries the three fields you were actually reading.

So **Hide empty properties and metrics** (**Style panel → Details Display**) is
**on by default**. It omits, in **Open details** and the side panel, any
property or metric whose value is nothing:

| Hidden | Kept |
|---|---|
| `null`, missing | `0` and `false` — a result, not an absence |
| blank text (`""`, spaces) | the literal text `null`, `N/A`, `-` — somebody stored that |
| an empty list or object | a list or object with anything in it |
| a metric that failed (`NaN`) | every other number |

![The "Hide empty properties and metrics" switch in the Style panel](/screenshots/exploring-the-graph-hide-empty-values.png)

The same promise as the allowlist holds: wherever something is hidden, the
surface says so, with an **"N empty hidden · Show"** hint above the pruned list
— one on Properties, one on Computed Metrics. **Show** reveals them for that
one item only; picking a different node or edge goes back to hiding, and the
switch itself stays where you left it. A section never disappears because
everything in it was empty — the hint stays, so you can always tell "no data
here" from "no such field".

Two things it deliberately does not touch:

- **Copy and export.** **Copy All (JSON)**, the per-row **Copy** buttons and the
  CSV export always write every value, empty ones included. The setting is a
  view, never a data loss.
- **Everything else.** The data table, filters, label templates and queries are
  unaffected; use the allowlist above for those.

Like the allowlist, it is part of the *look*: style presets and explorations
carry it.

- **Click** a node or edge to select it — the side panel shows its
  details, metric values, and actions. Clicking a selected node again
  deselects it. **Ctrl + click** multi-selects. **Click empty space** or
  **Esc** clears.
- Selected nodes render at 1.5×. A clicked node also jumps to the front
  of the property-loading queue, so its details fill in immediately.
- **? Shortcuts** in the status bar (and **About**) is the cheat sheet:

| Shortcut | Effect |
|---|---|
| `Alt` + Click | Expand the node's neighbors (depth 1) |
| `X`/`Y`/`Z` + Drag | Rotate the camera about that axis (in 2D, plain drag rotates) |
| `Shift` (hold) | Blower — push nodes away from the pointer; `Ctrl` is the vacuum |
| `Space` + `L` | Scramble and re-run the layout |
| `Space` + `C` | Reset orientation and zoom to fit |

Shortcuts apply while the pointer is over the canvas.

- **3D | 2D** — 2D is the default (lighter simulation, less overdraw): it
  flattens the layout and locks an orthographic camera. Planar layouts
  (ego, hive, community radial) switch to 2D automatically and restore
  your mode afterwards.
- **Fullscreen** uses the browser's native fullscreen; the details panel
  floats over the canvas there. **Info** shows the context's schema and
  connection summary. **Fit** frames the whole graph.
- Node dragging (pin a node where you drop it) is off by default — enable
  it in **Look → Behaviors**.
- **Look**, in the top bar, is where the graph's appearance lives: the
  **Style** tab (colors, icons, sizes, property visibility), **Labels**
  (templates and rules), **Behaviors** (interaction, loading) and **Presets**
  (the same look under a name, see [Style Presets](./style-presets.md)). One
  panel, four tabs — the same panel a [case](./investigations.md#the-workspace)
  uses for its canvas.
- **Default focus**, in the details panel of a selected node, makes the
  exploration open selected and centred on that node once saved (the
  [exploration](./explorations.md#what-an-exploration-captures) also keeps
  the camera you left it with).

## Expanding neighbors

Two ways, same engine:

1. **Alt + Click** a node — quick expand at depth 1.
2. **Right-click → Expand neighbors** — same, from the
   [context menu](./context-menu-actions.md).

Results are **merged**: existing nodes keep their positions and only new
nodes and edges are added. On sources that can't expand (some REST
connections), the affordances are hidden rather than disabled. A failure
leaves the graph untouched and reports through the error modal.

**A node with many edges asks first.** Expanding counts the node's edges in
the source before loading anything. Up to 50, they all load at once. Above
that a dialog lists them by relationship type, incoming and outgoing, with a
**Load up to** limit (at most 1000): untick the types you don't need, then
**Expand**. The node's own edges load first; whatever room the limit leaves
goes to links among its neighbours.

When an expand stops before every edge of the node is on the canvas:

- a toast says where it stopped — `Expand stopped at 150 edges (150 of its
  380 edges are on the canvas)`;
- the node carries a mark under it, `150 of 380 loaded`, until the rest
  arrives (expand it again) or you run a new query.

Counting needs the source to support it: SQL warehouse, Neptune and file
contexts do. On a REST connection expanding works as before, and still warns
when it was cut.

## A node's neighbours

Selecting a node shows a **Neighbors** section in the side panel, counted
from what is loaded:

- one row per relationship type, direction and neighbour type —
  `SOCIO_DE <- Person  269` — with **select** (select them on the canvas) and
  **group** (fold them into one closed [cluster](./clusters.md));
- `Linked to nothing else: 356 · with another link: 24 select` — the second
  number is usually the one the investigation is about, and **select** puts
  exactly those on the canvas selection;
- after a cut [expand](#expanding-neighbors), how many of the node's edges in
  the source are loaded (`380 of 1 200 edges loaded`);
- **Group leaf neighbors** (also on the node's right-click menu): one closed
  cluster per kind of neighbour linked to nothing else, from 5 members up.
  Neighbours with another link stay on the canvas. A member that later gains
  another link (an expand brought it) leaves its collection and a toast says
  so; **Pull out** in the cluster's member table takes one out by hand, and it
  stays out if you group again. **Ungroup leaf neighbors** puts them all back.
  Collections are saved with the exploration.

"Linked to nothing else" means among the loaded nodes: a neighbour may have
links you have not expanded yet.

## Hubs with many leaves

::: tip TL;DR
**Layout → Hubs with many leaves** lays the nodes linked only to a hub right
next to it, in a crown or in one petal per group, each with a count.
**Use it when** one node has hundreds of direct neighbours (a company's
partner register, an account with many counterparties) and the force layout
turns them into an unreadable disc. **Not the tool for** reducing what is
drawn — every node stays on the canvas; to fold a group into one node, use
[clusters](./clusters.md).
:::

![A company with 300 partners, petals by role](/screenshots/exploring-the-graph-hub-leaves.png)

A **leaf** is a node whose only neighbour, among the nodes loaded, is the hub.
Leaves carry no structure of their own, so the simulation has nothing to say
about where they go: they end up as a disc around the hub that hides how many
there are and of what kind. The partners that also hold *another* company are
not leaves; they stay where the simulation puts them, and with this option on
their edges are the only ones left around the hub — usually exactly the ones
the investigation is about.

| Setting | What it does |
|---|---|
| **Free** (default) | Nothing changes. |
| **Crown around the hub** | All leaves on one spiral around the hub, labelled `N leaves`. |
| **Petals, one per group** | One disc per value of **Group leaves by**: **Automatic** (the default; see below), node type, relationship type, a node property, or a property of the edge to the hub (a partner's role, for example). Largest group first; leaves without the value form their own `(no value)` petal. At most 8 petals: past that, the smallest groups share one, labelled `N other values (count)`. Edge properties are only there when the edges came from a Cypher query: opening a context and *Expand neighbors* load edges without their properties, so every leaf would land in `(no value)` — group by a node property instead. |
| **Hub: at least this many leaves** | A node counts as a hub from this many leaves on (10 by default). |
| **Don't draw hub–leaf edges** | On by default: the position already says who the leaf belongs to. The edges come back when you hover or select the leaf or the hub. |
| **Reveal leaves on zoom** | Off by default. Zoomed out, each region keeps only its inner leaves and its label adds `+N hidden`; zooming in brings the rest back, a step at a time. No node moves, and a selected leaf always stays. |

**Automatic grouping** looks, for each hub, at every key the loaded graph
offers — node type, relationship type, each node property, each property of
the edge to the hub — and takes the one that splits that hub's leaves best:
most leaves with a value, split as evenly as possible into at most about 8
groups. A property with one value per leaf (a name, a document number) never
wins, nor one that puts almost every leaf in the same group. Two hubs may be
grouped by different keys; the panel says which ones it took (`grouped by
qualificacao`).

What to expect:

- **Nothing is hidden** unless you turn on *Reveal leaves on zoom*. The node
  count does not change and every leaf is selectable, coloured and sized
  like any other node. While the hub edges are not drawn the status bar says
  so — `292 hub edges not drawn ✕` — and ✕ draws them again, so a screenshot
  never passes them off as absent. With *Reveal leaves on zoom* on, the
  regions say `+N hidden` and the status bar `N leaves hidden until you zoom
  in ✕`; ✕ turns it off.
- **2D only.** In 3D the panel offers to switch.
- **Force layout only.** Ego, hive and the layered layouts place every node
  themselves. The ego layout has its own answer, below; the *Don't draw
  hub–leaf edges* setting and its threshold apply there too.
- **Far away, an icon node is a dot.** Below about 7 pixels on screen the
  icon's glyph would be noise, so the node is drawn as a plain disc of its
  colour; the icon comes back above about 9 pixels (two thresholds, so a
  camera resting in between does not make it flicker). This applies to every
  node with an icon, not only to leaves.
- **Leaves follow their hub.** Dragging the hub carries its leaves; a leaf
  dragged away goes back to its place.
- **"Leaf" means in what is loaded.** A partner that is a leaf here may have
  other links in the source that you have not expanded yet.
- The setting is a behavior: it is saved with the exploration and in a
  [style preset](./style-presets.md), and a context can turn it on for
  everyone with `default_behaviors`, for example
  `{"hubLeaves": "petals", "hubLeavesKey": "edge:role"}` (`"auto"` for
  automatic grouping; `"hubLeavesRevealByZoom": true` to reveal on zoom).

## Ego layout with a crowded ring

![Ego layout of a company with 300 partners, sectored by type](/screenshots/exploring-the-graph-ego-crowded.png)

When the focus of an [ego layout](./layout-url-overrides.md) has hundreds of
direct neighbours, ring 1 used to grow into one huge circle of tiny nodes.
Now:

- **Crowded rings wrap into bands** (*Wrap crowded rings into bands* in the
  Layout panel, on by default). Neighbours with further links take the inner
  band, nodes linked only to their parent go to the outer bands. The angle of
  every node is unchanged, so ring ordering and sectors mean the same thing;
  only the radius changes. The ring caption says how many bands it has —
  `1 (380, 12 bands)`.
- **Sectors get a caption with their count** when *Ring ordering* is *Sector
  by type* or *by property* (`Socio (153)`), so the ring answers "how many of
  each" at a glance. A crowded ring 1 shows a hint in the panel with a
  shortcut to sector it.
- **Spokes to the focus's leaves are not drawn** when *Don't draw hub–leaf
  edges* is on (the default) and the focus has at least as many leaves as the
  hub threshold — the ring already says they are one hop away. The status bar
  says how many (`356 hub edges not drawn ✕`); hover or select a node to see
  its spoke, or ✕ to draw them all.
- A focus hidden inside a closed [cluster](./clusters.md) centres the rings on
  the cluster; a closed cluster takes one slot on its ring.

The layout stays deterministic: the same graph and settings always give the
same picture.

Labels of same-size nodes now appear a few at a time as you zoom in, the
largest and closest first, instead of all at once at one zoom level.

## Deleting nodes and edges

Right-click a node or an edge → **Delete from graph**. If the clicked item
is part of the selection, the whole selection goes: its nodes, its edges,
and every edge touching a deleted node. A toast says what went and offers
**Undo**.

The deletion only changes what's on the canvas. On an exploration, the
toolbar marks it as changed and **Save** makes it stick; reopening without
saving brings the nodes back. Items you drew or imported yourself
(**your data**) keep their own **Remove from your data** item, which saves
right away. A case's canvas doesn't offer this, because a case has its own
items.

A saved exploration can also lose nodes and edges without opening it:

- **REST** — `POST /api/explorations/{id}/remove` with
  `{"node_ids": [...], "edge_ids": [...], "expected_revision": N}`. It needs
  write access to the exploration and the `exploration.save` permission. See
  [REST API](./rest-api.md#delete-nodes-and-edges-from-an-exploration).
- **MCP** — `edit_exploration` with `remove_node_ids` / `remove_edge_ids`
  (see [Agents & MCP](./agents-mcp.md)).

Both delete for good, from the saved graph and from your layer. A page that
has the exploration open picks up the change within seconds.

## Export

Toolbar → **Export**:

- **PNG** — the current view at 1–4× resolution (default 2×), white or
  transparent background. It renders exactly what's on screen at the
  current camera. Very large viewports at 4× may be clamped by the GPU's
  maximum render size.
- **JSON** — the **full loaded graph** (`{ nodes, edges }`), regardless of
  active filters. For filtered, tabular exports use the CSV buttons in the
  Data Table or Query Console instead.

## Reading the status bar

The strip under the canvas is the graph's honesty panel:

- `N nodes · M edges` — counts of what's visible (filters applied). When the
  filters or a show only hide part of what was loaded it reads
  `shown of loaded nodes` (for example `24 of 46 nodes`).
- `Filtered: … ✕` — the Filters panel hides some node or edge types (or, in
  *Hide* search mode, the non-matches); ✕ clears it.
- `loading properties…` — the graph drew before node properties finished
  loading; [tooltips](./labels.md#hover-tooltips) may briefly show `[prop:x]`
  sentinels. Hovering or clicking a node prioritizes it.
  This progressive load is controlled in **Look → Behaviors → property loading**
  (`auto`, the default, uses it only when the node table is wide enough to
  pay off).
- `N hub edges not drawn ✕` — [hubs with many leaves](#hubs-with-many-leaves)
  has its leaves next to the hub and their edges to it left out of the
  drawing; ✕ draws them.
- `N leaves hidden until you zoom in ✕` — *Reveal leaves on zoom* is on and
  the camera is far enough to hide the outer leaves of each hub region; ✕
  shows them all.
- `Showing only: <group> ✕` — a [show only](#show-only) is hiding the other
  nodes; ✕ shows them again. Hover it for how many nodes it keeps.
- `⚠ truncated` — the edge limit was hit and this is a **partial view**;
  conclusions drawn from it may not hold. Raise the limit or narrow the
  query.
- `precomputed: <name>`, `template: <name>`, `style: <name>`, and layout
  chips report which URL parameters shaped this view — each links to its
  own guide.

## Adding to a case from the graph

With a **current case** picked in the top bar (the case chip), right-click a
node → **Add selection to case**, or **Add to case** in the node's details
panel (it reads **Add N to case** when several nodes are selected, and the
panel title shows **· N selected**). The selection, its edges and the look on
screen become one item of the case; the message names what went in and
**View** opens the case. With no current case the same actions open the case
chip's picker instead of doing nothing. See [Investigations](./investigations.md).

