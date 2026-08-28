/**
 * Custom Metric Skill Builder
 *
 * Generates a self-contained, copy-pasteable prompt ("skill") a user can hand
 * to an LLM to get help writing a custom metric. It embeds the current graph's
 * metadata, the existing metric names (so `ctx.metric(...)` references are
 * real), the exact `item` / `ctx` contract of workers/customMetricEvaluate.ts,
 * the sandbox rules, and worked examples for each value type.
 *
 * Pure function — no store access.
 */
import { bulletList, propertyList, type SkillProperty } from './clusterProgramSkill'
import { sourceSchemaSection } from './stylePresetSkill'
import type { PortableSourceSchema } from '@/types/portable'

export interface CustomMetricSkillInput {
  nodeTypes: string[]
  edgeTypes: string[]
  nodeProperties: SkillProperty[]
  edgeProperties: SkillProperty[]
  /** Names of built-in / algorithm metrics currently available (`ctx.metrics` keys) */
  availableMetricNames: string[]
  /** Names already used by custom metrics on this context (must stay unique) */
  existingCustomMetricNames: string[]
  /** Whether a community detection result exists (`ctx.community`) */
  hasCommunities: boolean
  /** Metric JSON (bare object/array or export envelope) from another graph, to adapt. */
  importedJson?: string
  /** Schema of the graph the imported metrics came from, when known. */
  importedSource?: PortableSourceSchema
}

