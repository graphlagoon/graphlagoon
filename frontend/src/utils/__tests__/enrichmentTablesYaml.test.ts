import { describe, expect, it } from 'vitest';
import { enrichmentTablesToYaml, mergeEnrichmentTables, parseEnrichmentTablesYaml } from '../enrichmentTablesYaml';

const YAML = `
enrichment_tables:
  - label: Transaction risk
    table: main.fraud.transactions
    query:
      run: auto
      sql: |
        SELECT e.edge_id, t.risk
        FROM graph_edges e
        JOIN main.fraud.transactions t ON t.tx_id = e.props['tx_id']
  - name: channels
    label: Channels
    table: main.fraud.channels
  - name: devices
    label: Login devices
    table: main.risk.devices
    key_column: account_id
    match_node_types: Conta
    columns: [device_id, ip]
    cardinality: many
`;

describe('parseEnrichmentTablesYaml', () => {
  it('reads queries, bare tables and lookups, naming entries from their label', () => {
    const { tables, errors } = parseEnrichmentTablesYaml(YAML);
    expect(errors).toEqual([]);
    expect(tables.map((t) => t.name)).toEqual(['transaction_risk', 'channels', 'devices']);
    expect(tables[0].query).toEqual({
      sql: "SELECT e.edge_id, t.risk\nFROM graph_edges e\nJOIN main.fraud.transactions t ON t.tx_id = e.props['tx_id']",
      target: 'edges', run: 'auto', overwrite: false, node_props: false,
    });
    expect(tables[1]).toEqual({ name: 'channels', label: 'Channels', table: 'main.fraud.channels' });
    expect(tables[2]).toMatchObject({ key_column: 'account_id', match_node_types: ['Conta'], columns: ['device_id', 'ip'], cardinality: 'many', match_source: 'node_id' });
  });

  it('accepts JSON, a bare list or one entry', () => {
    expect(parseEnrichmentTablesYaml('[{"label": "A", "table": "m.s.a"}]').tables[0].name).toBe('a');
    expect(parseEnrichmentTablesYaml('label: B\ntable: m.s.b').tables[0].name).toBe('b');
  });

  it('says what is wrong, entry by entry, and keeps the good ones', () => {
    const { tables, errors } = parseEnrichmentTablesYaml(`
- {label: ok, table: m.s.ok}
- {label: bad, table: devices}
- {label: lookup, table: m.s.l, key_column: id}
- {label: q, table: m.s.q, query: {sql: "", run: auto}}
- {label: r, table: m.s.graph_edges}
- {label: ok, table: m.s.again}
- {label: s, table: m.s.s, query: {sql: "SELECT 1", run: sometimes}}
`);
    expect(tables.map((t) => t.name)).toEqual(['ok']);
    expect(errors).toHaveLength(6);
    expect(errors[0]).toContain('catalog.schema.table');
    expect(errors[1]).toContain('needs match_node_types and columns');
    expect(errors[2]).toContain('query.sql is empty');
    expect(errors[3]).toContain('reserved');
    expect(errors[4]).toContain('used twice');
    expect(errors[5]).toContain('auto or manual');
    expect(parseEnrichmentTablesYaml('a: [').errors[0]).toContain('Not valid YAML');
    expect(parseEnrichmentTablesYaml('').errors[0]).toContain('Expected a list');
  });
});

describe('export and merge', () => {
  it('round-trips through YAML', () => {
    const { tables } = parseEnrichmentTablesYaml(YAML);
    const text = enrichmentTablesToYaml(tables);
    expect(text).toContain('sql: |');
    expect(parseEnrichmentTablesYaml(text).tables).toEqual(tables);
  });

  it('replaces entries by name and adds the rest', () => {
    const a = { name: 'a', label: 'A', table: 'm.s.a' };
    const b = { name: 'b', label: 'B', table: 'm.s.b' };
    const out = mergeEnrichmentTables([a, b], [{ ...b, label: 'B2' }, { name: 'c', label: 'C', table: 'm.s.c' }]);
    expect(out.tables.map((t) => t.label)).toEqual(['A', 'B2', 'C']);
    expect([out.added, out.replaced]).toEqual([1, 1]);
  });
});

