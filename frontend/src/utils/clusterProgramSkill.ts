/**
 * Cluster Program Skill Builder
 *
 * Generates a self-contained, copy-pasteable prompt ("skill") that a user can
 * paste into an LLM to get help writing a cluster program. The prompt embeds
 * the current graph's metadata (node/edge types and their properties) so the
 * LLM has concrete context to work with, plus the execution contract (the
 * `context` object shape and the required `Cluster[]` return value) and a
 * worked example.
 *
 * This is a pure function — no store access — so it is easy to test and reuse.
 */

export interface SkillProperty {
  /** Property/column name */
  name: string
  /** Declared data type (e.g. 'string', 'int', 'timestamp') */
  data_type: string
  /** Optional human description */
  description?: string
}

export interface ClusterProgramSkillInput {
  /** Session-computed node metrics (readable via `metric(<name>, node_id)`) */
  nodeMetrics?: SkillMetric[]
  /** Session-computed edge metrics */
  edgeMetrics?: SkillMetric[]
  /** Node types present in the current graph (e.g. ['Person', 'Company']) */
  nodeTypes: string[]
  /** Edge/relationship types present in the current graph */
  edgeTypes: string[]
  /** Node property columns from the current context */
  nodeProperties: SkillProperty[]
  /** Edge property columns from the current context */
  edgeProperties: SkillProperty[]
}

/** Render a list of values as a bullet list, or a placeholder when empty. */
export function bulletList(values: string[], emptyText: string): string {
  if (values.length === 0) return `  (${emptyText})`
  return values.map((v) => `  - ${v}`).join('\n')
}

/** Render property columns as `name (data_type) — description` bullets. */
export function propertyList(props: SkillProperty[], emptyText: string): string {
  if (props.length === 0) return `  (${emptyText})`
  return props
    .map((p) => {
      const desc = p.description ? ` — ${p.description}` : ''
      return `  - ${p.name} (${p.data_type})${desc}`
    })
    .join('\n')
}

/** A session-computed metric, as embedded into the Ask-AI prompts. */
export interface SkillMetric {
  /** Metric display name (the `{metric:<name>}` ref) */
  name: string
  /** Value type from ComputedMetric.valueType */
  valueType: 'number' | 'string' | 'boolean'
}

/** Render computed metrics as `name (valueType)` bullets. */
export function metricList(metrics: SkillMetric[], emptyText: string): string {
  if (metrics.length === 0) return `  (${emptyText})`
  return metrics.map((m) => `  - ${m.name} (${m.valueType})`).join('\n')
}

/**
 * Build the cluster-program skill prompt from the current graph's metadata.
 * The output is plain text (Markdown) meant to be copied into an LLM chat.
 */
