import { describe, expect, it } from 'vitest';
import { buildEnrichmentTablesSkill, type EnrichmentTablesSkillInput } from '../enrichmentTablesSkill';
import { parseEnrichmentTablesYaml } from '../enrichmentTablesYaml';

const input: EnrichmentTablesSkillInput = {
  title: 'Pix',
  datasourceType: 'sql_warehouse',
  edgeTable: 'main.pix.transfers',
  nodeTable: 'main.pix.accounts',
  edgeColumns: { edge_id: 'tx_id', src: 'from_acct', dst: 'to_acct', relationship_type: 'kind' },
  nodeColumns: { node_id: 'acct_id', node_type: 'acct_type' },
  edgeProperties: ['amount', 'tx_ref'],
  nodeProperties: ['holder'],
  nodeTypes: ['Account'],
  relationshipTypes: ['PIX'],
  currentYaml: 'enrichment_tables:\n  - name: kyc\n    label: KYC\n    table: main.pix.kyc\n',
};

describe('buildEnrichmentTablesSkill', () => {
  it('carries this context: tables, columns, properties, types and the current list', () => {
    const text = buildEnrichmentTablesSkill(input);
    expect(text).toContain('"Pix"');
    expect(text).toContain('Edge table `main.pix.transfers`: id `tx_id`, source `from_acct`, target `to_acct`');
    expect(text).toContain('Node table `main.pix.accounts`');
    expect(text).toContain('Edge properties (keys of `graph_edges.props`): `amount`, `tx_ref`');
    expect(text).toContain('Node types: `Account`');
    expect(text).toContain('name: kyc');
  });

  it('says every table must be listed when the graph is not on Delta tables', () => {
    const text = buildEnrichmentTablesSkill({ ...input, datasourceType: 'neptune', edgeTable: null, nodeTable: null, currentYaml: '' });
    expect(text).toContain('reads its graph from `neptune`');
    expect(text).toContain('Nothing yet.');
  });

  it('names the allowed sources when the server announced them', () => {
    const text = buildEnrichmentTablesSkill({ ...input, allowedSources: ['main.pix', 'ext.kyc.people'] });
    expect(text).toContain('must come from these allowed sources');
    expect(text).toContain('`main.pix`, `ext.kyc.people`');
    expect(buildEnrichmentTablesSkill(input)).toContain('sources the administrator allows');
  });

  it('its YAML example is what the form imports', () => {
    const text = buildEnrichmentTablesSkill(input);
    const example = text.split('## YAML format')[1].split('```yaml\n')[1].split('```')[0];
    const { tables, errors } = parseEnrichmentTablesYaml(example);
    expect(errors).toEqual([]);
    expect(tables.map((t) => [t.name, t.query?.target ?? null])).toEqual([
      ['channels', null], ['tx_risk', 'edges'], ['account_activity', 'nodes'], ['devices', null],
    ]);
  });
});
