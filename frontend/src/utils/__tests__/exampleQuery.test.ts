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

  it('does NOT emit a hardcoded node-type label in the fallback', () => {
    // node_types present, but no displayed nodes → fallback path.
    const ctx = createGraphContext({ node_types: ['Person', 'Company'] });
    const q = generateBfsExampleQuery(ctx, []);
    // No `:Person` / `:Company` label forced onto root.
    expect(q).toContain('MATCH (root { node_id: "{node_id_value}" })');
    expect(q).not.toContain(':Person');
    expect(q).not.toContain(':Company');
  });

  it('uses a schema-driven placeholder in the fallback (custom col)', () => {
    const ctx = createGraphContext({
      node_structure: { node_id_col: 'source_id', node_type_col: 'node_type' },
    });
    const q = generateBfsExampleQuery(ctx, []);
    expect(q).toContain('MATCH (root { source_id: "{source_id_value}" })');
  });

  it('falls back to node_id when context is null', () => {
    const q = generateBfsExampleQuery(null, []);
    expect(q).toContain('MATCH (root { node_id: "{node_id_value}" })');
    expect(/\bRETURN\s+r\b/.test(q)).toBe(true);
  });
});
