import { describe, it, expect } from 'vitest';
import fixture from './fixtures/canvasTable.json';
import {
  neighborhoodTable,
  neighborhoodParams,
  withNeighborhoodValues,
  programHelpers,
  toTable,
  cell,
  MAX_CANVAS_COLUMNS,
  type CanvasGraph,
  type CanvasItem,
} from '../canvasTable';
import type { NeighborhoodTableSource } from '@/types/contextMenuActions';

const graph = fixture.graph as CanvasGraph;

describe('neighborhoodTable (shared fixture with the Python port)', () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      const result = neighborhoodTable(graph, c.item as CanvasItem, c.spec as NeighborhoodTableSource, undefined, (c as { rowLimit?: number }).rowLimit);
      expect(result).toEqual(c.expected);
    });
  }

  it('reads metric: columns through the resolver, by target', () => {
    const spec: NeighborhoodTableSource = { type: 'neighborhood', hops: 1, direction: 'out', list: 'nodes', columns: ['metric:pagerank'] };
    const seen: string[] = [];
    const result = neighborhoodTable(graph, { type: 'node', node_id: 'p1', node_type: 'Person' }, spec, (target, id, ref) => {
      seen.push(`${target}:${id}:${ref}`);
      return id === 'co' ? 0.5 : undefined;
    });
    expect(result.rows.map((r) => r[3])).toEqual(['0.5', null]);
    expect(seen).toEqual(['node:co:pagerank', 'node:a2:pagerank']);
  });

  it('the modal edits hops and direction, clamped', () => {
    const spec: NeighborhoodTableSource = { type: 'neighborhood', hops: 2, direction: 'out', list: 'nodes' };
    expect(neighborhoodParams(spec).map((p) => [p.id, p.default])).toEqual([['hops', '2'], ['direction', 'out']]);
    expect(withNeighborhoodValues(spec, { hops: '9', direction: 'in' })).toMatchObject({ hops: 5, direction: 'in' });
    expect(withNeighborhoodValues(spec, { hops: 'x', direction: 'sideways' })).toMatchObject({ hops: 1, direction: 'out' });
  });
});

describe('programHelpers', () => {
  const h = programHelpers(graph);
  it('hops: nearest first with .hop, the start left out, type and edge filters', () => {
    expect(h.hops('co', 2, { edgeTypes: ['OWNS', 'PARTNER_OF'] }).map((n) => [n.node_id, n.hop])).toEqual([['a1', 1], ['p1', 1], ['a2', 2]]);
    expect(h.hops('co', 2, { nodeTypes: ['Account'], edgeTypes: ['OWNS', 'PARTNER_OF'] }).map((n) => n.node_id)).toEqual(['a1', 'a2']);
    expect(h.neighbors('p1', { direction: 'in' })).toEqual([]);
    expect(h.node('a1')?.properties).toEqual({ branch: '001' });
  });
  it('edgesOf: once each, by type and direction', () => {
    expect(h.edgesOf(['a1', 'a3'], { types: ['TRANSFER'] }).map((e) => e.edge_id)).toEqual(['t1', 't3']);
    expect(h.edgesOf('x', { direction: 'out' })).toEqual([]);
    expect(h.edgesOf('x', { direction: 'in' }).map((e) => e.edge_id)).toEqual(['t2', 't3']);
  });
});

describe('toTable', () => {
  it('array of objects: columns in first-seen order, cells as text', () => {
    expect(toTable([{ a: 1, b: { c: true } }, { b: null, d: 'x' }])).toEqual({
      columns: ['a', 'b', 'd'],
      rows: [['1', '{"c":true}', null], [null, null, 'x']],
      truncated: false,
    });
  });
  it('{columns, rows}, plain values, and the row limit', () => {
    expect(toTable({ columns: ['k'], rows: [[1], [2], [3]] }, 2)).toEqual({ columns: ['k'], rows: [['1'], ['2']], truncated: true });
    expect(toTable(['a', 2])).toEqual({ columns: ['value'], rows: [['a'], ['2']], truncated: false });
    expect(toTable([])).toEqual({ columns: ['value'], rows: [], truncated: false });
  });
  it('caps columns and refuses what is not a table', () => {
    const wide = Object.fromEntries(Array.from({ length: MAX_CANVAS_COLUMNS + 10 }, (_, i) => [`c${i}`, i]));
    expect(toTable([wide]).columns).toHaveLength(MAX_CANVAS_COLUMNS);
    expect(() => toTable(42)).toThrow(/array of objects/);
    expect(() => toTable({ columns: 'a', rows: [] })).toThrow(/must be arrays/);
    expect(() => toTable({ columns: ['a'], rows: [1] })).toThrow(/Row 1/);
  });
  it('cell', () => {
    expect(cell(undefined)).toBeNull();
    expect(cell(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01T00:00:00.000Z');
  });
});
