# Bring your own data

::: tip TL;DR
You can put your own data on the graph without a database context: **enrich** the nodes or edges already on the
canvas from a CSV, **add** nodes and edges from a file or JSON, or **draw** them by hand. It works in a
[case](./investigations.md) and in a plain [exploration](./explorations.md). The context itself never changes.

- **Use it when** the data lives in a spreadsheet, an export or a script's output: a risk list keyed by account,
  a channel per transfer, a CRM export, the phone a customer gave on a call.
- **Not the tool for** data that every exploration of a context should see. Add that to the context as an
  enrichment table, or as an [enrichment query](#enrich-from-databricks-tables) over Databricks
  tables that runs after every query (see [what it is not](#what-it-is-not)).
- **Needs** write access to the case or the exploration. In a case, a file also needs the `investigation.upload`
  permission; in an exploration, everything needs `exploration.edit_graph`.
:::

## What you can do, and where

| You want to | In a case | In an exploration |
|---|---|---|
| Add properties to nodes already on the canvas | [Enrichment file](#enrich-nodes-or-edges-from-a-file) (import wizard, role **Enrichment**) | **Your data → Enrich from a file**: a file, pasted rows, or [an AI's answer](#ask-an-ai) |
| Add properties to edges already on the canvas | Enrichment file, **edges** | **Your data → Enrich from a file**, **edges** |
| Add properties to edges or nodes from the context's Databricks tables | — | [Enrichment queries](#enrich-from-databricks-tables): after every query, or **Your data → From Databricks tables** |
| Add nodes and edges from a CSV | [File with a mapping](#a-file-with-a-mapping), or [a promoted table](#a-table-promoted-to-the-graph) | **Your data → Nodes and edges from a file** |
| Add nodes and edges from JSON | [Snapshot item](#a-snapshot-as-json) | **Your data → Nodes and edges from a file** (a `.json`) |
| Draw a node or an edge | [Right-click → Add a linked node](#drawn-by-hand), stored in **Manual additions** | Right-click → **Add a linked node**, stored in the exploration's layer |

A case keeps every file as a versioned item with its author and hash. An exploration keeps your data in a
**layer** saved beside it ([below](#in-an-exploration-your-layer)), so the context's answer and yours never mix.

## Enrich nodes or edges from a file

An **enrichment file** is a table whose rows add properties to what is already on the canvas. It puts no node
of its own on the graph.

### How a row finds its node

| Setting | What it does |
|---|---|
| **Key column** | The column whose value identifies the node (or the edge) |
| **Node property holding the key** | Match the key against a property (`registry_id`) instead of the node id |
| **Normalize keys on both sides** | `digits`, `phone`, `email`, `account`, `card`… as for [identity keys](./investigations.md#identity-keys): `123.456.789-01` and `12345678901` meet |
| **First N digits** | Compare only a prefix (a company id against its group's 8 digits) |
| **Node types** | Which types it applies to. Empty means every type |
| **Columns added as properties** | The other columns you keep |

In a case, a node merged by an identity key also matches by its entity value. A file of documents
finds the `Person` merged from two contexts even when its node ids are internal numbers.

**Edges** match in one of two ways:

- **by edge id**, with a key column of edge ids;
- **by their two endpoints**, with a source and a target column (node ids, normalized like the key) and,
  optionally, an edge-type column. A row matches the edge in either direction.

A cell that reads as a plain number becomes a number (`2019`, `-5.5`). A cell with leading zeros stays text
(`00042`), and an empty cell sets nothing.

### What wins

The value already on the node wins. The file fills only what is missing, and the value it could not set is kept
as a **conflict** with the file as its source. The case inspector shows conflicts next to the property.
Tick **Replace values the nodes already have** when the file is the better source: then its values win.

This is the same rule the case uses when two contexts bring the same entity. The order is sources first, then
accepted matches, then enrichment files in the order they were added.

### In a case

In the import wizard pick **Enrichment**, then the settings above. The file stays an item of the case: versioned,
audited, and applied to the canvas, the inspector, the server analyses and what agents read. Over REST or MCP,
attach the mapping to a table you uploaded:

```json
{
  "as": "enrichment",
  "spec": {
    "name": "Risk list",
    "input": { "delimiter": ";", "header": true },
    "key_column": "document",
    "columns": ["risk", "segment"],
    "normalize": "digits"
  }
}
```

For edges, add `"target": "edges"` and either a `key_column` of edge ids or
`"edge_key": {"by": "endpoints", "source_column": "from", "target_column": "to", "type_column": "kind"}`.
`match_node_types` (default `["*"]`), `match_edge_types`, `match_source` (`{"kind": "prop", "name": "…"}`),
`key_digits` and `overwrite` are optional.

**Promote** does the same from a table already in the case:

```bash
curl -s -X POST "$API/api/investigations/$CASE/items/promote" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"item_ids": ["<table id>"], "as": "enrichment",
       "options": {"key_column": "document", "normalize": "digits"}}'
```

### In an exploration

Open **Your data** in the bar under the graph (next to **Table**) and choose **Enrich from a file**. Bring the rows
in one of three ways: drop a CSV on the box, **Choose a file**, or **Paste rows** copied from a spreadsheet (the
header row included). A title line above the header is skipped.

You do not have to set the join. Every column is tried against the node ids and against every node property,
as it is and under each normalizer (lowercase, digits, phone, e-mail, account, card…), and the join that reaches
the most nodes is picked. The line above **Apply** says what it found, for example *12 of 24 Person nodes match a
row · column person_id = the node id*. A file whose rows all land on one type is kept to that type. Two columns
that hold both ends of the canvas's edges enrich those edges instead. When more than one join works, the others
are listed above the rows: click one to use it. **Adjust the matching and the columns** opens every setting from
[the table above](#how-a-row-finds-its-node). **Apply** draws it at once.

![Your data: enrich from a file](/screenshots/bring-your-own-data-enrich.png)

#### Ask an AI

The two buttons copy a prompt for any AI assistant (ChatGPT, Claude, …). You paste the CSV it answers into the
same window, and it goes through the same automatic join.

- **Ask an AI to fill in data**: the AI is the source. The prompt lists the nodes (the selected ones, or every
  node on the canvas, up to 500) with their id, type and name, and asks for a CSV whose first column is
  `node_id`. Use it for what a model knows or for a document you give it in the chat ("the sector and country of
  each company").
- **Ask an AI to clean this file**: shown when no column meets the canvas, and under the result. The prompt holds
  the first 15 lines of your file and a few ids and property values of each node type. The AI rewrites the key the
  way the canvas writes it (a key inside text, split across columns, with another mask), fixes decimal commas and
  dates, and answers a clean CSV. For a file too large to paste, it writes a short script that does it.

::: warning What leaves Graph Lagoon
Both prompts carry real data: node ids and names, or the first lines of your file. The window says so before you
copy. Paste them only into an assistant your organization allows for this data.
:::

## Enrich from Databricks tables

A context can carry **enrichment queries**: SQL its author writes once, which runs on the Databricks SQL
warehouse right after the graph answers, and adds properties to the edges or to the nodes on the canvas. The graph itself can
come from anywhere (Delta tables, Neptune, a REST connection, a precomputed graph such as a Lakebase BFS); the
enrichment always reads Delta tables.

Use it when the value you want needs joins the graph query does not do: the risk score of the transaction
behind an edge, the channel from a second table, an account's activity in the last 90 days.

### Which tables a query may read

The context's **Enrichment Tables** list (context form) is its list of **authorized tables**. It may be empty or
hold many. Being listed is what authorizes a table: a query may read only the listed tables and the context's
own edge and node tables, nothing else. Each entry can carry a query, and can also look nodes up by key for
the [investigation inspector](./investigations.md#enrichment-tables) (**Node lookup in the investigation
inspector**, a different, older feature: it reads one table by a node key, with no SQL). Both parts are
optional, so an entry can just authorize a table for a sibling's join.

| Rule | Why |
|---|---|
| Adding or changing an entry (its table, its lookup or its query) needs the **Create graph contexts** permission, and the table must be in an allowed catalog | Listing a table widens what the context's readers can read, so it is an author's decision. A writer without the permission may only remove entries. |
| The query is one read-only `SELECT` | It runs with the app's warehouse access. |
| Every table it names is checked against the list when you save **and** on every run | A table removed from the list stops every query that joined it. |
| Running a query only needs read access to the context | Like a lookup; every run is audited as `enrichment.run`. |

### Writing the query

In the context form, open an entry and **Enrich with a query**, and choose what it **enriches**: the edges or
the nodes. The query reads the graph on screen from two virtual tables. A query on edges returns an `edge_id`
column, a query on nodes a `node_id` column, one row per id. Every other column becomes a property.

| Virtual table | Columns |
|---|---|
| `graph_edges` | `edge_id`, `src`, `dst`, `relationship_type`, `props` (a `MAP<STRING,STRING>` of the edge's properties) |
| `graph_nodes` | `node_id`, `node_type`, `props` (empty unless **Send node properties** is on) |

```sql
SELECT e.edge_id, t.risk_score, c.channel
FROM graph_edges e
JOIN main.fraud.transactions t ON t.tx_id = e.props['tx_id']
JOIN main.fraud.channels c ON c.id = t.channel_id
```

Here both `main.fraud.transactions` and `main.fraud.channels` must be in the list. A query on nodes reads
`graph_nodes` (and `graph_edges` holds the edges that touch them):

```sql
SELECT n.node_id, count(*) AS tx_90d, sum(l.amount) AS volume_90d
FROM graph_nodes n
JOIN main.fraud.ledger l ON l.account_id = n.node_id
WHERE l.booked_at >= current_date() - INTERVAL 90 DAYS
GROUP BY n.node_id
```

The query may define its own CTEs, but not ones named `graph_edges` or `graph_nodes`.

### Import YAML, or ask an AI

The **Enrichment Tables** header has three helpers:

- **Import YAML** takes a list pasted or from a `.yaml` / `.json` file. Entries with the same `name` replace
  the ones in the form; the others are added; an entry that is wrong is skipped and says why. Nothing is saved
  until you save the context.
- **Export YAML** shows the current entries as YAML (and copies them), to edit, review or move to another
  context.
- **Ask an AI** builds a prompt for any AI assistant with this context's tables, columns, properties, types and
  current entries, plus the rules above. Describe what you want at the end; paste the YAML it answers into
  **Import YAML**. The prompt holds table and column names, no data.

![The context form: Enrichment Tables with Import YAML and Ask an AI](/screenshots/bring-your-own-data-enrichment-tables.png)

```yaml
enrichment_tables:
  - name: channels              # only authorizes the table for the join below
    label: Payment channels
    table: main.fraud.channels
  - name: tx_risk
    label: Transaction risk
    table: main.fraud.transactions
    query:
      target: edges             # edges | nodes
      run: auto                 # auto | manual
      overwrite: false
      node_props: false
      sql: |
        SELECT e.edge_id, t.risk_score, c.name AS channel
        FROM graph_edges e
        JOIN main.fraud.transactions t ON t.tx_id = e.props['tx_id']
        JOIN main.fraud.channels c ON c.id = t.channel_id
```

| Setting | Effect |
|---|---|
| **Enriches: the edges / the nodes** | What the returned ids are and what gets the properties. |
| **Runs: after every query and expand** | Runs by itself when a query, a subgraph, an expand, a precomputed graph or a saved exploration lands. An expand sends only the new edges and nodes. |
| **Runs: only from Your data** | Runs when someone clicks **Run** in **Your data → From Databricks tables**. |
| **Replace values the edge (node) already has** | Off: a value already there wins, and the query's is ignored. On: the query's value wins. |
| **Send node properties** | Off: `graph_nodes` holds ids and types only, so node data does not travel. |

### What a reader sees

- The new properties appear on the edges or nodes. In the details panel each one carries a
  **from &lt;query name&gt;** chip, so it never passes for the graph's own data. On nodes they stay when the
  rest of the node's properties load in the background.
- **Your data → From Databricks tables** lists the context's queries and the authorized tables, runs one by
  hand, shows the SQL, and says what the last run did: *2 of 40 edges matched a row · 2 got new values*. A reader
  of a shared exploration gets this tab even without write access.
- Nothing is saved. A saved exploration leaves the values out of its snapshot, and opening it runs the
  **after every query** ones again, so the values are always current.

![Your data: from Databricks tables](/screenshots/bring-your-own-data-databricks.png)

### When something is wrong

| You see | Cause |
|---|---|
| *An edge enrichment query failed* (toast) | An automatic run failed. The graph is fine; the tab says why. |
| `ENRICHMENT_SCOPE_DENIED` when saving or running | The query names a table that is not in the list (or no longer is). Add it, or change the query. |
| `ENRICHMENT_RESULT_NO_KEY` | The query returned no `edge_id` column (a query on edges) or no `node_id` column (on nodes). |
| `ENRICHMENT_QUERY_FAILED` | The warehouse refused the query (a missing column, a type error); its message is shown. |
| *the result hit the row limit* | More rows than `GRAPH_LAGOON_ENRICHMENT_MAX_ROWS` came back for one batch; some edges may be missing values. |

Edges travel in batches of `GRAPH_LAGOON_ENRICHMENT_MAX_KEYS` (500 by default), each with its endpoint nodes;
nodes travel the same way, each batch with the edges that touch it. Only the first row per id is used.

## Add nodes and edges

### A file with a mapping

A **file mapping** is a JSON document, `{"as": "graph", "spec": {…}}`, that says how the rows of one or more files
become nodes and edges.

```json
{
  "as": "graph",
  "spec": {
    "version": 1,
    "name": "Card transactions",
    "inputs": {
      "t": { "match": "*.csv", "delimiter": ";", "header": true }
    },
    "nodes": [
      { "key": "card", "type": "Card", "from": "t",
        "id": { "col": "t.card_token", "normalize": "card" } },
      { "key": "merchant", "type": "Merchant", "from": "t",
        "id": { "col": "t.merchant_id", "convert": ["trim", "upper"] },
        "props": { "name": "t.merchant_name", "mcc": "t.mcc" } }
    ],
    "edges": [
      { "from": "t", "type": "PAID", "endpoints": { "self": "card", "other": "merchant" },
        "props": {
          "amount": { "col": "t.amount", "convert": "decimal_comma" },
          "date": { "col": "t.date", "convert": "date:dd/mm/yyyy" }
        } }
    ],
    "edge_semantics": { "amount_prop": "amount", "time_prop": "date" }
  }
}
```

How to read it:

- **`inputs`** names each file (`t` above). `match` is a file-name glob; the format is `delimiter` (`,`, `;`, a
  tab) or, for fixed-width lines, `widths` (one number per column). `header: false` needs `columns`.
- **A column** is written `alias.COLUMN` (`t.amount`). A value is a column, or an object with one of `col`,
  `concat` or `template`, then optional `convert`, `map` and `normalize`.
- **`nodes`** create one node per row (`type`, `id`, optional `props` and `when`). Nodes with the same id
  merge. **`edges`** connect two node keys (`endpoints.self` and `endpoints.other`), with `type`, `props` and
  `direction`. A spec with nodes and no edges is valid.
- **`normalize`** turns an id into an *identity key* (`digits`, `account`, `card`, `phone`, `email`…). The same
  normalized value in two files, or in two cases, is the same entity. This is what lets a spreadsheet and a
  database context merge on the canvas.
- **`edge_semantics`** says which edge properties hold the amount and the time, so *follow the money* works on
  your data.
- **`when`** skips rows (`{"not_empty": "t.terminal_id"}`, `{"eq": ["t.kind", "PIX"]}`), and **`joins`** relate
  several files by a key.
- A row whose conversion fails is **dropped and reported**, never half-loaded. `date:` reads a date only, with
  exactly `dd`, `mm` and `yyyy` and the same length as the cell (`date:dd/mm/yyyy`).

The complete list of converters, normalizers and operators is what **Ask an AI** in the admin Library editor
puts in its prompt; it is read from the server, so it is always current.

**In a case**, the import wizard takes the file, detects a saved mapping when the file name and header match one
in the organization's library, and otherwise lets you build the mapping. An administrator saves mappings under
**Admin → Library → file mapping**, so the next file of the same kind needs no setup.

**In an exploration**, **Your data → Nodes and edges from a file** uses the same mapping step and the same saved
mappings. A node whose id is already on the canvas is not copied: it gets the properties it was missing, and the
file's edges reach it. That is how you add new edges between nodes the context already returned. The ids must
be the same as the context's, after `normalize`.

**As an agent or a system**, with MCP, `import_file` sends the text of the file (up to about 4 MB, so convert
other formats to CSV first) with its mapping:

```text
import_file(investigation_id, filename="statements.csv", text="<the CSV>", mapping={"as": "graph", "spec": {…}})
```

Over REST, upload the bytes and attach the mapping (`$API`, `$TOKEN`, `$CASE` and `$MAPPING` as in
[REST API & Integrations](./rest-api.md#upload-a-large-file-and-put-it-on-the-graph)):

```bash
ITEM=$(curl -s -X POST "$API/api/investigations/$CASE/items?kind=table&subkind=csv&filename=statements.csv" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: text/csv" --data-binary @statements.csv | jq -r .id)
curl -s -X PATCH "$API/api/investigations/$CASE/items/$ITEM" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"mapping\": $(curl -s "$API/api/org/library/$MAPPING" -H "Authorization: Bearer $TOKEN" | jq -r .body)}"
```

An agent may attach a mapping to a file **it** uploaded. It does not remap a person's table: it adds its own
file instead.

### A table promoted to the graph

When you only have rows with a source and a target (who paid whom, who called whom), you do not need to write a
mapping. Add the table to the case, then **promote** it:

```bash
# a table of results (an agent: add_table)
curl -s -X POST "$API/api/investigations/$CASE/items" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"kind": "table", "subkind": "result", "title": "Pix, last 90 days",
       "content_json": {"columns": ["origin", "target", "amount"], "rows": [["111", "222", 50]]}}'

curl -s -X POST "$API/api/investigations/$CASE/items/promote" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"item_ids": ["<table id>"], "as": "graph",
       "options": {"source_column": "origin", "target_column": "target",
                   "source_type": "Account", "edge_type": "PIX", "amount_prop": "amount"}}'
```

The remaining columns become edge properties. `options` also takes `target_type`, `normalize` and `time_prop`.
Promoting a *query* first turns its latest run into a table; the provenance keeps the query and the run.

### A snapshot as JSON

If you already have the graph, send it as it is. In a case it is a `graph` item of subkind `snapshot`, with
`content_json`. In an exploration, choose a `.json` file in **Your data → Nodes and edges from a file**.

```json
{
  "kind": "graph",
  "subkind": "snapshot",
  "title": "Graph from the CRM export",
  "content_json": {
    "nodes": [
      { "id": "C1", "type": "Customer", "properties": { "name": "Ana" } },
      { "id": "A1", "type": "Account", "properties": {} }
    ],
    "edges": [
      { "id": "e1", "source": "C1", "target": "A1", "type": "OWNS", "properties": {} }
    ]
  }
}
```

With MCP it is `add_item(kind="graph", subkind="snapshot", content_json={…})`. The nodes merge with the other
sources by **identity keys** (set per case in ⚙), so give the same node type and id the other sources use if you
want one node on the canvas. The exploration checks the JSON before adding it: every node needs an `id` and a
`type`, and every edge needs a `source`, a `target` and a `type`.

### Drawn by hand

Right-click a node:

- **Add a linked node…** draws a new node (type, label, other properties as `name = value` lines) and an edge
  between it and the node you clicked.
- With exactly one other node selected, **Connect to the selected node…** draws an edge between the two.
- **Remove from your data** removes what you drew, with its edges.

In an exploration, **Your data → Draw → Add a node…** draws a node with no edge. In a case, use
**+ Add → File → Draw a node by hand**.

In a case, everything you draw goes to one item, **Manual additions** (`graph/sketch`), with you as author and a
new version per change. Its ids are the case's unified ids; a node already on the canvas appears in it as a stub
(id and type, no properties) so an edge can reach it, and it gets the sketch's ring. Agents can write one with
`add_item(kind="graph", subkind="sketch", content_json={"unified": true, "nodes": […], "edges": […]})`; a node
without a type, or an edge whose end is not in the sketch, is refused.

## In an exploration: your layer

Whatever you add to an exploration lives in its **layer**, a file saved beside the exploration's snapshot. The
snapshot stays exactly what the context returned.

- **It comes back.** Reopening the exploration, running another query or expanding a node applies the layer
  again: new nodes get their enrichment, and your edges appear when both ends are on the canvas.
- **You can tell it apart.** Nodes you added have an amber ring. In the side panel, a property your data set
  carries a **your data** mark. **Expand** is not offered on your own nodes, since the context does not know them.
- **It is saved as you go** on an exploration you can write. On a graph not saved yet, it stays in memory until
  **Save**, and the exploration is created first. If the layer then fails to save (for example without the
  `exploration.edit_graph` permission), the toast says *"Saved without your data layer"*.
- **It is shared with the exploration.** Whoever can open the exploration sees the layer; only who can write the
  exploration changes it. A read-only share has no **Your data** button.
- **Metrics, communities, styles and filters** work on what is drawn, your nodes included: a drawn node counts in
  the degree, its type gets a color and a filter checkbox, and an enriched column can feed a label template. If
  you save a metric as a property with the same name as an enriched column, the metric wins.
- **A case sees it.** When a case holds the exploration, the case canvas, the server analyses and MCP read the
  exploration with its layer. Pinning the exploration freezes the layer with it.
- **Publishing a precomputed graph** from the exploration publishes the context's graph only: the layer stays
  with the exploration.

**Your data** lists what the layer holds (each enrichment file, each import, the nodes drawn by hand), with
**Remove** for each.

## What happens next in a case

Whatever the way in, the item is **case material**:

- It shows on the canvas with its own ring and joins the case's *unified graph*. *Follow the money*, paths,
  links and entity resolution run over it. An enrichment file has no ring: it adds properties.
- It is **versioned**: sending new bytes adds a version, and a pinned version is evidence.
- The author is recorded. An agent's item carries the **agent** chip, and the kinds the case lists in its agent
  settings arrive as **suggestions** a person confirms.
- It is part of the **journal** and of the dossier, like any other item.

## What it is not

- **Not a change to the context.** Neither a case file nor an exploration's layer writes to the database the
  context reads. Other explorations of the context do not see it, and no context or exploration is created for
  a file. For data every exploration should see, add an enrichment table or an
  [enrichment query](#enrich-from-databricks-tables) to the context (context form), or a table to
  the warehouse.
- **Not a way around access rules.** A case's data follows the case's sharing; an exploration's layer follows
  the exploration's. An item taken from a context you cannot read stays restricted, and anything joined or
  promoted from it keeps the restriction.

## Limits

- **Formats:** delimited and fixed-width text, and JSON for a graph. Excel files (`.xlsx`) are not read: export
  the sheet as CSV first. In a case, other formats are kept as files, previewed or downloaded, but they put
  nothing on the graph.
- **Size:** case uploads stop at `GRAPH_LAGOON_INVESTIGATION_FILE_MAX_BYTES`; `import_file` takes about 4 MB of
  inline text; a mapped table is capped at 50,000 edges. An exploration's layer stops at
  `GRAPH_LAGOON_EXPLORATION_OVERLAY_MAX_BYTES` (5 MB by default) of JSON: keep the columns you need, or use a
  case for large files.
- **One row per key.** When a file has several rows for a key, the first one sets the properties. In a case, the
  inspector's **Enrichment** tab lists every row.
- **A case snapshot is not validated.** Content that is not JSON, or an unknown `encoding` in a mapping, keeps
  that item off the case graph until it is fixed or removed. Check the JSON before sending it.
- **Pickers that read the context's schema** (the hive plot axes, for example) do not list enriched columns.
- **Regexes** in identity keys are checked when saved: nested repetition such as `(a+)+` is refused. A file key
  cannot use the `regex` normalizer.
- **Agents** need an [agent token](./agents-mcp.md#tokens) and, for a file, the owner's `investigation.upload`
  permission. An exploration's layer has no MCP tool: agents add their data to a case.

## See also

- [Investigations](./investigations.md): the case, the unified graph and identity keys.
- [Explorations](./explorations.md): what an exploration saves and who can open it.
- [AI Agents (MCP)](./agents-mcp.md) and the [MCP tool reference](./agents-mcp-tools.md): `import_file`,
  `add_table`, `add_item`, `promote_tables`.
- [REST API & Integrations](./rest-api.md): authentication and the same flows in `curl`.
- [Groups & permissions](./permissions.md): `investigation.upload` and `exploration.edit_graph`.
