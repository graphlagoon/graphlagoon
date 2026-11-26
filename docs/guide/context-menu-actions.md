# Context Menu Actions

::: tip TL;DR
Custom entries in the right-click menu, configured once per context: open
a URL built from the clicked item's data (a web page, or a desktop app such
as VS Code or Claude Code), copy formatted text, run a query template with
the item bound as a parameter, or show what a query returns for the item as
a table (its transactions, the accounts 2 hops away) without leaving the graph.

- **Use it when** the clicked node should bridge to another system —
  PubMed for a gene, your CRM for an account, the source file in VS Code,
  a Claude Code session in the right repo — or when a curated query from
  *this* node should be one click away.
- **Not the tool for** bulk operations (an action sees exactly one
  clicked item); logic beyond the kinds below — for arbitrary JavaScript
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
- list the transactions of the accounts linked to the company you clicked,
  in a table, with the period as a filter you can change,
- re-open the current exploration with the ego layout centred on that node.

Actions are configured once per context and stored with it, so everyone who
opens the context gets the same right-click menu.

![The right-click context menu open on a node](/screenshots/context-menu-actions-menu.png)

## Hiding built-in entries

Some of the menu's own entries may be ones you never use, such as **Copy
ID**, **Ego layout from here** or **Delete from graph**. Open **Look →
Behaviors → Context Menu → Built-in items** and uncheck them. Anyone can do
this; it needs no write access to the context.

The choice is a behavior (`hiddenMenuActions`, a list of entry ids), so it is
saved the same way as the other behaviors:

- in your [explorations](./explorations.md) and
  [style presets](./style-presets.md);
- for everyone opening the context, in its `default_behaviors`, which uses
  the existing column, so nothing needs migrating:

```json
{ "hiddenMenuActions": ["copy-id", "ego-layout-focus", "delete-from-graph"] }
```

An entry only appears where it applies (for example, **Show only this
community** only after a detection run), and hiding takes priority over
that. Custom actions have their own on/off switch (below), and cluster
programs have *Show in context menu* (see [Cluster Programs](./clusters.md)).

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
- **A kind** — what clicking it does. Six kinds exist:

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

### Show the result as a table {#table-result}

A query template action has a **Result** choice: *Graph* (the default above)
or *Table*. A table action runs the template for the clicked item on the
server and opens the rows in a window; the graph on the canvas stays as it is.
Use it for data that has many rows per item, which a node property cannot
hold: an account's transactions, a person's addresses over time, the
accounts around a company.

![A table action: the accounts 2 hops from the clicked company](/screenshots/context-menu-actions-table.png)

- **Filters are the template's parameters.** The window shows them with the
  values the click bound, and you change one (the period, a minimum amount,
  the node type) and press *Run*. Nothing is special about dates: anything the
  template's `WHERE` reads from a parameter is a filter.
- **Neighbors are reached in the query**, with the context's own edge table,
  so the result includes every neighbor in the warehouse, not only the nodes
  loaded on the canvas. Data from enrichment tables works the same way: the
  template may read any table the context authorizes.
