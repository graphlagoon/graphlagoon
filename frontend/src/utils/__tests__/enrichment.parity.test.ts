import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { snapshotToGraph, unifyGraph, type UnifiedEdge, type UnifiedNode } from '@/utils/unifyGraph';
import { applyFileEnrichment, fileEnrichmentRows, type TableContent } from '@/utils/enrichment';
import type { GraphSnapshot, IdentityKey } from '@/types/graph';
import type { FileEnrichmentSpec } from '@/types/investigation';

// Shared with api/tests/test_enrichment_files.py (BYOD-2): both engines must emit exactly `expected`.
const ROOT = join(__dirname, '../../__tests__/fixtures/enrichment');

interface Fixture {
  contexts: Record<string, { identity_keys?: IdentityKey[] }>;
  sources: { id: string; context_id: string; nodes: GraphSnapshot['nodes']; edges: GraphSnapshot['edges'] }[];
  files: { id: string; spec: FileEnrichmentSpec; content: TableContent }[];
  expected: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
}

function pick(o: UnifiedNode | UnifiedEdge) {
  const conflicts = o.__conflicts && Object.keys(o.__conflicts).length
    ? Object.fromEntries(Object.entries(o.__conflicts).map(([k, v]) => [k, v.map((c) => ({ value: c.value, source_id: c.sourceId }))]))
    : null;
  return { properties: o.properties ?? {}, ...(conflicts ? { conflicts } : {}) };
}

describe('enrichment parity with the Python engine', () => {
  for (const name of readdirSync(ROOT).filter((f) => f.endsWith('.json')).sort()) {
    it(name, () => {
      const fx = JSON.parse(readFileSync(join(ROOT, name), 'utf-8')) as Fixture;
      const sources = fx.sources.map((s) => ({ id: s.id, contextId: s.context_id, ...snapshotToGraph(s) }));
      const graph = unifyGraph(sources, fx.contexts);
      for (const f of fx.files) applyFileEnrichment(graph, f.spec, fileEnrichmentRows(f.content, f.spec), f.id);
      expect(Object.fromEntries(graph.nodes.map((n) => [n.node_id, pick(n)]))).toEqual(fx.expected.nodes);
      expect(Object.fromEntries(graph.edges.map((e) => [e.edge_id, pick(e)]))).toEqual(fx.expected.edges);
    });
  }
});
