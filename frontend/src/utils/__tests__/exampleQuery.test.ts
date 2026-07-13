import { describe, it, expect } from 'vitest';
import { generateBfsExampleQuery } from '@/utils/exampleQuery';
import { createGraphContext } from '@/__tests__/fixtures/contexts';
import { createNode } from '@/__tests__/fixtures/nodes';

describe('generateBfsExampleQuery', () => {
  it('always projects RETURN r (required by the visualization backend)', () => {
    const ctx = createGraphContext();
    const q = generateBfsExampleQuery(ctx, [createNode({ node_id: 'n1' })]);
    expect(/\bRETURN\s+r\b/.test(q)).toBe(true);
    // RETURN p / nodes(p) would be rejected by validation — must not appear.
    expect(q.includes('RETURN p')).toBe(false);
  });

  it('uses the schema node_id_col, not a hardcoded node_id', () => {
    const ctx = createGraphContext({
      node_structure: { node_id_col: 'node_id', node_type_col: 'node_type' },
    });
    const q = generateBfsExampleQuery(ctx, [createNode({ node_id: 'abc' })]);
    expect(q).toContain('MATCH (root { node_id: "abc" })');
  });

  it('respects a custom node_id_col from the context schema', () => {
    const ctx = createGraphContext({
      node_structure: { node_id_col: 'source_id', node_type_col: 'node_type' },
    });
    const q = generateBfsExampleQuery(ctx, [createNode({ node_id: 'X42' })]);
    expect(q).toContain('MATCH (root { source_id: "X42" })');
  });

  // With no nodes on screen (the default now that opening a context fetches nothing) a BFS
  // has no seed to start from, and there is no node on screen to copy an id from. The query
  // must therefore be runnable as-is — a `{node_id_value}` placeholder would be a dead end.
  describe('empty graph (no seed available)', () => {
    it('emits a query the user can run without editing it', () => {
      const q = generateBfsExampleQuery(createGraphContext(), []);

      // No placeholder to fill in.
      expect(q).not.toContain('_value}');
      expect(q).not.toContain('{');
      // Seedless edge scan.
      expect(q).toContain('MATCH ()-[r]-()');
      expect(q).toContain('LIMIT 1000');
    });

    it('still projects RETURN r (required by the visualization backend)', () => {
      const q = generateBfsExampleQuery(createGraphContext(), []);

      expect(/\bRETURN\s+r\b/.test(q)).toBe(true);
      expect(q.includes('RETURN p')).toBe(false);
    });

    it('does NOT emit a hardcoded node-type label', () => {
      const ctx = createGraphContext({ node_types: ['Person', 'Company'] });

      const q = generateBfsExampleQuery(ctx, []);

      expect(q).not.toContain(':Person');
      expect(q).not.toContain(':Company');
    });

    it('is runnable even with no context at all', () => {
      const q = generateBfsExampleQuery(null, []);

      expect(q).toContain('MATCH ()-[r]-()');
      expect(q).not.toContain('{');
      expect(/\bRETURN\s+r\b/.test(q)).toBe(true);
    });

    it('does not depend on the schema node_id_col (it references no id column)', () => {
      const ctx = createGraphContext({
        node_structure: { node_id_col: 'source_id', node_type_col: 'node_type' },
      });

      const q = generateBfsExampleQuery(ctx, []);

      expect(q).not.toContain('source_id');
    });
  });
});
