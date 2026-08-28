# Style Presets

::: tip TL;DR
A named look — colors, icons, labels, layout, property visibility, behaviors
— applied from the URL with `?style=<name>`. It changes how the graph is
drawn and read, never which data is loaded.

- **Use it when** a team wants a consistent, shareable look ("the
  investigation view") reusable across every graph of a context.
- **Not the tool for** choosing data (that's
  [precomputed graphs](./precomputed-graphs.md),
  [templates](./query-templates.md) or
  [explorations](./explorations.md)); tweaking one layout field per link
  ([layout URL overrides](./layout-url-overrides.md) do that without
  minting a preset per target); or one-off adjustments — just use the
  panels.
:::

A **style preset** is how a context's graph looks, saved under a name and
applied from the URL:

```
/graph/{context_id}?style=investigacao
```

It carries six things — **style** (colors, icons, aesthetics), **labels**
(text formatting), **layout** (algorithm, its parameters, 3D forces),
**visual mapping** (the
[metric-driven node size / edge width](./communities-metrics.md) mapping),
**property visibility** (which node/edge properties the
[tables and detail views](./exploring-the-graph.md#focusing-on-a-subset-of-properties)
show) and **behaviors** (the whole Behaviors panel: graph lens, degree
dimming, view mode, loading and interaction preferences) — and nothing about
which data is loaded. Applying one never changes which nodes and edges are on
screen, which is why it is safe on any graph in the context, before or after
that graph loads. A graph loaded afterwards inherits the look.

Deliberately excluded: nodes, edges, filters, the viewport, the query and its
transpile options, clusters, communities and similarity. A preset says how a
graph *looks and reads*, never which data it loads — the same split
[precomputed graphs](./precomputed-graphs.md) draw from the other side.
[Context-menu actions](./context-menu-actions.md) are also excluded: they are
context-level integration config shared by everyone on the context, not a
saved look.

Two consequences worth knowing:

- **Presets saved before visual mapping, property visibility and behaviors
  existed** still apply cleanly: they reset the visual mapping to its
  defaults and property visibility to "show all" (that is what their author
  saw), and leave your current behaviors untouched. A visual mapping that
  names a metric not computed on the current graph falls back to base sizing
  until that metric is computed.
- **Behaviors travel whole.** Applying a shared preset also applies its
  loading and interaction preferences (auto-load, progressive loading, node
  drag, …), replacing the context's defaults and your panel edits — exactly
  like the color maps. The Behaviors panel's Reset button takes you back to
  the context defaults.

## Saving, applying, deleting

Everything lives in one modal, opened by the **Presets** button inside the
Aesthetics panel — not a second toolbar button, and not inline in the
sidebar.

![The style preset modal: save the current look, apply or delete a saved one](/screenshots/style-presets-modal.png) A preset is not a setting you nudge; it is an occasional, deliberate
act, and a list plus a naming form would crowd a panel of sliders.

**Save current look as** — type a name and hit **Save**. Names follow the
same alphabet every named artifact in Graph Lagoon uses:
`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$` — "Letters, digits, `_` `-` `.` only, up
to 64, starting with a letter or digit." An optional description (up to 280
characters) helps whoever opens the list later. Saving a name that already
exists **overwrites** it — the modal warns first, and it keeps its original
author, so write access cannot be used to take over someone else's preset and
then delete it.

**Applying** one is a click in the saved-presets list and a `router.replace`
under the hood: the URL gains `?style=<name>`, so whatever look is on screen
is always a link someone else can open too.

**Stop using «name»** clears `?style=` from the URL without touching the
graph — the look reverts to whatever the canvas defaults to, and nothing is
deleted.

**Deleting** asks for confirmation (`Delete style preset "name"?`) and then
calls the API. A permission error is the *only* place a preset's author ever
surfaces in the UI — the listing itself deliberately carries no `created_by`,
since reading every file to build one would cost a request per preset.

**Copy link** builds the absolute URL for a preset and copies it, for sharing
a look without also sharing a specific graph.

A preset the URL names but that does not exist **changes nothing and does not
break the page** — the graph loads and stays fully usable, and the status bar
reports that the styling was not applied. This differs from a missing
`?precomputed=`, which leaves nothing to look at at all.

## Exporting and importing

A preset lives under one context. To carry a look to another context — or to
another Graph Lagoon instance — the modal exports it as a JSON file and
imports one back.

**Export** — the download icon next to a saved preset fetches it and downloads
`style-<name>.json`. **Export current look** (under the save form) does the
same for whatever the Style panel shows right now, saved or not. The file is
a small envelope around the settings:

```json
{
  "graphlagoon_export": "style-preset",
  "export_version": 1,
  "name": "investigacao",
  "description": "Fraud review look",
  "source": {
    "context_title": "Fraud ring",
    "node_types": ["Person", "Company"],
    "relationship_types": ["OWNS"],
    "node_properties": ["name", "cnpj"],
    "edge_properties": ["share"]
  },
  "settings": { "nodeTypeColors": { "Person": "#4f8cff" }, "...": "..." }
}
```

`source` records the schema of the graph the preset came from. The settings
themselves are exactly what the server stores; nothing about which nodes are
shown is included.

**Import** — the **Import JSON** toggle opens a box that takes the envelope, a
bare settings object (what an AI answers with), or a full preset as the API
returns it — pasted or picked with **Choose file…**. Then:

- **Apply only** puts the look on screen without writing anything. It works
  for read-only viewers too, and clears `?style=` from the URL, since the look
  no longer comes from a saved preset.
- **Save & apply** (write access) stores it under a name — prefilled from the
  envelope, editable — and applies it through `?style=<name>` like any other
  preset.

### When the preset came from a different graph

A preset keys colors and icons by type name and label templates by property
name. Imported from a graph with other names, it applies cleanly but does
nothing visible — no `Person` here to color. The Import box checks the pasted
preset against this graph's types and properties and lists what does not
match:

> This preset names things this graph does not have: node types: Person,
> Company · properties: cnpj

The **robot button** — the same Ask-AI helper the Labels and Actions editors
have — then switches to *adapt* mode. The prompt it generates carries the
exported preset, the `source` schema it came from, and this graph's real
types and properties, and asks the AI to show its old → new mapping before
rewriting the JSON. Paste the answer back into the Import box; the warnings
disappear when every name resolves.

## Who can do what

Three permission levels — one more than anywhere else in Graph Lagoon:

| Action | Who |
|---|---|
| Read | anyone with access to the context |
| Write (create or overwrite) | anyone with *write* access to the context |
| Delete | only the person who created that particular preset, or a superuser |

Unlike a [precomputed graph](./precomputed-graphs.md), which is superuser-only
to author, a preset is a few kilobytes of preference, not a published,
administered artifact — so ordinary write access is enough to save one.
Deleting is narrower on purpose: ownership lives inside the preset file
itself, per preset rather than per context, so one person's saved look cannot
be thrown away by another — not even by whoever owns the context.

## Composing with other features

The URL parameters compose, so one link can pin the data and its look
together:

```
/graph/{context_id}?precomputed=fraude-2024&style=investigacao
```

A preset also composes with **layout URL overrides** — field-by-field
adjustments to the layout a preset restored, so "the investigation look, but
centred on *this* account" costs no new preset. See
[Layout URL Overrides](./layout-url-overrides.md) for the grammar; the short
version is that the URL wins field by field over whatever the preset set, and
applying the override *after* the preset (not before) is what makes that true
— a preset replaces the whole layout block, so an override applied earlier
would be silently erased.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `GRAPH_LAGOON_STYLE_PRESETS_ENABLED` | `true` | `false` makes every preset endpoint answer 404. |
| `GRAPH_LAGOON_STYLE_PRESETS_DIR` | `./tmp/style-presets` | Local directory, used when no volume path applies. |
| `GRAPH_LAGOON_STYLE_PRESETS_VOLUME_PATH` | *(unset)* | Unity Catalog Volume path. Defaults to a `style-presets` subdirectory of `GRAPH_LAGOON_DATABRICKS_VOLUME_PATH` when that is set. |
| `GRAPH_LAGOON_STYLE_PRESETS_MAX_PER_CONTEXT` | `100` | Presets are listed in full for the picker, so the count is bounded here rather than paginated at read time. |

Entries live at `{root}/style/{context_id}/{name}.jsonz`, gzip'd JSON, with
the same name rules as a precomputed graph.

::: warning Multi-replica deployments
Without a volume path, each replica keeps its own copy of presets, so a
`?style=` link works intermittently. Set
`GRAPH_LAGOON_STYLE_PRESETS_VOLUME_PATH` (or
`GRAPH_LAGOON_DATABRICKS_VOLUME_PATH`) for any deployment that is not a
single process — the API logs a warning at startup when it detects this.
:::

## Unlike a precomputed graph, this is listable

A style preset has a normal `GET /api/graph-contexts/{id}/style-presets`
listing endpoint. [Precomputed graphs](./precomputed-graphs.md) deliberately
do not: their entries can be machine-written and unbounded, so enumerating
them is the one operation that does not survive scale. A preset is hand
-authored, there are only ever a handful per context
(`GRAPH_LAGOON_STYLE_PRESETS_MAX_PER_CONTEXT` bounds it at write time), and
choosing one means seeing what exists — so the listing stays complete and
honest rather than paginated.

## Preset, precomputed, template, or exploration?

| | Style preset | Precomputed graph | Query template | Exploration |
|---|---|---|---|---|
| **Stores** | how it looks | which nodes and edges | a parameterized query | graph, look and positions |
| **Scope** | the context | the context | the context | one user, plus shares |
| **Addressed by** | `?style=name`, overridden per field by `?layout…` | `?precomputed=name`, plus provider arguments | `?template=name`, plus `template.<param>=` values | `?exploration=uuid` |
| **Combines with** | any graph | any style | any style | — |

A preset and a precomputed graph are orthogonal on purpose: the same look
applies to any data, and the same data can be viewed in any look. See
[Query Templates](./query-templates.md#preset-precomputed-template-or-exploration)
for the full four-way comparison and the precedence rule when a URL carries
more than one data-choosing parameter.
