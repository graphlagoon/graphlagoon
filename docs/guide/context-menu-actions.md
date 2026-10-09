# Context Menu Actions

::: tip TL;DR
Custom entries in the right-click menu, configured once per context: open
a URL built from the clicked item's data (a web page, or a desktop app such
as VS Code or Claude Code), copy formatted text, or run a query template with
the item bound as a parameter.

- **Use it when** the clicked node should bridge to another system —
  PubMed for a gene, your CRM for an account, the source file in VS Code,
  a Claude Code session in the right repo — or when a curated query from
  *this* node should be one click away.
- **Not the tool for** bulk operations (an action sees exactly one
  clicked item); logic beyond the three kinds — for arbitrary JavaScript
  over the graph, use a [cluster program](./clusters.md) with a node
  binding. Configuring needs write access to the context; readers still
  get and use the menu.
:::

Right-clicking a node or an edge opens a context menu. Besides the built-in
entries (copy id, expand neighbors, …), a graph context can carry its own
**custom actions** — entries that appear only for the right kind of item and
do something with *that* item's data:

- open a PubMed search for the gene you clicked,
- copy `name <email>` of a person to the clipboard,
- run a saved query template with the clicked account bound as its parameter,
- re-open the current exploration with the ego layout centred on that node.

Actions are configured once per context and stored with it, so everyone who
opens the context gets the same right-click menu.

![The right-click context menu open on a node](/screenshots/context-menu-actions-menu.png)

## Configuring

Open the **Behaviors** panel and hit **Configure actions…** under *Context
Menu*. The entry point only appears if you have **write access** to the
context — readers still see and use the actions, they just cannot edit them.

Every action has:

- **A label and an optional emoji icon** — what shows in the menu.
- **A target** — nodes, edges, or both.
- **Type filters** — which node types (or relationship types) it applies to.
  Nothing checked means *all types*.
- **Property conditions** — optional, all must hold: `exists`, `not empty`,
  `equals`, `not equals`, `contains`. An action that interpolates
  `{prop:symbol}` into a URL should usually also require `symbol` *not empty*,
  so the entry hides instead of failing when the value is missing.
  The property may also be a session-computed metric, written as
  `metric:<name>` (e.g. `metric:PageRank` *not empty*) — the action then stays
  hidden until that metric is computed in the [Metrics
  panel](./communities-metrics.md), and reappears the moment it is.
- **A kind** — what clicking it does. Three kinds exist:

### Open URL

