import { describe, it, expect } from 'vitest';
import { buildEnrichmentCleanSkill, buildEnrichmentFillSkill, stripCodeFence } from '@/utils/enrichmentSkill';

describe('buildEnrichmentFillSkill', () => {
  const input = {
    nodes: [
      { id: 'c1', type: 'Company', name: 'Acme, Inc' },
      { id: 'p1', type: 'Person', name: 'Ana' },
    ],
    total: 2,
    nodeProperties: ['name', 'tax_id'],
  };

  it('lists the nodes as CSV, quoting cells with commas', () => {
    const text = buildEnrichmentFillSkill(input);
    expect(text).toContain('node_id,type,name\nc1,Company,"Acme, Inc"\np1,Person,Ana');
  });

  it('asks for a CSV keyed by node_id with the ids unchanged, and no invented values', () => {
    const text = buildEnrichmentFillSkill(input);
    expect(text).toContain('first column `node_id`');
    expect(text).toContain('do not change, shorten or reformat them');
    expect(text).toContain('Never guess a value');
  });

  it('names the properties the nodes already have', () => {
    expect(buildEnrichmentFillSkill(input)).toContain('  - tax_id');
  });

  it('says when nodes were left out by the cap', () => {
    expect(buildEnrichmentFillSkill({ ...input, total: 900 })).toContain('Only the first 2 of 900 nodes are listed.');
    expect(buildEnrichmentFillSkill(input)).not.toContain('Only the first');
  });
});

describe('buildEnrichmentCleanSkill', () => {
  const input = {
    fileName: 'risk.csv',
    headLines: ['Risk review 2026', 'doc;risk', '12.345.678/0001-90;1.234,56'],
    samplesByType: [{ type: 'Company', ids: ['c1', 'c2'], properties: { tax_id: ['12345678000190'] } }],
  };

  it('embeds the head of the file and how keys look on the canvas', () => {
    const text = buildEnrichmentCleanSkill(input);
    expect(text).toContain('`risk.csv`, first 3 lines');
    expect(text).toContain('doc;risk\n12.345.678/0001-90;1.234,56');
    expect(text).toContain('### Company');
    expect(text).toContain('- node ids: `c1`, `c2`');
    expect(text).toContain('  - `tax_id`: `12345678000190`');
  });

  it('offers a script when the file is too large to paste', () => {
    expect(buildEnrichmentCleanSkill(input)).toContain('reads `risk.csv` and writes `clean.csv`');
  });
});

describe('stripCodeFence', () => {
  it('removes a fence around the answer', () => {
    expect(stripCodeFence('```csv\nnode_id,a\nc1,1\n```')).toBe('node_id,a\nc1,1');
  });
  it('leaves a plain answer as it is', () => {
    expect(stripCodeFence('  node_id,a\nc1,1\n')).toBe('node_id,a\nc1,1');
  });
});
