/**
 * CodeMirror completions for the custom-metric editor — the `item` / `ctx`
 * contract of workers/customMetricEvaluate.ts plus a few starter snippets.
 */
import type { EditorCompletion } from '@/components/JavaScriptEditor.vue';
import type { MetricTarget } from '@/types/customMetrics';

const ITEM_NODE: EditorCompletion[] = [
  { label: 'item', type: 'variable', detail: '{ id, type, properties }' },
  { label: 'item.id', type: 'property', detail: 'string — node id' },
  { label: 'item.type', type: 'property', detail: 'string — node type' },
  { label: 'item.properties', type: 'property', detail: 'Record<string, unknown> (frozen)' },
];

const ITEM_EDGE: EditorCompletion[] = [
  { label: 'item', type: 'variable', detail: '{ id, relationship_type, src, dst, properties }' },
  { label: 'item.id', type: 'property', detail: 'string — edge id' },
  { label: 'item.relationship_type', type: 'property', detail: 'string' },
  { label: 'item.src', type: 'property', detail: 'string — source node id' },
  { label: 'item.dst', type: 'property', detail: 'string — target node id' },
  { label: 'item.properties', type: 'property', detail: 'Record<string, unknown> (frozen)' },
];

const CTX: EditorCompletion[] = [
  { label: 'ctx', type: 'variable', detail: 'evaluation context' },
  { label: 'ctx.degree', type: 'property', detail: 'number — this node\'s degree (nodes only)' },
  { label: 'ctx.degreeOf(id)', type: 'function', detail: 'number' },
  { label: 'ctx.neighbors(id)', type: 'function', detail: 'string[] — undirected, deduped' },
  { label: 'ctx.outNeighbors(id)', type: 'function', detail: 'string[]' },
  { label: 'ctx.inNeighbors(id)', type: 'function', detail: 'string[]' },
  { label: 'ctx.edgesOf(id)', type: 'function', detail: 'edge items touching id' },
  { label: 'ctx.hasEdge(src, dst)', type: 'function', detail: 'boolean — directed' },
  { label: 'ctx.isConnected(a, b)', type: 'function', detail: 'boolean — undirected' },
  { label: 'ctx.node(id)', type: 'function', detail: 'node item | undefined' },
  { label: 'ctx.metrics', type: 'property', detail: '{ [metricName]: value } for this item' },
  { label: 'ctx.metric(ref, id?)', type: 'function', detail: "value — ref = 'pagerank' (latest run), name or id" },
  { label: 'ctx.community(id)', type: 'function', detail: 'number | null' },
  { label: 'ctx.graph', type: 'property', detail: '{ nodeCount, edgeCount, meanDegree, density }' },
  { label: 'ctx.nodes', type: 'property', detail: 'all nodes (frozen)' },
  { label: 'ctx.edges', type: 'property', detail: 'all edges (frozen)' },
  { label: 'ctx.cache', type: 'property', detail: 'object shared across items of this run' },
];

const SNIPPETS_NODE: EditorCompletion[] = [
  {
    label: 'Property as number',
    type: 'snippet',
    detail: 'Template',
    apply: `const v = Number(item.properties.revenue);\nreturn Number.isFinite(v) ? v : null;`,
  },
  {
    label: 'Mean degree of neighbours',
    type: 'snippet',
    detail: 'Template',
    apply: `const ns = ctx.neighbors(item.id);\nreturn ns.length ? ns.reduce((s, n) => s + ctx.degreeOf(n), 0) / ns.length : 0;`,
  },
  {
    label: 'Text from two columns',
    type: 'snippet',
    detail: 'Template',
    apply: `const a = String(item.properties.first_name ?? '').trim();\nconst b = String(item.properties.last_name ?? '').trim();\nreturn (a + ' ' + b).replace(/\\s+/g, ' ').trim().toUpperCase();`,
  },
  {
    label: 'Flag by regex',
    type: 'snippet',
    detail: 'Template',
    apply: `return /\\.gov\\.br$/i.test(String(item.properties.website ?? ''));`,
  },
  {
    label: 'Bucket by another metric',
    type: 'snippet',
    detail: 'Template',
    apply: `const p = ctx.metric('pagerank') ?? 0;\nreturn p > 0.01 ? 'hub' : p > 0.001 ? 'mid' : 'leaf';`,
  },
];

const SNIPPETS_EDGE: EditorCompletion[] = [
  {
    label: 'Endpoint types label',
    type: 'snippet',
    detail: 'Template',
    apply: "return `${ctx.node(item.src)?.type ?? '?'} → ${ctx.node(item.dst)?.type ?? '?'}`;",
  },
  {
    label: 'Reciprocal edge',
    type: 'snippet',
    detail: 'Template',
    apply: `return ctx.hasEdge(item.dst, item.src);`,
  },
  {
    label: 'Amount normalised by source out-degree',
    type: 'snippet',
    detail: 'Template',
    apply: `const d = ctx.outNeighbors(item.src).length;\nreturn d ? (Number(item.properties.amount) || 0) / d : null;`,
  },
];

export function customMetricCompletions(target: MetricTarget): EditorCompletion[] {
  return target === 'node'
    ? [...ITEM_NODE, ...CTX, ...SNIPPETS_NODE]
    : [...ITEM_EDGE, ...CTX, ...SNIPPETS_EDGE];
}

export const DEFAULT_CODE: Record<MetricTarget, string> = {
  node: `// item: { id, type, properties }
// ctx:  { degree, degreeOf, neighbors, edgesOf, node, metrics, metric, community, graph, nodes, edges, cache }
// Return a number, string or boolean (matching the value type), or null.

return ctx.degree;
`,
  edge: `// item: { id, relationship_type, src, dst, properties }
// ctx:  { degreeOf, neighbors, edgesOf, hasEdge, node, metrics, metric, community, graph, nodes, edges, cache }
// Return a number, string or boolean (matching the value type), or null.

return Number(item.properties.weight ?? 1);
`,
};