Builds a URL from the clicked item and opens it. The URL is a
[label-template](#templates) string:

```
https://pubmed.ncbi.nlm.nih.gov/?term={prop:symbol}
```

A web link (`https://`, `http://`) opens in a **new tab** or the **current
tab**. Any other scheme — `vscode://`, `claude-cli://`, `obsidian://`,
`mailto:` … — is an [app link](#app-links): the browser hands it to the
desktop app registered for that scheme.

Safety rules, enforced rather than suggested:

- The template must literally start with its scheme — a property value can
  never choose the scheme or which app opens.
- `javascript:`, `data:`, `file:`, `blob:`, `about:` and similar are rejected
  outright. They don't open an app: they run or render *inside* Graph Lagoon,
  for every reader of the context.
- Every interpolated value is URL-encoded before the template renders, so a
  property containing `&`, `?` or `/` cannot restructure the URL. Metric
  values get the same encoding.
- If a referenced property is missing (or not loaded yet), the action refuses
  to open a partial URL and says which property was missing. A `{metric:...}`
  ref whose metric is not computed aborts the same way, reported as
  `metric:<name>`.
- New tabs open with `noopener,noreferrer`.

### Copy text

Copies a templated string to the clipboard:

```
{prop:name} <{prop:email}>
```

The full label-template syntax works here — modifiers, conditionals, the lot.

### Run query template

Runs one of the context's [query templates](./query-templates.md), with the
clicked item's values bound to the template's parameters. Each parameter gets
an optional **binding** — a template string resolved against the clicked item,
usually just `{prop:account_id}` or `{node_id}`.

- All required parameters resolved → the template runs immediately, exactly as
  if you had filled and submitted its execute modal.
- A required parameter left unbound (or its property missing on this node) →
  the execute modal opens **pre-filled** with everything the click could
  resolve, and you complete the rest.
- Actions reference templates by id, so renaming a template does not break
  them. Deleting one hides the action until it is re-pointed.
- A `private` template is only ever sent to its owner — an action referencing
  it simply does not appear for anyone else. Prefer `shared` templates; the
  editor warns about this.

## Templates {#templates}

URL templates, copy-text templates and parameter bindings all use the same
mini-language as the Labels panel:

- `{prop:<column>}` — any raw column of the clicked node or edge.
- Node built-ins: `{node_id}`, `{node_type}`. Edge built-ins: `{edge_id}`,
  `{relationship_type}`, `{src}`, `{dst}`.
- `{metric:<name>}` — a session-computed metric of the clicked item (built-in
  degree, algorithm runs, custom metrics). Metrics only exist while computed
  in the session: a URL build aborts when the metric is missing, and
  copy-text renders the `[metric:<name>]` placeholder. Pair the ref with a
  `metric:<name>` *not empty* condition so the entry hides instead.
- Modifiers chain with pipes: `{prop:title|truncate:30:...}`,
  `{prop:code|split:_:0}`. Inside URLs prefer plain `{prop:x}` — values are
  encoded before modifiers run.
- Conditionals: `{if:prop:score>80|High|Low}` or
  `{if:metric:PageRank>0.5|hub|leaf}` (useful in copy-text).

## Deep-linking back into the tool

An *Open URL* action can point at Graph Lagoon itself. Combined with
[layout URL overrides](./layout-url-overrides.md), one right-click can re-open
the graph in a different arrangement:

```
https://<host>/graph/<context-id>?exploration=<id>&layout=ego&layout.ego.focusNodeId={node_id}
```

— "open this saved exploration with the ego layout centred on the node I
clicked", in the current tab.

One thing to keep in mind: layout parameters only style what the link
**loads**. A bare graph URL opens an empty view, so an in-tool deep link must
also carry one of:

- `?exploration=<id>` — a saved exploration,
- `?precomputed=<name>&<args>` — a [precomputed graph](./precomputed-graphs.md),
  where an argument like a seed can itself be `{node_id}`,
- `?template=<name>&template.<param>=…` — auto-run a
  [query template](./query-templates.md).

## Opening desktop apps {#app-links}

An *Open URL* action whose template starts with anything other than
`http(s)://` is an **app link**. Clicking it does not open a tab: the browser
asks "Open *&lt;app&gt;*?" and passes the URL to the app that registered the
scheme on the **clicking user's machine**. The graph stays open behind it.

Any scheme works. Graph Lagoon does not keep a list of apps, so you choose
which app the action opens:

| Opens | Template |
| --- | --- |
| A file at a line in VS Code | `vscode://file/home/me/repo/{prop:path}:{prop:line}` |
| Claude Code in a terminal, in the right repo, prompt pre-filled | `claude-cli://open?repo=acme/payments&q=Explain%20{node_id}` |
| A Claude Code tab inside VS Code | `vscode://anthropic.claude-code/open?prompt=Explain%20{node_id}` |
| The same file in Cursor | `cursor://file/home/me/repo/{prop:path}:{prop:line}` |
| A note in Obsidian | `obsidian://open?vault=kb&file={prop:note}` |
| An email draft | `mailto:{prop:email}?subject=About%20{prop:name}` |

Things that behave differently from web links:

- **Install the app first.** If nothing on the machine has registered the
  scheme, the click does nothing. Claude Code registers `claude-cli://` the
  first time you send a prompt in an interactive session; see Anthropic's
  [deep-link docs](https://code.claude.com/docs/en/deep-links).
- **No new tab / current tab choice.** The editor hides it for app links.
- **Encode the literal text yourself.** Values from the graph are URL-encoded
  automatically, but text you type into the template is not. Write a space as
  `%20` and a line break as `%0A` in a `q=` or `prompt=` parameter.
- **Slashes inside values arrive as `%2F`.** Apps that decode the URL, such as
  VS Code, handle that fine. Put the fixed folder in the template and
  interpolate the path relative to it. If the column holds absolute paths,
  remove the encoded leading slash with
  `vscode://file/{prop:path|replace:/^%2F/:}:{prop:line}`.

**Who decides.** The app an action opens is chosen by whoever can
[edit the context's actions](#storage-and-permissions): the owner and write
shares. Graph Lagoon trusts that author. Readers only click, and the browser
asks them before any app launches. Grant write access with that in mind.
The data is still never trusted: a node's properties cannot change the scheme.
They can still put text into a prompt, though. Claude Code pre-fills a
`claude-cli://` prompt without sending it and flags it as coming from an
external link. Read the prompt before you press Enter.

## Asking an AI to write actions

The robot button in the editor's header generates a copy-pasteable prompt for
any AI assistant. It embeds this context's node/edge types, properties and
query templates plus the exact JSON contract, and instructs the AI to
interview you first ("which properties hold external ids?", "new tab or
current?") before producing anything.

The AI's final answer is a JSON array — paste it into the editor's **Import
JSON** box and the actions are added after validation (unknown kinds, bad
operators and `javascript:`/`data:`/`file:` URL templates are rejected with a
pointed error).

## Exporting and importing

**Export JSON** in the actions list downloads every configured action as
`actions-<context>.json` — available to read-only viewers as well, since
reading the actions is not editing them. The file wraps the array in the same
envelope style presets use, with a `source` block describing this graph
(types, properties, and the query templates the actions may reference):

```json
{
  "graphlagoon_export": "context-menu-actions",
  "export_version": 1,
  "source": {
    "context_title": "Fraud ring",
    "node_types": ["Person", "Company"],
    "relationship_types": ["OWNS"],
    "node_properties": ["name", "cnpj"],
    "edge_properties": [],
    "query_templates": [{ "id": "…", "name": "Neighbors", "parameters": ["person"] }]
  },
  "actions": [ { "kind": "open-url", "label": "…" } ]
}
```

**Import JSON** accepts that file (pasted or via **Choose file…**) as well as
the bare array an AI produces. Before anything is added, the box compares the
actions with this graph and lists every node type, relationship type,
property and `templateId` it does not have — the sign that they were written
for another graph. Template ids are per context, so a `run-query-template`
action never survives an export unchanged. Metric refs (`{metric:...}` or
`metric:<name>` conditions) are listed too, but only as a heads-up: metrics
are session-computed, so the import is never blocked — the actions simply
stay dormant until the metric is computed here.

The robot button then switches to *adapt* mode: its prompt includes the
pasted actions, the `source` schema they came from, and this graph's real
types, properties and templates, and asks the AI to propose the old → new
mapping (including which of this context's templates replaces each old one,
or which actions to drop) before answering with the rewritten array.

## Storage and permissions

Actions live in the graph context itself (an opaque JSON document, like
cluster programs), so they follow the context's sharing:

| Access | Sees actions in the menu | Edits them |
| --- | --- | --- |
| Owner / write share | yes | yes |
| Read share | yes | no |

Edits save automatically (debounced) and survive reloads in both the
in-memory dev setup and the PostgreSQL one — `make migrate` applies the
`context_menu_actions` column on existing databases.
