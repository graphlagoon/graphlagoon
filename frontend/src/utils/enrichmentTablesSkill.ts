/**
 * "Ask an AI" for a context's Enrichment Tables: a copy-paste prompt that carries this
 * context's tables, columns, types and current entries, the exact YAML the form imports, and
 * the rules the server enforces, so the answer pastes straight into "Import YAML".
 * Pure, like the other skill builders.
 */

export interface EnrichmentTablesSkillInput {
  title: string;
  datasourceType: string;
  edgeTable?: string | null;
  nodeTable?: string | null;
  edgeColumns: { edge_id: string; src: string; dst: string; relationship_type: string };
  nodeColumns: { node_id: string; node_type: string };
  edgeProperties: string[];
  nodeProperties: string[];
  nodeTypes: string[];
  relationshipTypes: string[];
  /** What a table may come from (catalog.schema or catalog.schema.table); null when unknown. */
  allowedSources?: string[] | null;
  /** The entries in the form now, as YAML (empty when there are none). */
  currentYaml: string;
}

const list = (items: string[], empty = '(none declared)') => (items.length ? items.map((i) => `\`${i}\``).join(', ') : empty);

export function buildEnrichmentTablesSkill(input: EnrichmentTablesSkillInput): string {
  const own: string[] = [];
  if (input.edgeTable) {
    own.push(
      `- Edge table \`${input.edgeTable}\`: id \`${input.edgeColumns.edge_id || '(none: ids are src@type@dst)'}\`, ` +
        `source \`${input.edgeColumns.src}\`, target \`${input.edgeColumns.dst}\`, type \`${input.edgeColumns.relationship_type || '(none)'}\`; ` +
        `property columns ${list(input.edgeProperties)}.`,
    );
  }
  if (input.nodeTable) {
    own.push(
      `- Node table \`${input.nodeTable}\`: id \`${input.nodeColumns.node_id}\`, type \`${input.nodeColumns.node_type || '(none)'}\`; ` +
        `property columns ${list(input.nodeProperties)}.`,
    );
  }
  const ownSection = own.length
    ? `The context's own Delta tables (always readable by a query, no need to list them):\n${own.join('\n')}`
    : `This context reads its graph from \`${input.datasourceType}\`, not from Delta tables: every Delta table a query joins must be listed.`;

  return `# Write the Enrichment Tables of a Graph Lagoon context

You are helping me configure **Enrichment Tables** for the Graph Lagoon context "${input.title}".
Answer with ONE \`\`\`yaml block I can paste into the context form's **Import YAML** box, then a
short explanation. If you need a table's columns, ask me to run \`DESCRIBE TABLE <name>\` on
Databricks and paste the output; never guess column names.

## What an entry is

Each entry is one **authorized table** (catalog.schema.table on Databricks). Being listed is what
lets a query read the table. An entry may also:

1. **Look nodes up by key** (for the investigation inspector): \`key_column\`, \`match_node_types\`,
   \`columns\` (the only columns that leave), optional \`match_source\`, \`cardinality\`, \`promote\`.
2. **Enrich with a query**: SQL that runs on the Databricks SQL warehouse right after every graph
   query (\`run: auto\`) or by hand (\`run: manual\`), and adds properties to the **edges** or the
   **nodes** on the canvas (\`target\`).

An entry with neither just authorizes its table so another entry's query can join it.

## This graph

- Datasource: \`${input.datasourceType}\`
- Node types: ${list(input.nodeTypes)}
- Relationship types: ${list(input.relationshipTypes)}
- Edge properties (keys of \`graph_edges.props\`): ${list(input.edgeProperties)}
- Node properties (keys of \`graph_nodes.props\`, sent only with \`node_props: true\`): ${list(input.nodeProperties)}

${ownSection}

## How a query reads the graph

The SQL reads two virtual tables holding the graph on screen (a batch of up to 500 edges or nodes):

| Table | Columns |
|---|---|
| \`graph_edges\` | \`edge_id\`, \`src\`, \`dst\`, \`relationship_type\`, \`props\` MAP<STRING,STRING> |
| \`graph_nodes\` | \`node_id\`, \`node_type\`, \`props\` MAP<STRING,STRING> (empty unless \`node_props: true\`) |

\`src\` and \`dst\` are node ids. Read a property as \`e.props['name']\` (always a string: cast it).

- \`target: edges\` → return an \`edge_id\` column. \`target: nodes\` → return a \`node_id\` column.
- Every other returned column becomes a property with that column name. Give clear snake_case aliases.
- Return at most one row per id (aggregate with GROUP BY; only the first row per id is used).
- NULL values are ignored. A value the item already has wins unless \`overwrite: true\`.

## Rules the server enforces (a query that breaks one is refused)

- One read-only SELECT (WITH … SELECT is fine). No DML, DDL, or several statements.
- Every table it names must be an entry of this list (or the context's own table above).
- No CTE may be named \`graph_edges\` or \`graph_nodes\`; no entry's table may be either name.
- \`name\`: lowercase letters, digits and _ (starts with a letter), unique. \`label\` is what people see.
- ${
    input.allowedSources?.length
      ? `Every entry's table must come from these allowed sources (a \`catalog.schema\` allows any table in it, a \`catalog.schema.table\` only that table): ${list(input.allowedSources)}. Never propose a table outside them; if the data I need lives elsewhere, say that an administrator must add it to \`GRAPH_LAGOON_ENRICHMENT_SOURCES\`.`
      : 'Tables must come from the sources the administrator allows; saving needs the "Create graph contexts" permission.'
  }
- No query may read a table that is not in this list or the context's own tables, for anyone.

## YAML format

\`\`\`yaml
enrichment_tables:
  - name: channels            # only authorizes the table, for the join below
    label: Payment channels
    table: main.fraud.channels
  - name: tx_risk
    label: Transaction risk
    table: main.fraud.transactions
    query:
      target: edges           # edges | nodes
      run: auto               # auto (after every query) | manual (Your data → From Databricks tables)
      overwrite: false
      node_props: false
      sql: |
        SELECT e.edge_id, t.risk_score, c.name AS channel
        FROM graph_edges e
        JOIN main.fraud.transactions t ON t.tx_id = e.props['tx_id']
        JOIN main.fraud.channels c ON c.id = t.channel_id
  - name: account_activity
    label: Account activity
    table: main.fraud.ledger
    query:
      target: nodes
      run: auto
      sql: |
        SELECT n.node_id, count(*) AS tx_90d, sum(l.amount) AS volume_90d
        FROM graph_nodes n
        JOIN main.fraud.ledger l ON l.account_id = n.node_id
        WHERE l.booked_at >= current_date() - INTERVAL 90 DAYS
        GROUP BY n.node_id
  - name: devices
    label: Login devices
    table: main.risk.devices
    key_column: account_id    # node lookup for the investigation inspector
    match_node_types: [Account]
    match_source: node_id     # or {kind: prop, name: <node property>}
    cardinality: many         # one: columns become node properties; many: a table in the inspector
    columns: [device_id, ip, seen_at]
\`\`\`

## What is configured now

${input.currentYaml.trim() ? `Keep these unless I ask otherwise, and answer with the whole list:\n\n\`\`\`yaml\n${input.currentYaml.trim()}\n\`\`\`` : 'Nothing yet.'}

## What I want

<Describe here what you want on the edges or the nodes, and which Databricks tables hold it.>
`;
}
