# Triple Stores & Typeless Tables

::: tip TL;DR
A warehouse that only has a **triple table** — rows of `src`, `dst` and
maybe a relationship type, with no node table and possibly no type columns
— is a first-class graph context. Graph Lagoon derives what's missing:
nodes come from the edge endpoints, and missing types become the constants
`Node` and `RELATED_TO`.

- **Use it when** relationships exist as rows but entities were never
  materialized into their own table, or a table simply has no type column.
- **Not the tool for** graphs where node attributes matter: derived nodes
  have **no properties**, so labels, property-driven styling and the data
  table stay id-only. For very large triple stores, materialize a nodes
  view instead (see [performance](#performance) below).
:::

A classic graph context points at two tables — edges and nodes — with typed
rows in each. Real warehouses are messier: many teams only ever land a
triple store (`subject`, `predicate`, `object` — here `src`,
`relationship_type`, `dst`), and some tables carry no type column at all.
This page covers the three degraded shapes and how each behaves. All of
them apply to the **SQL warehouse** datasource only — a native graph
database ([Neptune](./neptune.md)) or a
[REST connection](./rest-connections.md) has no tables to begin with.

| Your data | What to do in the context form | What you get |
|---|---|---|
| Edge table, no node table | Check **No node table** | Nodes derived from edge endpoints, type `Node` |
| Node table without a type column | **Node Type Column → None** | Every node typed `Node` |
| Edge table without a type column | **Relationship Type Column → None** | Every edge typed `RELATED_TO` |

The three combine freely — a bare `src`/`dst` pair table with nothing else
is fully supported.

## No node table: nodes derived from edges

Check **"No node table — derive nodes from edge endpoints (triple store)"**
when creating the context. It comes pre-checked when the warehouse lists no
node tables at all.

![Create context without a node table](/screenshots/triple-stores-nodeless-context.png)

With the checkbox on, the Node Table select and the node column mapping
disappear; the backend stores the context with no node table and builds a
**virtual node table** whenever node rows are needed — the deduplicated
union of every `src` and `dst` value, each carrying the constant type
`Node`:

```sql
(SELECT node_id, 'Node' AS node_type FROM (
    SELECT src AS node_id FROM my_catalog.my_schema.triples
    UNION
    SELECT dst AS node_id FROM my_catalog.my_schema.triples
))
```

Everything keeps working — exploring, expanding, metrics, communities,
saving explorations and precomputed graphs — with two honest limits:

- **Cypher labels**: the only node label is `Node`. `MATCH (a)-[r]->(b)`
  and `MATCH (a:Node)` work; `MATCH (a:Person)` returns a clear error.
- **Schema drift**: only the edge table is checked — a derived node table
  cannot drift.

Type discovery still works with just the edge table selected (it reads
relationship types; node types come back as the constant).

## Tables without type columns

Pick **None** for "Node Type Column" and/or "Relationship Type Column" when
a table has no type column. Every node then gets the constant type `Node`,
and every edge the constant type `RELATED_TO`.

The constants flow through everywhere a type appears — legend, filters,
labels (`{relationship_type}` renders `RELATED_TO`), the data table — so
nothing shows empty strings or blank checkboxes. Two consequences to know:

- **One entry everywhere**: with constant types, the legend, type filters
  and per-type styling collapse to a single entry. That is inherent to the
  data — there is nothing to distinguish by.
- **Cypher accepts only the constants**: `(a:Node)` and `-[r:RELATED_TO]->`
  work (as do unlabeled patterns); any other label or relationship type
  returns an error naming the constraint.

Don't use this to *hide* a type column you do have — pick the real column
and keep real types.

## Performance

Each fetch of derived nodes scans the edge table twice (one `UNION` arm per
endpoint column). That is fine for the target use case; for a very large
triple store, materialize a nodes view in the warehouse — it is one
statement — and point the context at it as a regular node table:

```sql
CREATE VIEW my_catalog.my_schema.triples_nodes AS
SELECT src AS node_id, 'Node' AS node_type FROM my_catalog.my_schema.triples
UNION
SELECT dst AS node_id, 'Node' AS node_type FROM my_catalog.my_schema.triples;
```

A materialized nodes table is also the upgrade path when you later want
real node types or properties: join in whatever entity data exists and
recreate the context against it.

## When something is wrong

- **Cypher fails with "node labels other than :Node are not available"**:
  the query uses a label the context cannot have. Use unlabeled patterns,
  `:Node`, or (for edges) `:RELATED_TO`.
- **The data table shows only ID and Type**: derived nodes have no
  properties — expected. Computed metrics and communities still appear as
  virtual columns.
- **Loading feels slow on a huge triple store**: the derived-node scan is
  the cost; materialize the nodes view above.
- **The node-type legend shows a single `Node` entry**: that is the
  constant type, not a bug — the data carries no typing to display.
