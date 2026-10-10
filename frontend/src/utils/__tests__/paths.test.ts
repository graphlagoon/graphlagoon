import { describe, it, expect } from 'vitest';
import fixture from '@/__tests__/fixtures/paths/small.json';
import { findPaths, type Path, type PathEdge, type PathParams } from '@/utils/paths';

const edges = fixture.edges as PathEdge[];
const run = (c: (typeof fixture.cases)[number], es = edges) =>
  findPaths(es, c.source, c.target, { ...(fixture.base as PathParams), ...(c.params as Partial<PathParams>) });
const rounded = (ps: Path[]) => ps.map((p) => ({ ...p, cost: Number(p.cost.toFixed(9)) }));

describe('paths (03 §6.3)', () => {
  it('matches every fixture case (parity with the Python port)', () => {
    for (const c of fixture.cases) {
      const got = run(c);
      if ('expected' in c) expect(rounded(got), c.name).toEqual(c.expected);
      else expect(got, c.name).toHaveLength(c.expectedCount!);
    }
  });

  it('does not depend on the input edge order', () => {
    const shuffled = [...edges].reverse();
    for (const c of fixture.cases) expect(run(c, shuffled), c.name).toEqual(run(c));
  });
});
