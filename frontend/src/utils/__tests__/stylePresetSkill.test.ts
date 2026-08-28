import { describe, it, expect } from 'vitest';
import { buildStylePresetSkill, sourceSchemaSection } from '../stylePresetSkill';

const INPUT = {
  nodeTypes: ['Customer', 'Merchant'],
  edgeTypes: ['PAID'],
  nodeProperties: [
    { name: 'full_name', data_type: 'string', description: 'Display name' },
    { name: 'segment', data_type: 'string' },
  ],
  edgeProperties: [{ name: 'amount', data_type: 'double' }],
  layoutAlgorithms: ['force', 'ego', 'grid'],
};

describe('buildStylePresetSkill', () => {
  it('embeds the graph metadata and the accepted layouts', () => {
    const skill = buildStylePresetSkill(INPUT);
    expect(skill).toContain('- Customer');
    expect(skill).toContain('- PAID');
    expect(skill).toContain('full_name (string) — Display name');
    expect(skill).toContain('amount (double)');
    expect(skill).toContain('`force`, `ego`, `grid`');
  });

  it('documents the settings shape', () => {
    const skill = buildStylePresetSkill(INPUT);
    for (const key of [
      '"nodeTypeColors"',
      '"edgeTypeIcons"',
      '"nodePropertyIconConfigs"',
      '"textFormat"',
      '"visual_mapping"',
      '"property_visibility"',
    ]) {
      expect(skill).toContain(key);
    }
  });

  it('interviews the user when writing from scratch', () => {
    const skill = buildStylePresetSkill(INPUT);
    expect(skill).toContain('# Task: write "style preset"'.replace('"style preset"', 'a "style preset"'));
    expect(skill).toContain('Do NOT write JSON immediately');
    expect(skill).not.toContain('## The preset to adapt');
  });

  it('switches to adapt mode when an imported preset is given', () => {
    const imported = JSON.stringify({ nodeTypeColors: { Person: '#fff' } });
    const skill = buildStylePresetSkill({
      ...INPUT,
      importedJson: imported,
      importedSource: {
        context_title: 'Old graph',
        node_types: ['Person'],
        relationship_types: ['KNOWS'],
        node_properties: ['name'],
        edge_properties: [],
      },
    });
    expect(skill).toContain('# Task: adapt a "style preset"');
    expect(skill).toContain('## The preset to adapt');
    expect(skill).toContain('"Old graph"');
    expect(skill).toContain('- Person');
    expect(skill).toContain('- KNOWS');
    expect(skill).toContain(imported);
    expect(skill).toContain('show me the mapping');
    expect(skill).not.toContain('Do NOT write JSON immediately');
  });

  it('tells the LLM to infer the old schema when the export lacks one', () => {
    const skill = buildStylePresetSkill({ ...INPUT, importedJson: '{"aesthetics":{}}' });
    expect(skill).toContain('did not record the schema');
  });

  it('treats whitespace-only imports as no import', () => {
    const skill = buildStylePresetSkill({ ...INPUT, importedJson: '   ' });
    expect(skill).not.toContain('## The preset to adapt');
  });
});

describe('sourceSchemaSection', () => {
  it('lists query templates when the source recorded them', () => {
    const text = sourceSchemaSection({
      node_types: [],
      relationship_types: [],
      node_properties: [],
      edge_properties: [],
      query_templates: [{ id: 'old-1', name: 'Old', parameters: ['p'] }],
    });
    expect(text).toContain('`old-1`');
    expect(text).toContain('NOT valid here');
  });
});