export function buildClusterProgramSkill(input: ClusterProgramSkillInput): string {
  const { nodeTypes, edgeTypes, nodeProperties, edgeProperties } = input
  const nodeMetrics = input.nodeMetrics ?? []
  const edgeMetrics = input.edgeMetrics ?? []

  return `# Task: write a "cluster program" for a graph visualization tool

You are helping me write a **cluster program** for Graph Lagoon Studio. A cluster
program is a small JavaScript snippet that groups nodes of a graph into clusters.
I will paste your code into the tool's program editor and run it.

I don't know exactly what I want yet, so **start by asking me questions** (see the
"How to help me" section at the end) before writing any code.

## How a cluster program runs

- Your code runs as the **body of a function** that receives a single \`context\`
  object. These variables are already destructured and in scope:
  \`nodes\`, \`edges\`, \`selectedNodeIds\`, \`selectedEdgeIds\`, \`params\`,
  \`metric\`, \`metrics\`. (Do not declare your own top-level \`const\` with any
  of these names.)
- Programs can declare **parameters** in the editor UI (text, number, boolean, or
  dropdown). Their values arrive already typed in \`params\` and are read as
  \`params.<id>\` (e.g. \`params.threshold\`). Prefer a parameter over a hardcoded
  constant when a value is likely to be tweaked between runs.
- Your code MUST \`return\` an **array of cluster objects**. Returning anything
  else is an error.
- Do NOT wrap the code in a function, do NOT use \`import\`/\`require\`, and do NOT
  access the DOM or network. Only plain JavaScript and the \`context\` inputs.

## Input shape (\`context\`)

\`\`\`js
nodes: Array<{
  node_id: string,
  node_type: string,
  properties?: Record<string, unknown>,
}>
edges: Array<{
  edge_id: string,
  src: string,   // source node_id
  dst: string,   // destination node_id
  relationship_type: string,
  properties?: Record<string, unknown>,
}>
selectedNodeIds: string[]
selectedEdgeIds: string[]
params: Record<string, string | number | boolean>  // values of parameters declared in the editor UI
// Session-computed metrics (Metrics panel). ref = metric name or id; returns
// undefined when not computed / no value for the item. A name shared by a
// node and an edge metric resolves node-first.
metric: (ref: string, id: string) => number | string | boolean | null | undefined
metrics: Array<{ id: string, name: string, target: 'node' | 'edge', valueType: string }>
\`\`\`

Example: \`const pr = metric('PageRank', node.node_id) ?? 0\`. Metrics only
exist while computed in the session — guard for \`undefined\`, and prefer
\`node.properties\` when an equivalent column exists.

A parameter can also be bound to the right-clicked node's metric with the
editor's node binding \`metric:<name>\` (like \`prop:<name>\`); the run aborts
with a message when the metric has no value for that node.

## Output shape (return value) — array of clusters

Each cluster object supports these fields:

\`\`\`js
{
  cluster_name: string,        // REQUIRED, human-readable label
  node_ids: string[],          // REQUIRED, ids of nodes in this cluster (must exist in \`nodes\`)
  cluster_class?: string,      // optional category tag (default 'default')
  figure?: 'circle' | 'box' | 'diamond' | 'hexagon' | 'star',  // default 'circle'
  state?: 'open' | 'closed',   // default 'closed' (closed = collapsed into one node)
  color?: string,              // optional hex color, e.g. '#42b883'
  description?: string,         // optional description
}
\`\`\`

### Rules the tool enforces (your code must satisfy them)

- \`cluster_name\` is required; \`node_ids\` must be an array.
- Every id in \`node_ids\` must reference a node that exists in \`nodes\`.
- \`figure\` must be one of: circle, box, diamond, hexagon, star.
- \`state\` must be 'open' or 'closed'.

## This graph's metadata (use these real values)

**Node types (${nodeTypes.length}):**
${bulletList(nodeTypes, 'no nodes loaded yet')}

**Edge / relationship types (${edgeTypes.length}):**
${bulletList(edgeTypes, 'no edges loaded yet')}

**Node properties (available under \`node.properties\`):**
${propertyList(nodeProperties, 'none declared')}

**Edge properties (available under \`edge.properties\`):**
${propertyList(edgeProperties, 'none declared')}

**Node metrics (session-computed, via \`metric('<name>', node.node_id)\`):**
${metricList(nodeMetrics, 'none computed in this session')}

**Edge metrics (session-computed, via \`metric('<name>', edge.edge_id)\`):**
${metricList(edgeMetrics, 'none computed in this session')}

## Worked example (group nodes by their type)

\`\`\`js
// Group nodes by node_type, one cluster per type
const byType = new Map();
nodes.forEach(node => {
  if (!byType.has(node.node_type)) byType.set(node.node_type, []);
  byType.get(node.node_type).push(node.node_id);
});

const colors = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#d946ef'];
const clusters = [];
let i = 0;
byType.forEach((nodeIds, nodeType) => {
  clusters.push({
    cluster_name: nodeType + ' Cluster',
    cluster_class: 'by-type',
    figure: 'circle',
    state: 'closed',
    node_ids: nodeIds,
    color: colors[i % colors.length],
    description: nodeIds.length + ' nodes of type ' + nodeType,
  });
  i++;
});

return clusters;
\`\`\`

## How to help me

I don't know exactly how I want to group the graph yet.
**Do NOT write code immediately.** First, **ask me questions, one topic at a time**,
to figure out the grouping I want. Use the node types, edge types and properties
listed above to make your questions concrete (reference the actual types/properties,
not generic ones).

Good questions to ask me include:
- What should each cluster represent? (e.g. one cluster per node type, per property
  value, per connected component, per hub-and-its-neighbors...)
- Which node types should be grouped, and which should be left out?
- Should grouping use a node property? If so, which one, and how (exact value,
  numeric ranges/buckets, a threshold)?
- Should the graph structure matter? (e.g. group nodes connected by a specific
  relationship type, or nodes reachable from a selected node)
- Any minimum/maximum cluster size, or clusters to ignore?
- Should clusters start collapsed (\`state: 'closed'\`) or expanded (\`state: 'open'\`),
  and do you want specific figures/colors?

Ask follow-ups until you have enough to build it. When you're confident you
understand, **then** write me the cluster program.

## When you write the program

- Return ONLY the JavaScript body (what goes inside the function), ending with
  \`return clusters;\` (or \`return [...]\`).
- Follow the input/output shapes and the enforced rules above.
- Briefly explain, in one or two sentences, what the program does.

Start by asking me your first question.
`
}
