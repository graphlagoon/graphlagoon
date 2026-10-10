import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { applyAliases, snapshotToGraph, unifyGraph, type UnifiedGraph } from '@/utils/unifyGraph';
import type { GraphSnapshot, IdentityKey } from '@/types/graph';

// Shared with api/tests/test_case_graph.py (05 §8): both engines must emit exactly `expected`.
const ROOT = join(__dirname, '../../__tests__/fixtures/unify');

interface Fixture {
  contexts: Record<string, { identity_keys?: IdentityKey[] }>;
  sources: { id: string; context_id: string; nodes: GraphSnapshot['nodes']; edges: GraphSnapshot['edges'] }[];
  matches: { left: { uid: string }; right: { uid: string }; status: string }[];
  overrides: { identity_keys?: IdentityKey[] };
  expected: unknown;
}

/** Keys sorted at every level so the JSON text is comparable across engines. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

function canonical(g: UnifiedGraph) {
  const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    nodes: g.nodes
      .map((n) => ({
        uid: n.node_id,
        type: n.node_type,
        entity: n.__entity ?? null,
        properties: n.properties ?? {},
        sources: n.__sources.map((o) => ({ source_id: o.sourceId, node_id: o.nodeId })),
        ...(n.__conflicts
          ? {
              conflicts: Object.fromEntries(
                Object.entries(n.__conflicts).map(([k, v]) => [k, v.map((c) => ({ value: c.value, source_id: c.sourceId }))]),
              ),
            }
          : {}),
      }))
      .sort((a, b) => byText(a.uid, b.uid)),
    edges: g.edges
      .map((e) => ({
        id: e.edge_id,
        src: e.src,
        dst: e.dst,
        type: e.relationship_type,
        properties: e.properties ?? {},
        source_id: e.__source,
      }))
      .sort((a, b) => byText(a.id, b.id)),
  };
}

describe('unify parity fixtures', () => {
  for (const file of readdirSync(ROOT).filter((f) => f.endsWith('.json')).sort()) {
    it(file, () => {
      const fx: Fixture = JSON.parse(readFileSync(join(ROOT, file), 'utf-8'));
      const sources = fx.sources.map((s) => ({
        id: s.id,
        contextId: s.context_id,
        ...snapshotToGraph({ nodes: s.nodes, edges: s.edges } as GraphSnapshot),
      }));
      const unified = applyAliases(
        unifyGraph(sources, fx.contexts, fx.overrides.identity_keys ?? []),
        fx.matches.filter((m) => m.status === 'aceito').map((m) => [m.left.uid, m.right.uid]),
      );
      const got = canonical(unified);
      expect(got).toEqual(fx.expected);
      expect(JSON.stringify(sortKeys(got))).toBe(JSON.stringify(sortKeys(fx.expected)));
    });
  }
});
