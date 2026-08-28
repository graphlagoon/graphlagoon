import { describe, it, expect } from 'vitest';
import { buildCustomMetricSkill } from '@/utils/customMetricSkill';

const INPUT = {
  nodeTypes: ['Person', 'Company'],
  edgeTypes: ['OWNS'],
  nodeProperties: [
    { name: 'email', data_type: 'string', description: 'Contact e-mail' },
    { name: 'revenue', data_type: 'double' },
  ],
  edgeProperties: [{ name: 'amount', data_type: 'double' }],
  availableMetricNames: ['Degree (node)', 'PageRank (12:00:00) (node)'],
  existingCustomMetricNames: ['Email domain'],
  hasCommunities: true,
};

describe('buildCustomMetricSkill', () => {
  it('embeds the graph metadata, available metrics, taken names and community state', () => {
    const skill = buildCustomMetricSkill(INPUT);
    expect(skill).toContain('- Person');
    expect(skill).toContain('- OWNS');
    expect(skill).toContain('email (string) — Contact e-mail');
    expect(skill).toContain('amount (double)');
    expect(skill).toContain('- PageRank (12:00:00) (node)');
    expect(skill).toContain('- Email domain');
    expect(skill).toContain('a result exists');
  });

  it('documents the item / ctx contract and the sandbox rules', () => {
    const skill = buildCustomMetricSkill(INPUT);
    for (const s of [
      'function(item, ctx)',
      'ctx.neighbors(id)',
      'ctx.metric(ref, id?)',
      'ctx.community(id)',
      'ctx.cache',
      'sandboxed Web Worker',
      '10 seconds',
      'Custom metrics cannot read other custom metrics',
    ]) {
      expect(skill).toContain(s);
    }
  });

  it('asks the LLM to answer with the editor JSON shape and to interview first', () => {
    const skill = buildCustomMetricSkill(INPUT);
    expect(skill).toContain('"value_type": "number" | "string" | "boolean"');
    expect(skill).toContain('"target": "node" | "edge"');
    expect(skill).toContain('Do NOT write code immediately');
  });

  it('degrades gracefully on an empty graph', () => {
    const skill = buildCustomMetricSkill({
      nodeTypes: [],
      edgeTypes: [],
      nodeProperties: [],
      edgeProperties: [],
      availableMetricNames: [],
      existingCustomMetricNames: [],
      hasCommunities: false,
    });
    expect(skill).toContain('(no nodes loaded yet)');
    expect(skill).toContain('(none declared)');
    expect(skill).toContain("only the built-in Degree");
    expect(skill).toContain('(none yet)');
    expect(skill).toContain('none yet — `ctx.community(id)` returns null');
  });
});

describe('adapt mode', () => {
  it('switches the task, embeds the pasted JSON and the origin schema, and asks for a mapping first', () => {
    const skill = buildCustomMetricSkill({
      ...INPUT,
      importedJson: '[{"name":"Old","target":"node","value_type":"number","code":"return item.properties.receita;"}]',
      importedSource: { context_title: 'Old graph', node_types: ['Empresa'], relationship_types: [], node_properties: ['receita'], edge_properties: [] },
    });
    expect(skill).toContain('# Task: adapt "custom metrics"');
    expect(skill).toContain('item.properties.receita');
    expect(skill).toContain('Old graph');
    expect(skill).toContain('show me the mapping you intend to use');
    expect(skill).not.toContain('Do NOT write code immediately');
    expect(skill).toContain('output the bare array of');
  });

  it('a blank importedJson is not adapt mode', () => {
    const skill = buildCustomMetricSkill({ ...INPUT, importedJson: '   ' });
    expect(skill).toContain('# Task: write a "custom metric"');
  });
});
