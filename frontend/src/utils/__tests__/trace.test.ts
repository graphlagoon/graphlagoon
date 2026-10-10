import { describe, it, expect } from 'vitest';
import fixture from '@/__tests__/fixtures/trace/golpe-pix.json';
import { toTraceEdges, traceForward, type TraceEdge, type TraceParams, type TraceResult } from '@/utils/trace';

const edges = toTraceEdges(fixture.edges, fixture.edge_semantics);
const types = Object.fromEntries(fixture.nodes.map(n => [n.node_id, n.node_type]));
const params = fixture.params as unknown as TraceParams;
const run = (p: Partial<TraceParams> = {}) =>
  traceForward(edges, types, fixture.seed, { ...params, ...p });
const retained = (r: TraceResult) =>
  Object.fromEntries(Object.entries(r.nodes).filter(([, n]) => n.retained > 0).map(([id, n]) => [id, n.retained]));
const sum = (vs: number[]) => vs.reduce((s, v) => s + v, 0);

describe('temporal trace, forward (03 §6.1)', () => {
  it('matches every fixture case (parity with the Python port)', () => {
    for (const c of fixture.cases) {
      const { method, ...result } = run(c.params as Partial<TraceParams>);
      expect(result, c.name).toEqual(c.expected);
      expect(method.seedEdgeIds).toEqual(['e2']);
    }
  });

  it('FIFO: exits, retained and coverage of the T5 screen', () => {
    const r = run();
    expect(r.exits).toEqual({ 'saque-atm': 2000, 'exchange-gama': 1550, 'bet-delta': 880 });
    expect(r.exitTotal).toBe(4430);
    expect(Math.round(r.coverage * 100)).toBe(91);
    expect(retained(r)).toEqual({ '4471-0': 70, '8812-7': 350, '3090-1': 20 });
    expect(r.nodes['4471-0'].layer).toBe(1);
    expect(r.nodes['8812-7'].layer).toBe(2);
  });

  it('proportional and LIBR on the same fixture', () => {
    const p = run({ allocation: 'proportional' });
    expect(p.exits['exchange-gama']).toBe(1597.73);
    expect(p.nodes['8812-7'].retained).toBe(302.27);
    expect(Math.round(p.coverage * 100)).toBe(92);
    const l = run({ allocation: 'libr' });
    expect(l.exits).toEqual(run().exits);
    expect(retained(l)).toEqual(retained(run()));
  });

  it('Δ = 40 min cuts only the 15:05 exit (54 min dwell)', () => {
    const r = run({ maxDwellMs: 40 * 60_000 });
    expect(r.exits).toEqual({ 'saque-atm': 2000, 'bet-delta': 880 }); // 31 and 16 min dwell
    expect(r.edgeTrace.e8).toBeUndefined();
    expect(r.discarded.expired).toBe(1900);
  });

  it('respects stops, layers and the minimum amount', () => {
    const stop = run({ stopNodes: ['8812-7'] });
    expect(stop.exits['8812-7']).toBe(1900);
    expect(stop.edgeTrace.e8).toBeUndefined();

    const h1 = run({ maxHops: 1 });
    expect(h1.frontier).toEqual([
      { edgeId: 'e3', amount: 2000 },
      { edgeId: 'e4', amount: 1900 },
      { edgeId: 'e5', amount: 900 },
    ]);
    expect(h1.exits).toEqual({});

    const m = run({ minAmount: 900 });
    expect(m.edgeTrace.e6).toBe(880); // still recorded
    expect(m.exits['bet-delta']).toBeUndefined();
    expect(m.discarded.belowMin).toBe(880);
  });

  it('conserves value: seed = exits + retained + frontier + discarded (all rules but total)', () => {
    for (const c of fixture.cases.filter(c => c.params.allocation !== 'total')) {
      const r = run(c.params as Partial<TraceParams>);
      const rest = r.exitTotal + sum(Object.values(r.nodes).map(n => n.retained))
        + sum(r.frontier.map(f => f.amount)) + r.discarded.belowMin + r.discarded.expired;
      expect(rest, c.name).toBeCloseTo(r.seedTotal, 2);
    }
  });

  it('separates FIFO, LIBR and total contamination (1.000 in, 800 out, 500 untraced in, 400 out)', () => {
    const e = (id: string, src: string, dst: string, amount: number, t: number): TraceEdge => ({ id, src, dst, amount, t });
    const g = [e('s', 'v', 'A', 1000, 1), e('o1', 'A', 'X', 800, 2), e('u', 'ext', 'A', 500, 3), e('o2', 'A', 'Y', 400, 4)];
    const base: TraceParams = {
      direction: 'forward', maxHops: 3, maxDwellMs: null, minAmount: 0, window: null,
      allocation: 'fifo', stopTypes: [], stopNodes: [],
    };
    const traced = (allocation: TraceParams['allocation']) =>
      traceForward(g, {}, { edgeIds: ['s'] }, { ...base, allocation }).edgeTrace.o2 ?? 0;
    expect(traced('fifo')).toBe(200);
    expect(traced('libr')).toBe(0);
    expect(traced('total')).toBe(400);
  });

  it('breaks time ties by edge id, whatever the input order', () => {
    const shuffled = [...edges].reverse();
    expect(traceForward(shuffled, types, fixture.seed, params)).toEqual(run());
  });
});
