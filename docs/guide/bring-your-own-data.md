# Bring your own data into a case

::: tip TL;DR
You do not need a database context to put your own data on a case's graph. A person or an AI agent can
**declare a graph from a spreadsheet** (a CSV or text file plus a *file mapping*) or **hand over the graph as
JSON** (`nodes` and `edges`). It lands on the case canvas, unified with the case's other sources, and it stays in
that case.

- **Use it when** the data lives in a spreadsheet, an export or a script's output and not in a graph context:
  bank statements, a card network file, a list of calls, the result of a query you ran elsewhere.
- **Not the tool for** data that other cases or other people should explore. This is case material, not an
  exploration of a context (see [what it is not](#what-it-is-not)).
- **Needs** write access to the case and, for a file, the `investigation.upload` permission.
:::

## Three ways in

| You have | Use | Validated |
|---|---|---|
| A CSV or text file (delimited or fixed-width) | [A file with a mapping](#a-file-with-a-mapping): upload it and say which columns are nodes and edges | Yes: the spec is checked, rows that fail to convert are discarded and reported |
| A table of results (a query, a list the agent built) | [A table promoted to the graph](#a-table-promoted-to-the-graph): pick the source and target columns | Yes |
| The graph already built, as JSON | [A snapshot](#a-snapshot-as-json): send `{nodes, edges}` | Only the shape of `view` and `selection`; a snapshot is not checked (see [limits](#limits)) |

Prefer the mapping or the promotion. They tell you what went wrong; a malformed snapshot only shows up later,
when the case graph is built.

## A file with a mapping

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
  `direction`.
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

### As a person

The import wizard of the case takes the file, detects a saved mapping when the file name and header match one in
the organization's library, and otherwise lets you build the mapping. An administrator saves mappings under
**Admin → Library → file mapping**, so the next file of the same kind needs no setup.

### As an agent or a system

With MCP, `import_file` sends the text of the file (up to about 4 MB, so convert other formats to CSV first) with
its mapping:

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

## A table promoted to the graph

When you only have rows with a source and a target (who paid whom, who called whom), you do not need to write a
mapping. Add the table, then **promote** it:

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

## A snapshot as JSON

If you already have the graph, send it as it is: a `graph` item of subkind `snapshot`, with `content_json`.

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
want one node on the canvas.

## What happens next

Whatever the way in, the item is **case material**:

- It shows on the canvas with its own ring and joins the case's *unified graph*. *Follow the money*, paths,
  links and entity resolution run over it.
- It is **versioned**: sending new bytes adds a version, and a pinned version is evidence.
- The author is recorded. An agent's item carries the **agent** chip, and the kinds the case lists in its agent
  settings arrive as **suggestions** a person confirms.
- It is part of the **journal** and of the dossier, like any other item.

## What it is not

- **Not an exploration.** An exploration belongs to a graph context (a database the app queries) and shows up in
  the explorations list. Your data stays inside the case: other cases do not read it, and the context does not
  gain it. To see the same entity across cases, use identity keys: *Seen in other cases* matches on them.
- **Not a way around access rules.** Your data lives in the case and follows the case's sharing. An item taken
  from a context you cannot read stays restricted, and anything joined or promoted from it keeps the
  restriction.

## Limits

- **Formats:** delimited and fixed-width text. Excel files (`.xlsx`) are not read: export the sheet as CSV
  first. Other formats are kept as files, previewed or downloaded, but they put nothing on the graph.
- **Size:** uploads stop at `GRAPH_LAGOON_INVESTIGATION_FILE_MAX_BYTES`; `import_file` takes about 4 MB of
  inline text; a mapped table is capped at 50,000 edges.
- **A snapshot is not validated.** Content that is not JSON, or an unknown `encoding` in a mapping, makes the
  case graph fail until the item is fixed or removed. Check the JSON before sending it.
- **Regexes** in identity keys are checked when saved: nested repetition such as `(a+)+` is refused.
- **Agents** need an [agent token](./agents-mcp.md#tokens) and, for a file, the owner's `investigation.upload`
  permission.

## See also

- [Investigations](./investigations.md): the case, the unified graph and identity keys.
- [AI Agents (MCP)](./agents-mcp.md) and the [MCP tool reference](./agents-mcp-tools.md): `import_file`,
  `add_table`, `add_item`, `promote_tables`.
- [REST API & Integrations](./rest-api.md): authentication and the same flows in `curl`.
