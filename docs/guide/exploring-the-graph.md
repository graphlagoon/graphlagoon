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
selection and camera controls, neighbor expansion, and export.

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
all. **Reset** clears types and search in one click. An edge hides
whenever either of its endpoints is hidden.

What search does with matches is a choice — **Behaviors → Search
Behavior**:

- **Highlight** (default): matches grow to 1.5×, everything else turns
  grey and shrinks. Nothing leaves the screen.
- **Hide**: non-matches disappear and drop out of the counts.

## Query Console

Canvas footer → **Query** opens a resizable bottom drawer for *tabular*
results — any projection is allowed, unlike the graph query path which
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

### Focusing on a subset of properties

When a context carries dozens of properties and an analysis needs three,
limit what the property surfaces show: **Style panel → Property Visibility**,
one allowlist for node properties and one for edge properties. It prunes
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

- **Click** a node or edge to select it — the side panel shows its
  details, metric values, and actions. Clicking a selected node again
  deselects it. **Ctrl + click** multi-selects. **Click empty space** or
  **Esc** clears.
- Selected nodes render at 1.5×. A clicked node also jumps to the front
  of the property-loading queue, so its details fill in immediately.
- The hint strip at the bottom of the canvas is the cheat sheet:

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
  connection summary.
- Node dragging (pin a node where you drop it) is off by default — enable
  it in **Behaviors**.

## Expanding neighbors

Three ways, same engine:

1. **Alt + Click** a node — quick expand at depth 1.
2. **Right-click → Expand neighbors** — same, from the
   [context menu](./context-menu-actions.md).
3. **Side panel → Expand from Node** — the full form: depth (1–2), edge
   limit (4–1000), directed-only, and an edge-type allow-list.

Results are **merged**: existing nodes keep their positions and only new
nodes and edges are added. On sources that can't expand (some REST
connections), the affordances are hidden rather than disabled. A failure
leaves the graph untouched and reports through the error modal.

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

- `N nodes · M edges` — counts of what's visible (filters applied).
- `loading properties…` — the graph drew before node properties finished
  loading; tooltips may be briefly empty. Clicking a node prioritizes it.
  This progressive load is controlled in **Behaviors → property loading**
  (`auto`, the default, uses it only when the node table is wide enough to
  pay off).
- `⚠ truncated` — the edge limit was hit and this is a **partial view**;
  conclusions drawn from it may not hold. Raise the limit or narrow the
  query.
- `precomputed: <name>`, `template: <name>`, `style: <name>`, and layout
  chips report which URL parameters shaped this view — each links to its
  own guide.
