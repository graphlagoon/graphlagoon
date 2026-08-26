# Explorations & Sharing

An investigation is more than a query: it's the nodes you expanded, the
layout you untangled, the filters, colors and labels that made the picture
readable, the communities you detected. An **exploration** captures all of
that under a name, gives it a shareable URL (`?exploration=<id>`), and
brings it back exactly as you left it — including node positions.

Nine other guides reference `?exploration=` links; this page is what those
links actually load.

![Explorations](/screenshots/explorations-list.png)

## Saving

Use **Save** in the toolbar. The button appears once there is something
worth saving — after a query has run (or an exploration is already loaded);
an empty canvas refuses with *"Cannot save an empty exploration. Execute a
query or expand nodes first."*

The title decides whether you overwrite or copy:

- **Same title as the loaded exploration** → updates it in place.
- **Any other title** → creates a new exploration owned by you. Titles are
  unique per context; a collision is rejected with *"An exploration named
  '…' already exists in this context"*.

On success the URL gains `?exploration=<id>` — the address bar is the
shareable link, immediately.

The toolbar shows the exploration's title next to the context name; before
the first save it shows an **Unsaved** badge instead. The badge means
*never saved*, not *has unsaved changes* — editing a loaded exploration
does not bring it back. Re-save when you want to keep new changes.

## What an exploration captures

| Saved | Details |
|---|---|
| The query | OpenCypher/SQL text plus its transpile and rendering options |
| The data | A snapshot of the visible nodes and edges **with their positions** — expanded nodes included |
| The look | Colors, icons, sizes, label templates, layout mode and settings (the same block a [style preset](./style-presets.md) carries) |
| Filters & viewport | Type and property filters, search, camera |
| Analysis | Cluster results and exploration-scoped cluster programs, communities, similarity state |
| Behaviors | Data-fetching preferences |

Not captured: the context definition itself, context-scoped cluster
programs (those are shared by every exploration in the context), query
templates, and your current selection.

Loading prefers the snapshot — that's what makes reopening instant and
keeps hand-arranged positions. If the snapshot is missing (or the
exploration predates snapshots), the saved query is re-executed instead and
a fresh snapshot is written back transparently.

## Loading

Three ways in:

- **Load** in the toolbar — lists the current context's explorations.
- The **Explorations** page — everything you can see across contexts,
  searchable and filterable by context, grouped with an *Open Graph*
  shortcut per context. Rows you don't own are badged with the owner and
  your access level (`Read only` / `Read & Write`); public ones carry a
  `Public` badge.
- A link: `/graph/<context-id>?exploration=<id>`.

## Sharing

Sharing needs database persistence (`database_enabled=true`). Without it,
explorations still save and load, but into an in-memory store that resets
on restart and has no sharing UI — see
[Databricks Integration](/guide/integration).

**Share** on an exploration you own opens the sharing modal:

- **Share with a person** — an email plus `Read only` or `Read & Write`.
  Write access lets them overwrite the exploration in place; they can
  always *Save* under a new title instead, which creates their own copy.
- **Share with my domain** (`*@your-company.com`) — one entry for
  everyone at a domain. Wildcard domains must be allow-listed by the
  operator via `GRAPH_LAGOON_ALLOWED_SHARE_DOMAINS` (see
  [Configuration](/guide/configuration)); the quick button only appears
  when your own domain is on the list. Individual emails never need the
  allow-list.
- **Make public** — shares with everyone, always **read-only**. Public
  write access does not exist by design; remove the *Everyone (public)*
  entry to unpublish.

Sharing an exploration also grants recipients enough access to open its
parent context — a shared link works even for someone the context was
never shared with.

### Who can do what

| Action | Owner | Write share | Read share / public | Superuser |
|---|---|---|---|---|
| Open / load | ✓ | ✓ | ✓ | ✓ |
| Overwrite (same title) | ✓ | ✓ | — | ✓ |
| Save as own copy (new title) | ✓ | ✓ | ✓ | ✓ |
| Share / unshare / publish | ✓ | — | — | ✓ |
| Delete | ✓ | — | — | ✓ |

One subtlety: write access to a shared exploration does not grant write
access to its context, so a cluster program created there is saved into
the exploration rather than the context.

## Combining with other URL parameters

`?exploration=` is a *data-choosing* parameter, and only one of those runs
per page load — two loads must not race for one canvas:

1. `?exploration=` wins over everything. A `?precomputed=` beside it is
   ignored with a console warning; a `?template=` beside either is ignored
   entirely.
2. Then `?style=<name>` applies **on top** of the look the exploration
   restored — the URL is the more specific instruction.
3. Then `?layout=` / `?layout.<mode>.<field>=` override layout fields
   last, field by field.

So a link like

```
https://<host>/graph/<ctx>?exploration=<id>&layout=ego&layout.ego.focusNodeId=n42
```

opens your saved investigation but centred as an ego view — the pattern
[context-menu actions](./context-menu-actions.md) use for "re-open from
this node" deep links. See [Query Templates →
Precedence](./query-templates.md#preset-precomputed-template-or-exploration)
for the full comparison of the four data sources.

## When something is wrong

- A deleted id, or one you have no access to, fails the page load with the
  *"Failed to load graph"* overlay and the server's message (404
  *Exploration not found* / 403). Unlike `?style=` or `?layout=`, a bad
  `?exploration=` does not silently fall back to a default load — you
  asked for a specific investigation, and getting a different one would be
  worse than an error.
- A missing snapshot is invisible: the saved query re-runs and the
  snapshot is rebuilt.
- Duplicate titles and empty-canvas saves are rejected inline in the save
  modal with the exact reason.

## When the context schema changes

Explorations reference property columns — in filters, label templates,
layouts, similarity settings. If the context's schema is later resynced
and columns disappear, nothing is rewritten: the schema-drift review lists
*"N references across M explorations"* that would dangle and asks for an
explicit confirmation, but saved explorations are never edited. A dangling
reference simply resolves to nothing when loaded.
