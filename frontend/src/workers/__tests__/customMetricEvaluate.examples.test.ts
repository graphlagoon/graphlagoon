/**
 * The use-case catalogue from the custom-metrics design, run verbatim
 * through the pure evaluation core. These snippets double as the examples
 * in docs/guide/communities-metrics.md — keep them in sync.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildIndexes, evaluateDefinition } from '@/workers/customMetricEvaluate';
import type { CustomMetricIndexes } from '@/workers/customMetricEvaluate';
import type { CustomMetricRunnable, MetricValueType } from '@/types/customMetrics';
import { makeCustomMetricSnapshot, FIXTURE_NOW } from '@/__tests__/fixtures/customMetricGraph';

let ix: CustomMetricIndexes;

function run(code: string, value_type: MetricValueType = 'number', target: 'node' | 'edge' = 'node') {
  const def: CustomMetricRunnable = { id: 'd', target, value_type, code };
  const r = evaluateDefinition(def, ix);
  return { map: new Map(r.values), ...r };
}

beforeEach(() => {
  ix = buildIndexes(makeCustomMetricSnapshot());
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// A. Text columns
// ---------------------------------------------------------------------------
describe('A. text columns', () => {
  it('A1 full name normalised (two columns + regex whitespace collapse)', () => {
    const { map, errorCount } = run(
      `const f=String(item.properties.first_name??'').trim(), l=String(item.properties.last_name??'').trim(); return (f+' '+l).replace(/\\s+/g,' ').trim().toUpperCase();`,
      'string',
    );
    expect(errorCount).toBe(0);
    expect(map.get('p1')).toBe('ANA SILVA');
    expect(map.get('p2')).toBe('BRUNO COSTA');
    expect(map.get('p3')).toBe('');
  });

  it('A2 email domain (regex extract)', () => {
    const { map } = run(
      `const m=/@([^@\\s]+)$/.exec(String(item.properties.email??'')); return m?m[1].toLowerCase():null;`,
      'string',
    );
    expect(map.get('p1')).toBe('foo.com');
    expect(map.get('p2')).toBe('bar.org');
    expect(map.get('p3')).toBeNull();
  });

  it('A3 CNPJ formatted (strip non-digits + replace with groups)', () => {
    const { map } = run(
      `const d=String(item.properties.cnpj??'').replace(/\\D/g,''); return d.length===14?d.replace(/(\\d{2})(\\d{3})(\\d{3})(\\d{4})(\\d{2})/,'$1.$2.$3/$4-$5'):d;`,
      'string',
    );
    expect(map.get('c1')).toBe('12.345.678/0001-95');
    expect(map.get('c2')).toBe('12345678901');
    expect(map.get('c3')).toBe('');
  });

  it('A4 entity kind by regex on the name', () => {
    const { map } = run(
      `const n=String(item.properties.name??''); if(/\\b(LTDA|S\\.?A\\.?|EIRELI|ME)\\b/i.test(n))return 'company'; if(/^\\p{Lu}\\p{Ll}+( \\p{Lu}\\p{Ll}+)+$/u.test(n))return 'person'; return 'unknown';`,
      'string',
    );
    expect(map.get('c1')).toBe('company');
    expect(map.get('c2')).toBe('company');
    expect(map.get('c3')).toBe('company');
    expect(map.get('p1')).toBe('person');
    expect(map.get('p3')).toBe('unknown');
  });

  it('A5 hub bucket from the latest PageRank run (by algorithm id)', () => {
    const { map } = run(
      `const p=ctx.metric('pagerank')??0; return p>0.01?'hub':p>0.001?'mid':'leaf';`,
      'string',
    );
    expect(map.get('hub')).toBe('hub');
    expect(map.get('p1')).toBe('mid');
    expect(map.get('c3')).toBe('leaf');
    expect(map.get('p2')).toBe('leaf'); // no value → leaf
  });

  it('A5b ctx.metrics is keyed by metric name; ctx.metric accepts name and id', () => {
    const { map } = run(`return ctx.metrics['Degree'] + ':' + ctx.metric('__builtin_degree');`, 'string');
    expect(map.get('hub')).toBe('6:6');
    const byName = run(`return ctx.metric('PageRank (12:00:00)', 'hub');`, 'number');
    expect(byName.map.get('iso')).toBe(0.02); // explicit id argument
  });

  it('A6 field from a JSON property (malformed → null, not an item error)', () => {
    const { map, errorCount } = run(
      `try{return JSON.parse(item.properties.meta).country??null}catch{return null}`,
      'string',
    );
    expect(errorCount).toBe(0);
    expect(map.get('p1')).toBe('BR');
    expect(map.get('p2')).toBeNull();
  });

  it('A7 edge: endpoint types label', () => {
    const { map } = run(
      'return `${ctx.node(item.src)?.type??\'?\'} → ${ctx.node(item.dst)?.type??\'?\'}`;',
      'string',
      'edge',
    );
    expect(map.get('e1')).toBe('Person → Company');
    expect(map.get('e3')).toBe('Person → Person');
  });

  it('A8 community label', () => {
    const { map } = run(`const c=ctx.community(item.id); return c==null?'none':'C'+c;`, 'string');
    expect(map.get('p1')).toBe('C0');
    expect(map.get('c3')).toBe('C2');
    expect(map.get('iso')).toBe('none');
  });

  it('A9 age bucket from a date property', () => {
    const { map } = run(
      `const t=Date.parse(item.properties.created_at); if(Number.isNaN(t))return null; const d=(Date.now()-t)/864e5; return d<30?'new':d<365?'active':'old';`,
      'string',
    );
    expect(map.get('p1')).toBe('new');
    expect(map.get('p2')).toBe('active');
    expect(map.get('p3')).toBe('old');
    expect(map.get('c1')).toBeNull();
  });

  it('A10 combine a property with the degree', () => {
    const { map } = run('return `${String(item.properties.state??\'??\').toUpperCase()}-${ctx.degree}`;', 'string');
    expect(map.get('p1')).toBe('SP-4');
    expect(map.get('iso')).toBe('MG-0');
  });
});

// ---------------------------------------------------------------------------
// B. Numeric columns
// ---------------------------------------------------------------------------
describe('B. numeric columns', () => {
  it('B1 degree reimplemented equals ctx.degree for every node', () => {
    const { map } = run(`return ctx.edgesOf(item.id).length;`);
    for (const n of ix.nodes) expect(map.get(n.id)).toBe(ix.degreeMap.get(n.id) ?? 0);
    expect(map.get('hub')).toBe(6);
    expect(map.get('iso')).toBe(0);
  });

  it('B2 mean degree of the graph, reimplemented (constant per node)', () => {
    const { map } = run(`return 2*ctx.graph.edgeCount/Math.max(ctx.graph.nodeCount,1);`);
    const expected = (2 * 11) / 8;
    for (const n of ix.nodes) expect(map.get(n.id)).toBeCloseTo(expected);
    expect(ix.summary.meanDegree).toBeCloseTo(expected);
  });

  it('B3 mean degree of the neighbours', () => {
    const { map } = run(
      `const ns=ctx.neighbors(item.id); return ns.length?ns.reduce((s,n)=>s+ctx.degreeOf(n),0)/ns.length:0;`,
    );
    expect(map.get('p3')).toBe((2 + 6) / 2); // c2, hub
    expect(map.get('iso')).toBe(0);
    expect(map.get('c3')).toBe(6);
  });

  it('B4 neighbours of a given type', () => {
    const { map } = run(`return ctx.neighbors(item.id).filter(n=>ctx.node(n)?.type==='Company').length;`);
    expect(map.get('hub')).toBe(3);
    expect(map.get('p1')).toBe(1);
    expect(map.get('iso')).toBe(0);
  });

  it('B5 homophily: share of neighbours with the same state', () => {
    const { map } = run(
      `const s=item.properties.state, ns=ctx.neighbors(item.id); return ns.length?ns.filter(n=>ctx.node(n)?.properties.state===s).length/ns.length:null;`,
    );
    expect(map.get('p1')).toBeCloseTo(2 / 3); // c1 SP, p2 RJ, hub SP
    expect(map.get('iso')).toBeNull();
  });

  it('B6 local clustering coefficient', () => {
    const { map } = run(
      `const ns=ctx.neighbors(item.id); if(ns.length<2)return 0; let t=0; for(let i=0;i<ns.length;i++)for(let j=i+1;j<ns.length;j++)if(ctx.isConnected(ns[i],ns[j]))t++; return 2*t/(ns.length*(ns.length-1));`,
    );
    expect(map.get('p2')).toBe(1);
    expect(map.get('p1')).toBe(1);
    expect(map.get('c3')).toBe(0);
    expect(map.get('hub')).toBeCloseTo(4 / 15);
  });

  it('B7 ratio with guards (never Infinity)', () => {
    const { map } = run(
      `const r=Number(item.properties.revenue), e=Number(item.properties.employees); return Number.isFinite(r)&&e>0?r/e:null;`,
    );
    expect(map.get('p1')).toBeNull(); // employees = 0
    expect(map.get('c1')).toBe(10);
  });

  it('B8 percentile rank via ctx.cache (global work done once)', () => {
    const code = `if(!ctx.cache.s){ctx.cache.calls=(ctx.cache.calls||0)+1; ctx.cache.s=ctx.nodes.map(n=>Number(n.properties.revenue)).filter(Number.isFinite).sort((a,b)=>a-b);} const v=Number(item.properties.revenue); if(!Number.isFinite(v))return null; const s=ctx.cache.s; let lo=0,hi=s.length; while(lo<hi){const m=(lo+hi)>>1; if(s[m]<=v)lo=m+1;else hi=m;} return lo/s.length;`;
    const { map } = run(code);
    expect(map.get('c1')).toBe(1); // max revenue
    expect(map.get('c3')).toBe(1 / 8); // min revenue
    // The cache is shared across items: the sort ran exactly once.
    const probe = run(
      `if(!ctx.cache.s){ctx.cache.calls=(ctx.cache.calls||0)+1; ctx.cache.s=ctx.nodes.map(n=>Number(n.properties.revenue)).sort((a,b)=>a-b);} return ctx.cache.calls;`,
    );
    for (const n of ix.nodes) expect(probe.map.get(n.id)).toBe(1);
  });

  it('B9 edge: log-scaled amount', () => {
    const { map } = run(`return Math.log10(1+Math.max(0,Number(item.properties.amount)||0));`, 'number', 'edge');
    expect(map.get('e1')).toBeCloseTo(3);
  });

  it('B10 edge: amount normalised by the source out-degree', () => {
    const { map } = run(
      `const d=ctx.outNeighbors(item.src).length; return d?(Number(item.properties.amount)||0)/d:null;`,
      'number',
      'edge',
    );
    expect(map.get('e1')).toBe(999 / 2); // p1 → {c1, p2}
    expect(map.get('e11')).toBe(1 / 6);
  });

  it('B11 edge: Jaccard of the endpoint neighbourhoods', () => {
    const { map } = run(
      `const a=new Set(ctx.neighbors(item.src)),b=ctx.neighbors(item.dst); const i=b.filter(x=>a.has(x)).length; const u=a.size+b.length-i; return u?i/u:0;`,
      'number',
      'edge',
    );
    expect(map.get('e3')).toBeCloseTo(0.5); // N(p1)={c1,p2,hub}, N(p2)={c1,p1,hub}
  });

  it('B12 two-hop reach', () => {
    const { map } = run(
      `const seen=new Set([item.id]); for(const n of ctx.neighbors(item.id)){seen.add(n); for(const m of ctx.neighbors(n))seen.add(m);} return seen.size-1;`,
    );
    expect(map.get('iso')).toBe(0);
    expect(map.get('c3')).toBe(6); // hub + its 5 other neighbours
    expect(map.get('hub')).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// C. Boolean columns
// ---------------------------------------------------------------------------
describe('C. boolean columns', () => {
  it('C1 super-hub: degree above twice the mean degree', () => {
    const { map } = run(`return ctx.degree>ctx.graph.meanDegree*2;`, 'boolean');
    expect(map.get('hub')).toBe(true);
    for (const n of ix.nodes) if (n.id !== 'hub') expect(map.get(n.id)).toBe(false);
  });

  it('C2 government website (regex)', () => {
    const { map } = run(`return /\\.gov\\.br$/i.test(String(item.properties.website??''));`, 'boolean');
    expect(map.get('p1')).toBe(true);
    expect(map.get('p3')).toBe(false);
    expect(map.get('c1')).toBe(false);
  });

  it('C3 isolated under the current filter', () => {
    const { map } = run(`return ctx.degree===0;`, 'boolean');
    expect(map.get('iso')).toBe(true);
    expect(map.get('p1')).toBe(false);
  });

  it('C4 edge is reciprocal', () => {
    const { map } = run(`return ctx.hasEdge(item.dst,item.src);`, 'boolean', 'edge');
    expect(map.get('e3')).toBe(true);
    expect(map.get('e4')).toBe(true);
    expect(map.get('e1')).toBe(false);
  });

  it('C5 endpoints in the same community', () => {
    const { map } = run(
      `const a=ctx.community(item.src),b=ctx.community(item.dst); return a!=null&&a===b;`,
      'boolean',
      'edge',
    );
    expect(map.get('e1')).toBe(true);
    expect(map.get('e5')).toBe(true);
    expect(map.get('e8')).toBe(false);
    expect(map.get('e11')).toBe(false);
  });
});