describe('provider entries', () => {
  it('round-trips an entry enriched by a registered provider', () => {
    const entry = {
      name: 'kyc', label: 'KYC risk',
      provider: { name: 'kyc-demo', target: 'nodes' as const, run: 'auto' as const, overwrite: false, node_props: true },
    };
    const parsed = parseEnrichmentTablesYaml(enrichmentTablesToYaml([entry]));
    expect(parsed.errors).toEqual([]);
    expect(parsed.tables).toEqual([entry]);
  });

  it('keeps what an entry says it does, and refuses one that is not text', () => {
    const entries = [
      { name: 'kyc', label: 'KYC', description: 'KYC tier. Run before grouping by risk.', provider: { name: 'kyc-demo', target: 'nodes' as const, run: 'manual' as const, overwrite: false, node_props: false } },
      { name: 'devices', label: 'Devices', description: 'Login devices per account.', table: 'main.risk.devices' },
    ];
    const parsed = parseEnrichmentTablesYaml(enrichmentTablesToYaml(entries));
    expect(parsed.errors).toEqual([]);
    expect(parsed.tables).toEqual(entries);
    expect(parseEnrichmentTablesYaml('- {name: d, label: D, table: a.b.c, description: [1]}').errors[0]).toMatch(/description/);
    expect(parseEnrichmentTablesYaml(`- {name: d, label: D, table: a.b.c, description: ${'x'.repeat(1001)}}`).errors[0]).toMatch(/1000/);
  });

  it('round-trips a provider\'s parameters and what a run may change', () => {
    const entry = {
      name: 'kyc', label: 'KYC',
      provider: {
        name: 'kyc-demo', target: 'nodes' as const, run: 'manual' as const, overwrite: false, node_props: false, edge_props: true,
        params: { as_of_days: 90, source: 'bureau', strict: true }, runtime_params: ['as_of_days'],
      },
    };
    const parsed = parseEnrichmentTablesYaml(enrichmentTablesToYaml([entry]));
    expect(parsed.errors).toEqual([]);
    expect(parsed.tables).toEqual([entry]);
    expect(parseEnrichmentTablesYaml('- {name: k, label: K, provider: {name: kyc-demo, params: [1]}}').errors[0]).toContain('provider.params');
    expect(parseEnrichmentTablesYaml('- {name: k, label: K, provider: {name: kyc-demo, params: {a: [1]}}}').errors[0]).toContain('params.a');
    expect(parseEnrichmentTablesYaml('- {name: k, label: K, provider: {name: kyc-demo, runtime_params: days}}').errors[0]).toContain('runtime_params');
  });

  it('round-trips a table source and refuses one mixed with an enrichment', () => {
    const entry = {
      name: 'tx_history', label: 'Transactions', description: 'Transactions of one account.',
      table_provider: { name: 'tx-history', params: { tenant: 'pt', days: 90 }, runtime_params: ['account'] },
    };
    const parsed = parseEnrichmentTablesYaml(enrichmentTablesToYaml([entry]));
    expect(parsed.errors).toEqual([]);
    expect(parsed.tables).toEqual([entry]);
    expect(parseEnrichmentTablesYaml('- {name: t, label: T, table_provider: tx-history}').tables[0].table_provider).toEqual({ name: 'tx-history' });
    expect(parseEnrichmentTablesYaml('- {name: t, label: T, table_provider: tx-history, provider: kyc}').errors[0]).toMatch(/no table, query, lookup or provider/);
    expect(parseEnrichmentTablesYaml('- {name: t, label: T, table_provider: {name: tx-history, params: [1]}}').errors[0]).toContain('table_provider.params');
  });

  it('refuses a provider entry that also names a table', () => {
    const parsed = parseEnrichmentTablesYaml('- {name: kyc, label: K, table: a.b.c, provider: kyc-demo}');
    expect(parsed.errors[0]).toMatch(/no table/);
  });
});
