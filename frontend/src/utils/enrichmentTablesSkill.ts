import type { EnrichmentProviderInfo } from '@/types/graph';
import { paramLines } from './providerParams';

/**
 * "Ask an AI" for a context's Enrichments: a copy-paste prompt that carries this
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
  /** Enrichment providers registered on this server (code, not SQL), with what each does. */
  providers?: EnrichmentProviderInfo[];
}

/** The registered providers as the prompt lists them: what each adds, to what, with which parameters. */
export function providerSection(providers: EnrichmentProviderInfo[] | undefined): string {
  if (!providers?.length) {
    return 'No provider is registered on this server: do not write `provider` entries.';
  }
  const items = providers.map((p) => {
    const adds = p.columns?.length ? `\n  Adds: ${p.columns.map((c) => `\`${c}\``).join(', ')}.` : '';
    return `- \`${p.name}\` — ${p.label}. Enriches: ${p.targets.join(', ')}.\n  ${p.description || '(no description)'}${adds}\n  Parameters:\n${paramLines(p.params)}`;
  });
  return `These are ALL the providers registered on this server. Use only these names; never invent one.\n\n${items.join('\n')}`;
}

const list = (items: string[], empty = '(none declared)') => (items.length ? items.map((i) => `\`${i}\``).join(', ') : empty);

/** A provider entry for the YAML example, with a real registered name ('' when there is none). */
function providerExample(providers: EnrichmentProviderInfo[] | undefined): string {
  const p = providers?.[0];
  if (!p) return '';
  const param = p.params?.find((x) => x.default !== null && x.default !== undefined);
  const lines = [
    `  - name: ${p.name.replace(/[^a-z0-9]+/g, '_').replace(/^[^a-z]+/, '') || 'provider'}            # a provider entry: no table, no SQL`,
    `    label: ${p.label}`,
    '    description: <what it adds and when to use it>',
    '    provider:',
    `      name: ${p.name}`,
    `      target: ${p.targets[0] ?? 'nodes'}`,
    '      run: manual',
  ];
  if (param) {
    lines.push(`      params: {${param.name}: ${JSON.stringify(param.default)}}`, `      runtime_params: [${param.name}]   # optional: what a run may change`);
  }
  return `${lines.join('\n')}\n`;
}

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

  return `# Write the Enrichments of a Graph Lagoon context

You are helping me configure the **Enrichments** (\`enrichment_tables\`) for the Graph Lagoon context "${input.title}".
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

3. **Or, with no table at all, enrich with a provider**: code the deployment registered in Python
   (it may call an internal service or another database). The entry only names it (\`provider.name\`),
   picks the \`target\` and \`run\`, and may set its parameters. See "Providers" below.

Give every entry that looks nodes up or runs a query a \`description\` (optional, up to 1000
characters): what it adds and when to use it, in one or two sentences. People see it next to the
enrichment, and an AI agent reads it to decide whether to run it.

## This graph

- Datasource: \`${input.datasourceType}\`
- Node types: ${list(input.nodeTypes)}
- Relationship types: ${list(input.relationshipTypes)}
- Edge properties (keys of \`graph_edges.props\`): ${list(input.edgeProperties)}
- Node properties (keys of \`graph_nodes.props\`, sent only with \`node_props: true\`): ${list(input.nodeProperties)}

${ownSection}

## Providers

${providerSection(input.providers)}

In a provider entry: \`params\` sets parameter values (only declared names, inside their bounds);
\`runtime_params\` lists the parameters whoever runs it by hand (a person or an AI agent) may
change — leave it out unless I ask, so nobody changes a value I fixed. \`node_props: true\` /
\`edge_props: true\` send the node / edge properties to the provider (otherwise ids and types only):
set them only when the provider's description says it needs them. A provider entry has no
\`table\`, \`query\` or lookup fields.

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
    description: Risk score and channel of each transaction. Use before filtering or sizing edges by risk.
    table: main.fraud.transactions
    query:
      target: edges           # edges | nodes
      run: auto               # auto (after every query) | manual (Your data → Context enrichments)
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
${providerExample(input.providers)}\`\`\`

## What is configured now

${input.currentYaml.trim() ? `Keep these unless I ask otherwise, and answer with the whole list:\n\n\`\`\`yaml\n${input.currentYaml.trim()}\n\`\`\`` : 'Nothing yet.'}

## What I want

<Describe here what you want on the edges or the nodes, and which Databricks tables hold it.>
`;
}