export function buildCustomMetricSkill(input: CustomMetricSkillInput): string {
  const {
    nodeTypes,
    edgeTypes,
    nodeProperties,
    edgeProperties,
    availableMetricNames,
    existingCustomMetricNames,
    hasCommunities,
  } = input
  const adapting = !!input.importedJson?.trim()

  const task = adapting
    ? `# Task: adapt "custom metrics" from another graph to this one`
    : `# Task: write a "custom metric" for a graph visualization tool`

  const intro = adapting
    ? `You are helping me reuse **custom metrics** of Graph Lagoon Studio — small
JavaScript snippets evaluated once per node (or per edge) that produce a
number, a text value or a boolean — that were exported from a **different
graph**. Their property names (and possibly the metric names they reference)
do not match this graph. Your job is to produce the same metrics, **rewritten
for the properties and metrics listed under "This graph's metadata"**. Your
final answer will be JSON that I paste into the metric editor's Import box.`
    : `You are helping me write a **custom metric** for Graph Lagoon Studio. A custom
metric is a small JavaScript snippet evaluated **once per node (or once per
edge)** of the loaded graph. It can produce a **number** (usable for node size /
edge width), a **text** value (a derived column: a domain extracted from an
e-mail, a category assigned by regex, two columns combined…) or a **boolean**
flag. I will paste your code into the tool's metric editor.

I don't know exactly what I want yet, so **start by asking me questions** (see
"How to help me" at the end) before writing any code.`

  const adaptSection = adapting
    ? `
## The metrics to adapt

${sourceSchemaSection(input.importedSource)}

Here are the exported metrics:

\`\`\`json
${input.importedJson!.trim()}
\`\`\`

Rules for adapting them:
- Rewrite every \`item.properties.<name>\` (and \`ctx.node(id).properties.<name>\`)
  to the **equivalent property in this graph**. If none exists, pick a sensible
  fallback from the list or return \`null\` — never keep a property this graph
  does not have.
- Rewrite \`ctx.metric('...')\` / \`ctx.metrics['...']\` references to metrics
  that exist here (listed below); drop the reference if there is no equivalent.
- Keep \`target\`, \`value_type\`, the logic and the names unless a name is
  already taken here (then suffix it).
- Do not wrap the answer in an export envelope — output the bare array of
  metric objects only.
`
    : ''

  const howToHelp = adapting
    ? `## How to help me

First, **show me the mapping you intend to use** (old property → new property,
old metric → new metric) as a short table and ask me to confirm anything
ambiguous. Only **then** output the final JSON array (no prose around it).`
    : `## How to help me

**Do NOT write code immediately.** First, **ask me questions, one topic at a
time**, using the real types, properties and metrics listed above:
- Should the metric apply to **nodes or edges**, and to which types?
- What should the value be — a **number** (for sizing / sorting), a **text**
  label/category, or a **true/false** flag?
- Which **properties** feed it, and how should missing or malformed values be
  handled (\`null\`, a default, a fallback column)?
- Does the **graph structure** matter (neighbours, degree, reciprocity,
  communities, an existing metric such as PageRank)?
- Any thresholds, buckets, regexes or formatting rules I have in mind?

Ask follow-ups until you have enough. When you're confident, write the metric.`

  return `${task}

${intro}
${adaptSection}

## How a custom metric runs

- Your code is the **body of \`function(item, ctx)\`**; it is called once per
  item and must \`return\` a value matching the metric's declared **value type**
  (\`number\`, \`string\` or \`boolean\`), or \`null\` when there is no value.
  Anything else (objects, NaN, Infinity, a number for a string metric…) is
  silently turned into \`null\`. Text is capped at 500 characters.
- It runs in a **sandboxed Web Worker**: no DOM, no network (\`fetch\`,
  \`XMLHttpRequest\`, \`WebSocket\`, \`importScripts\` are unavailable), no
  storage, no \`import\`/\`require\`. Plain JavaScript only (\`Math\`, \`Date\`,
  \`JSON\`, \`RegExp\`, \`Intl\`, \`Map\`/\`Set\` are fine).
- Each metric has **10 seconds** for the whole graph. Per-item cost should be
  small; if you need global work (a sort, a total), do it **once** through
  \`ctx.cache\` (see the percentile example).
- All inputs are **frozen** — do not mutate \`item\`, \`ctx.nodes\`, neighbour
  lists, etc. Throwing on an item just yields \`null\` for that item.
- Wrap anything that may fail (JSON.parse, Date.parse) so bad rows become
  \`null\` instead of errors.

## Input shape

\`\`\`js
// item — a node:
{ id: string, type: string, properties: Record<string, unknown> }
// item — an edge:
{ id: string, relationship_type: string, src: string, dst: string, properties: Record<string, unknown> }

// ctx
ctx.degree                  // this node's degree (nodes only; undefined for edges)
ctx.degreeOf(id)            // number
ctx.neighbors(id)           // string[] — undirected, deduped
ctx.outNeighbors(id) / ctx.inNeighbors(id)
ctx.edgesOf(id)             // edge items touching id
ctx.hasEdge(src, dst)       // boolean, directed
ctx.isConnected(a, b)       // boolean, undirected
ctx.node(id)                // node item | undefined
ctx.metrics                 // { [metricName]: value } for THIS item (built-in + algorithm metrics)
ctx.metric(ref, id?)        // one value: ref = 'pagerank' (latest run), a metric name, or a metric id
ctx.community(id)           // community id | null (from the last community detection)
ctx.graph                   // { nodeCount, edgeCount, meanDegree, density }
ctx.nodes / ctx.edges       // the whole loaded population (read-only)
ctx.cache                   // plain object shared by every item of one run — memoise global work
\`\`\`

Custom metrics cannot read other custom metrics.

## This graph's metadata (use these real values)

**Node types (${nodeTypes.length}):**
${bulletList(nodeTypes, 'no nodes loaded yet')}

**Edge / relationship types (${edgeTypes.length}):**
${bulletList(edgeTypes, 'no edges loaded yet')}

**Node properties (under \`item.properties\` for nodes):**
${propertyList(nodeProperties, 'none declared')}

**Edge properties (under \`item.properties\` for edges):**
${propertyList(edgeProperties, 'none declared')}

**Metrics available through \`ctx.metrics\` / \`ctx.metric(...)\`:**
${bulletList(availableMetricNames, 'only the built-in Degree — reachable as ctx.metric(\'degree\')')}

**Community detection:** ${hasCommunities ? 'a result exists — `ctx.community(id)` returns ids' : 'none yet — `ctx.community(id)` returns null'}

**Custom metric names already taken (pick a different one):**
${bulletList(existingCustomMetricNames, 'none yet')}

## Worked examples

Text (value type \`string\`):

\`\`\`js
// Domain of an e-mail column
const m = /@([^@\\s]+)$/.exec(String(item.properties.email ?? ''));
return m ? m[1].toLowerCase() : null;
\`\`\`

\`\`\`js
// Two columns combined, whitespace collapsed
const f = String(item.properties.first_name ?? '').trim();
const l = String(item.properties.last_name ?? '').trim();
return (f + ' ' + l).replace(/\\s+/g, ' ').trim().toUpperCase();
\`\`\`

\`\`\`js
// Bucket by the latest PageRank run
const p = ctx.metric('pagerank') ?? 0;
return p > 0.01 ? 'hub' : p > 0.001 ? 'mid' : 'leaf';
\`\`\`

Number (value type \`number\`):

\`\`\`js
// Mean degree of the neighbours
const ns = ctx.neighbors(item.id);
return ns.length ? ns.reduce((s, n) => s + ctx.degreeOf(n), 0) / ns.length : 0;
\`\`\`

\`\`\`js
// Percentile rank of a property — the sort runs once thanks to ctx.cache
if (!ctx.cache.sorted) {
  ctx.cache.sorted = ctx.nodes.map(n => Number(n.properties.revenue)).filter(Number.isFinite).sort((a, b) => a - b);
}
const v = Number(item.properties.revenue);
if (!Number.isFinite(v)) return null;
const s = ctx.cache.sorted;
let lo = 0, hi = s.length;
while (lo < hi) { const m = (lo + hi) >> 1; if (s[m] <= v) lo = m + 1; else hi = m; }
return lo / s.length;
\`\`\`

Boolean (value type \`boolean\`), for an edge:

\`\`\`js
// The edge is reciprocal
return ctx.hasEdge(item.dst, item.src);
\`\`\`

${howToHelp}

## When you write the metric${adapting ? 's' : ''}

Answer with exactly this JSON shape so I can paste it into the editor's
**Import JSON** box (one object, or an array of objects for several metrics):

\`\`\`json
{
  "name": "<short unique name>",
  "target": "node" | "edge",
  "value_type": "number" | "string" | "boolean",
  "description": "<one sentence>",
  "code": "<the JavaScript body, ending with a return>"
}
\`\`\`

Then explain in one or two sentences what it computes and what becomes
\`null\`.${adapting ? '' : ' Start by asking me your first question.'}
`
}