- **Rows that are node ids** (the context's node id column, or `node_id`)
  are links: clicking one selects and focuses that node when it is on the
  canvas.
- **The grid** sorts, filters per column, searches and exports CSV. It shows
  up to 10,000 rows; when there are more, it says so and offers to load up to
  100,000. *Add to case* keeps the rows as a table of the current case, with
  the action, the template and the values as provenance.
- **Values from the item must be plain**: a bound value with a quote,
  backslash, backtick, `;` or `$` is refused (the template splices values as
  text), and the parameter is marked so you can change it.
- **On a case canvas** table actions work too (graph-replacing template
  actions do not): the ids sent are those of the source graph, not the case's
  merged ones — a node's id, and an edge's id and both ends. An edge or node
  that does not come from the canvas's context does not offer them.
- **Agents** can run them as well: the MCP tools
  [`list_entity_actions`](./agents-mcp-tools.md#list-entity-actions) and
  [`run_entity_action`](./agents-mcp-tools.md#run-entity-action) list the
  table actions that apply to an entity of a case and run one, so what you
  configure for people is a tool for the agent too.

Two recipes, as SQL templates (`$name` is a parameter):

```sql
-- "Transactions of this account, last N days": bind account to {node_id}
SELECT t.at, t.amount, t.counterparty, t.channel
FROM main.payments.transactions t
WHERE t.account_id = '$account'
  AND t.at >= date_sub(current_date(), CAST('$days' AS INT))
ORDER BY t.at DESC
```

```sql
-- "Transactions of the accounts linked to this company (1 or 2 hops)"
WITH hop1 AS (
  SELECT CASE WHEN e.src = '$company' THEN e.dst ELSE e.src END AS node_id, 1 AS hop
  FROM main.graph.edges e WHERE '$company' IN (e.src, e.dst)
), hop2 AS (
  SELECT CASE WHEN e.src = h.node_id THEN e.dst ELSE e.src END AS node_id, 2 AS hop
  FROM main.graph.edges e JOIN hop1 h ON h.node_id IN (e.src, e.dst)
), accounts AS (
  SELECT r.node_id, min(r.hop) AS hop
  FROM (SELECT * FROM hop1 UNION ALL SELECT * FROM hop2) r
  JOIN main.graph.nodes n ON n.node_id = r.node_id AND n.node_type = 'Account'
  WHERE r.hop <= CAST('$hops' AS INT)
  GROUP BY r.node_id
)
SELECT a.node_id AS account, a.hop, t.at, t.amount, t.counterparty
FROM accounts a JOIN main.payments.transactions t ON t.account_id = a.node_id
WHERE t.at >= date_sub(current_date(), CAST('$days' AS INT))
ORDER BY t.at DESC
```

The dev showcase (`make dev-seed-showcase`) has one ready: right-click a
Company or Person in *Demo · Cluster programs & right-click actions* →
*Demo · Accounts within 2 hops (table)*, or an edge → *Demo · All links
between these two (table)* (binds `{src}` and `{dst}`).

### Table from the canvas {#canvas-table}

The rows of a **Table from the canvas** action are computed in your browser
from the graph that is loaded: no template, no warehouse, no waiting. Pick it
when the answer is in what you are looking at — the accounts around a
company, the edges of those accounts, the neighbors with a high score — and
the [warehouse table](#table-result) when you need everything that exists.

![A table from the canvas: the people 2 hops from the clicked company](/screenshots/context-menu-actions-canvas-table.png)

| | Table from the canvas | Query template as a table |
| --- | --- | --- |
| Reads | the nodes and edges loaded on the canvas, with the properties loaded | the context's warehouse tables |
| Speed | instant | a warehouse query |
| On a case canvas | every node, files and derived ones included, with the case's ids | the nodes of the canvas's context, with their source ids |
| Needs | nothing | a saved query template |

Two sources:

- **Neighbors — no code.** Walk *N* hops (1 to 5) from the clicked node, in
  any direction or only along / against the edges, optionally only over some
  edge types. Then list either **the nodes reached** (optionally only some
  types; the walk still passes through every type) or **the edges of those
  nodes** (optionally only some edge types — e.g. the `TRANSFER` edges of the
  accounts 2 hops from a company). Columns are properties or
  `metric:<name>`; none chosen means every property found. Hops and direction
  can be changed in the window and run again. Clicking an edge walks from both
  of its ends.
- **Program — JavaScript.** For anything else. It runs in a sandboxed worker
  (no network, no storage, stopped after 10 seconds, *Cancel* stops it at
  once) and returns an array of objects, or `{ columns, rows }`:

  ```js
  // "Big transfers nearby": a parameter min_amount (default 1000)
  const ids = hops(item.node_id, 2).map(n => n.node_id);
  return edgesOf(ids, { types: ['TRANSFER'] })
    .filter(e => Number(e.properties?.amount) >= Number(params.min_amount))
    .map(e => ({ src: e.src, dst: e.dst, amount: e.properties?.amount }));
  ```

  In scope: `item` (the clicked node or edge), `params`, `nodes`, `edges`,
  `node(id)`, `neighbors(id, { direction, edgeTypes, nodeTypes })`,
  `hops(id, k, opts)` (nodes nearest first, each with `.hop`),
  `edgesOf(ids, { types, direction })`, `metric(ref, id)` and
  `selectedNodeIds`. Parameters are declared as JSON
  (`[{ "id": "min_amount", "label": "Min amount", "default": "1000" }]`,
  with `required`, and `"type": "select"` with `options`) and can be bound
  to the clicked item like a template's. They are inputs of the window.

**Test on the selected node** in the editor runs the draft on whatever is
selected on the canvas and shows the first rows or the error, before saving.

The window is the same as for warehouse tables (grid, CSV, *Add to case*, the
rows' node ids focus the node); a **Canvas** badge says where the rows come
from. *Add to case* records the neighborhood settings or the program's code as
provenance.

Only what is loaded counts: a property that is not loaded yet (see
[enrichment](./bring-your-own-data.md#enrich-from-databricks-tables)) is empty in the table, and a node
outside the canvas is not reached.

**Agents** see these actions too: [`list_entity_actions`](./agents-mcp-tools.md#list-entity-actions)
lists them with `source: "canvas"`, and [`run_entity_action`](./agents-mcp-tools.md#run-entity-action)
runs a *Neighbors* table on the case's graph (same rows as in the browser).
A program runs only in a browser: the agent gets its code, not its rows.

The dev showcase has two: right-click a Company or Person → *Demo · Accounts
within 2 hops (canvas)*, or any node → *Demo · High-score neighbors (canvas
program)*.

### Table from a provider {#table-provider}

Rows about the clicked item from **code the deployment registered**: a call to an internal service, a read
from another database, anything a query template cannot reach. The kind is offered when the server has at
least one [table provider](./python-api.md#table-providers); the editor lists every one with its description
(what it returns and when to use it) and whether it has a table for nodes, edges or both.

For each parameter the provider declares, with its type and limits, pick where the value comes from:

| Choice | What happens |
|---|---|
| **Default, editable in the window** | The provider's default applies; whoever runs the action may type another value in the table window. A required parameter with no default is asked there. |
| **From the clicked item** | A [template](#templates) such as `{node_id}` or `{prop:account_id}`, filled when the action runs. This is how the provider learns which item was clicked: it receives its parameters, not the item's properties. |
| **Fixed value** | Your value, always. The window shows it greyed out, and an agent cannot change it either. |

![The action editor on "Table from a provider": the provider's description and where each parameter's value comes from](/screenshots/context-menu-actions-table-provider.png)

It opens the same window as a [query template's table](#table-result): edit the open parameters and run
again, export CSV, **Add to case**. It works on a case canvas and is listed for agents by
[`list_entity_actions`](./agents-mcp-tools.md#list-entity-actions) with `source: "provider"`. An action whose
provider is not registered on this server stays hidden from the menu and shows a warning in the editor.

| Message | Meaning |
|---|---|
| `TABLE_PROVIDER_FAILED` | The provider raised an error; its message is shown when it wrote one for you, otherwise *The provider failed* (the server log names it). |
| `TABLE_PROVIDER_TIMEOUT` | The provider did not answer within its timeout. |
| `TABLE_PROVIDER_NOT_REGISTERED`, `TABLE_PROVIDER_TARGET`, `TABLE_PROVIDER_NOT_ALLOWED` | The provider is not on this server, has no table for this kind of item, or is restricted to other contexts. |

The dev showcase has one in the context *Demo · Provider enrichment and a program that waits*: right-click
any node → *Demo · Monthly activity (provider)*.

### Show only nodes with… {#show-only-nodes-with}

Nodes only. Hides every node except those whose **field** — a node property,
`node_type`, or `metric:<name>` — has:

- **the same value as the clicked node** (`"mode": "same"`) — right-click an
  account, see only the accounts of its `branch_id`;
- **any value** (`"mode": "has"`) — only the nodes where the field is set.

It is a [show only](./exploring-the-graph.md#show-only): the layout stays,
the status bar's **Showing only: branch_id = 12 ✕** brings everything back,
and it is saved with the exploration (and a case's saved views). Values are
read the way labels read them, so a node whose properties are still loading
joins once they arrive.

```json
{
  "kind": "show-same-value",
  "label": "Show only this branch",
  "match": { "target": "node", "nodeTypes": ["Account"] },
  "field": "branch_id",
  "mode": "same"
}
```

For communities and clusters you need no configuration: right-click a node
that belongs to one → **Show only this community** / **Show only this
cluster** (built in).

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
query templates, **every table provider registered on the server** (name,
what it returns, what it has a table for, and each parameter with its type,
default and limits) plus the exact JSON contract, and instructs the AI to
interview you first ("which properties hold external ids?", "new tab or
current?") before producing anything.

The AI's final answer is a JSON array — paste it into the editor's **Import
JSON** box and the actions are added after validation (unknown kinds, bad
operators and `javascript:`/`data:`/`file:` URL templates are rejected with a
pointed error; so are a provider parameter that does not exist and a fixed
value outside its limits). The context form's *Ask an AI* for
[enrichments](./bring-your-own-data.md#import-yaml-or-ask-an-ai) lists the
registered enrichment providers the same way.

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
    "node_properties": ["name", "tax_id"],
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

Running a table action needs only read access: its query goes through the same
read-only check and table scope as the [Query Console](./exploring-the-graph.md#query-console), so
it can read nothing a reader could not query there.

A canvas program is code written by someone with write access that runs in
the browser of whoever clicks it, readers included. It runs in the same
sandbox as [cluster programs](./clusters.md) — no network, no storage, a hard
time limit — and sees only the graph already loaded in that browser, so it
can show that person their own data and nothing else.

Edits save automatically (debounced) and survive reloads in both the
in-memory dev setup and the PostgreSQL one — `make migrate` applies the
`context_menu_actions` column on existing databases.
