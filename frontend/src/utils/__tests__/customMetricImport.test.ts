import { describe, it, expect } from 'vitest';
import {
  parseImportedCustomMetrics,
  customMetricCompatibilityWarnings,
  hasCustomMetricCompatibilityWarnings,
  extractCodeProperties,
  extractCodeMetricRefs,
} from '@/utils/customMetricImport';

const ONE = {
  name: 'Email domain',
  target: 'node',
  value_type: 'string',
  description: 'Domain part',
  code: "const m=/@([^@\\s]+)$/.exec(String(item.properties.email??'')); return m?m[1].toLowerCase():null;",
};

describe('parseImportedCustomMetrics', () => {
  it('accepts the bare object an LLM answers with and generates an id', () => {
    const r = parseImportedCustomMetrics(JSON.stringify(ONE));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.definitions).toHaveLength(1);
    expect(r.definitions[0]).toMatchObject(ONE);
    expect(r.definitions[0].id).toMatch(/[0-9a-f-]{20,}/);
    expect(r.source).toBeUndefined();
  });

  it('accepts a ```json fence, an array, value_type default and code as lines', () => {
    const fenced = '```json\n' + JSON.stringify([{ name: 'A', target: 'edge', code: ['const x = 1;', 'return x;'] }]) + '\n```';
    const r = parseImportedCustomMetrics(fenced);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.definitions[0]).toMatchObject({ name: 'A', target: 'edge', value_type: 'number', code: 'const x = 1;\nreturn x;' });
  });

  it('accepts the export envelope and carries its source schema', () => {
    const r = parseImportedCustomMetrics(
      JSON.stringify({
        graphlagoon_export: 'custom-metrics',
        export_version: 1,
        source: { context_title: 'Old', node_types: ['Person'], relationship_types: [], node_properties: ['email'], edge_properties: [] },
        metrics: [{ ...ONE, id: 'kept-id' }],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.definitions[0].id).toBe('kept-id');
    expect(r.source?.context_title).toBe('Old');
    expect(r.source?.node_properties).toEqual(['email']);
  });

  it('refuses another kind of export and malformed input', () => {
    expect(parseImportedCustomMetrics(JSON.stringify({ graphlagoon_export: 'style-preset', settings: {} }))).toMatchObject({
      ok: false,
      error: expect.stringContaining('"style-preset" export'),
    });
    expect(parseImportedCustomMetrics('not json')).toMatchObject({ ok: false, error: 'Not valid JSON' });
    expect(parseImportedCustomMetrics('[]')).toMatchObject({ ok: false, error: 'Empty list' });
    expect(parseImportedCustomMetrics('[1]')).toMatchObject({ ok: false, error: 'not an object' });
  });

  it('validates the fields the server would reject', () => {
    const bad = (patch: Record<string, unknown>) => parseImportedCustomMetrics(JSON.stringify({ ...ONE, ...patch }));
    expect(bad({ name: '  ' })).toMatchObject({ ok: false, error: 'missing "name"' });
    expect(bad({ name: 'x'.repeat(81) })).toMatchObject({ ok: false, error: expect.stringContaining('80') });
    expect(bad({ target: 'graph' })).toMatchObject({ ok: false, error: expect.stringContaining('"target"') });
    expect(bad({ value_type: 'date' })).toMatchObject({ ok: false, error: expect.stringContaining('"value_type"') });
    expect(bad({ code: '' })).toMatchObject({ ok: false, error: 'missing "code"' });
    expect(bad({ code: 'x'.repeat(20_001) })).toMatchObject({ ok: false, error: expect.stringContaining('20000') });
    expect(bad({ description: 'd'.repeat(501) })).toMatchObject({ ok: false, error: expect.stringContaining('500') });
    expect(bad({ description: 5 })).toMatchObject({ ok: false, error: expect.stringContaining('"description"') });
    // An invalid id is replaced, not rejected
    const r = bad({ id: 'has space' });
    expect(r.ok && r.definitions[0].id !== 'has space').toBe(true);
  });

  it('rejects duplicate names within one import and re-ids duplicate ids', () => {
    expect(parseImportedCustomMetrics(JSON.stringify([ONE, { ...ONE, name: 'EMAIL DOMAIN' }]))).toMatchObject({
      ok: false,
      error: 'Duplicate metric name "EMAIL DOMAIN"',
    });
    const r = parseImportedCustomMetrics(JSON.stringify([{ ...ONE, id: 'same' }, { ...ONE, id: 'same', name: 'Other' }]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.definitions[0].id).toBe('same');
    expect(r.definitions[1].id).not.toBe('same');
  });

  it('auto_run: accepted as a boolean, omitted when false, rejected otherwise', () => {
    const on = parseImportedCustomMetrics(JSON.stringify({ ...ONE, auto_run: true }));
    expect(on.ok && on.definitions[0].auto_run).toBe(true);
    const off = parseImportedCustomMetrics(JSON.stringify({ ...ONE, auto_run: false }));
    expect(off.ok && 'auto_run' in off.definitions[0]).toBe(false);
    expect(parseImportedCustomMetrics(JSON.stringify({ ...ONE, auto_run: 'yes' }))).toMatchObject({
      ok: false,
      error: expect.stringContaining('"auto_run"'),
    });
  });

  it('show_in_table: accepted as a boolean, omitted when false', () => {
    const on = parseImportedCustomMetrics(JSON.stringify({ ...ONE, show_in_table: true }));
    expect(on.ok && on.definitions[0].show_in_table).toBe(true);
    const off = parseImportedCustomMetrics(JSON.stringify({ ...ONE, show_in_table: false }));
    expect(off.ok && 'show_in_table' in off.definitions[0]).toBe(false);
    expect(parseImportedCustomMetrics(JSON.stringify({ ...ONE, show_in_table: 'y' }))).toMatchObject({ ok: false });
  });

  it('prefixes errors with the metric index when several were pasted', () => {
    expect(parseImportedCustomMetrics(JSON.stringify([ONE, { name: 'B', target: 'node' }]))).toMatchObject({
      ok: false,
      error: 'Metric 2: missing "code"',
    });
  });
});

describe('code scanning + compatibility warnings', () => {
  it('extracts property and metric references from code', () => {
    const code = `const a = item.properties.email; const b = item.properties['first name']; const c = ctx.node(x).properties["state"];
      const p = ctx.metric('pagerank'); const d = ctx.metrics['Degree']; const e = ctx.metrics.Closeness;`;
    expect(extractCodeProperties(code).sort()).toEqual(['email', 'first name', 'state']);
    expect(extractCodeMetricRefs(code).sort()).toEqual(['Closeness', 'Degree', 'pagerank']);
  });

  it('flags what this graph lacks and name collisions', () => {
    const w = customMetricCompatibilityWarnings(
      [
        { id: 'a', name: 'Email domain', target: 'node', value_type: 'string', code: "return item.properties.email + ctx.metric('pagerank');" },
        { id: 'b', name: 'Ok', target: 'edge', value_type: 'number', code: 'return Number(item.properties.amount);' },
      ],
      { nodeProperties: ['name'], edgeProperties: ['amount'], metricRefs: ['Degree', 'degree'], existingNames: ['email DOMAIN'] },
    );
    expect(w).toEqual({ missingProperties: ['email'], missingMetricRefs: ['pagerank'], nameCollisions: ['Email domain'] });
    expect(hasCustomMetricCompatibilityWarnings(w)).toBe(true);
    expect(
      hasCustomMetricCompatibilityWarnings(customMetricCompatibilityWarnings([], { nodeProperties: [], edgeProperties: [], metricRefs: [], existingNames: [] })),
    ).toBe(false);
  });
});
