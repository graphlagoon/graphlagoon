import { describe, it, expect } from 'vitest';
import { parseImportedLabelFormats, mergeTextFormat } from '@/utils/labelFormatImport';
import type { TextFormatState } from '@/types/graph';

const RULES = [
  { name: 'Person', target: 'node', types: ['Person'], template: '{prop:name|upper}', priority: 20 },
  { name: 'Paid', target: 'edge', types: ['PAID'], template: '{prop:amount|currency:USD}' },
];

function ok(json: unknown) {
  const r = parseImportedLabelFormats(JSON.stringify(json));
  if (!r.ok) throw new Error(r.error);
  return r;
}

function error(json: unknown): string {
  const r = parseImportedLabelFormats(typeof json === 'string' ? json : JSON.stringify(json));
  if (r.ok) throw new Error('expected a parse error');
  return r.error;
}

describe('parseImportedLabelFormats', () => {
  it('rejects invalid JSON and non-label objects', () => {
    expect(error('{nope')).toBe('Not valid JSON');
    expect(error('"text"')).toContain('Expected a JSON object');
    expect(error({ foo: 1 })).toContain('Not label formats');
    expect(error({ rules: [], defaults: {} })).toContain('Nothing to import');
  });

  it('reads a bare {defaults, rules} object and fills the optional rule fields', () => {
    const r = ok({ defaults: { nodeTemplate: '{prop:name}' }, rules: RULES });
    expect(r.textFormat.defaults).toEqual({ nodeTemplate: '{prop:name}' });
    expect(r.textFormat.rules).toEqual([
      {
        name: 'Person', target: 'node', types: ['Person'], template: '{prop:name|upper}',
        priority: 20, enabled: true, scope: 'exploration', surface: 'label',
      },
      {
        name: 'Paid', target: 'edge', types: ['PAID'], template: '{prop:amount|currency:USD}',
        priority: 100, enabled: true, scope: 'exploration', surface: 'label',
      },
    ]);
  });

  it('reads the export envelope with its source schema', () => {
    const r = ok({
      graphlagoon_export: 'label-formats',
      export_version: 1,
      source: { context_title: 'Fraud', node_types: ['Person'], relationship_types: [], node_properties: ['name'], edge_properties: [] },
      textFormat: { defaults: {}, rules: RULES, syntaxVersion: 2 },
    });
    expect(r.textFormat.rules).toHaveLength(2);
    expect(r.source?.context_title).toBe('Fraud');
    expect(r.source?.node_types).toEqual(['Person']);
  });

  it('reads a bare array of rules and a single rule', () => {
    expect(ok(RULES).textFormat.rules).toHaveLength(2);
    expect(ok(RULES[0]).textFormat.rules).toHaveLength(1);
  });

  it('lifts the labels out of a style preset, envelope or bare settings', () => {
    const textFormat = { defaults: { edgeTemplate: '{src}' }, rules: [RULES[0]] };
    const fromEnvelope = ok({ graphlagoon_export: 'style-preset', settings: { nodeTypeColors: { A: '#fff' }, textFormat } });
    expect(fromEnvelope.textFormat.rules[0].name).toBe('Person');
    expect(fromEnvelope.textFormat.defaults).toEqual({ edgeTemplate: '{src}' });
    expect(ok({ textFormat, nodeTypeColors: {} }).textFormat.rules).toHaveLength(1);
    expect(error({ settings: { nodeTypeColors: {} } })).toBe('This style preset has no label formats');
  });

  it('rejects another kind of export', () => {
    expect(error({ graphlagoon_export: 'context-menu-actions', actions: [] })).toBe(
      'This file is a "context-menu-actions" export, not label formats',
    );
  });

  it('ignores the id of an imported rule', () => {
    const r = ok([{ ...RULES[0], id: 'format-rule-old' }]);
    expect(r.textFormat.rules[0]).not.toHaveProperty('id');
  });

  it('names the rule that is wrong and imports nothing', () => {
    expect(error([RULES[0], { target: 'node', template: 'x' }])).toBe('Rule 2: missing "name"');
    expect(error([{ ...RULES[0], target: 'both' }])).toBe('Rule 1 ("Person"): "target" must be "node" or "edge"');
    expect(error([{ ...RULES[0], template: '' }])).toBe('Rule 1 ("Person"): missing "template"');
    expect(error([{ ...RULES[0], template: '{prop:name' }])).toContain('Rule 1 ("Person"): Unbalanced braces');
    expect(error([{ ...RULES[0], types: 'Person' }])).toContain('"types" must be an array');
    expect(error([{ ...RULES[0], priority: 'high' }])).toContain('"priority" must be a number');
    expect(error([{ ...RULES[0], surface: 'hover' }])).toContain('"surface" must be one of');
    expect(error({ rules: 'x' })).toBe('"rules" must be an array');
  });

  it('validates default templates', () => {
    expect(error({ defaults: { nodeTemplate: '{prop:name' } })).toContain('Default node template: Unbalanced braces');
    expect(error({ defaults: { edgeTooltipTemplate: 3 } })).toBe('Default edge tooltip: must be a string');
    // An empty tooltip is a real value: "show the label".
    expect(ok({ defaults: { nodeTooltipTemplate: '' } }).textFormat.defaults).toEqual({ nodeTooltipTemplate: '' });
  });

  it('keeps surface, enabled and a valid scope', () => {
    const r = ok([{ ...RULES[0], surface: 'tooltip', enabled: false, scope: 'context' }]);
    expect(r.textFormat.rules[0]).toMatchObject({ surface: 'tooltip', enabled: false, scope: 'context' });
  });
});

describe('mergeTextFormat', () => {
  const current: TextFormatState = {
    defaults: { nodeTemplate: '{node_id}', edgeTemplate: '{relationship_type}', nodeTooltipTemplate: 'tip', edgeTooltipTemplate: '' },
    rules: [
      { id: 'r1', name: 'Company', target: 'node', types: ['Company'], template: '{prop:name}', priority: 10, enabled: true, scope: 'exploration' },
      { id: 'r2', name: 'Person', target: 'node', types: ['Person'], template: '{prop:name}', priority: 10, enabled: true, scope: 'exploration' },
      { id: 'r3', name: 'Person', target: 'edge', types: [], template: '{src}', priority: 10, enabled: true, scope: 'exploration' },
    ],
  };
  const imported = ok({ defaults: { nodeTemplate: '{prop:name}' }, rules: RULES }).textFormat;

  it('updates the rule with the same target and name in place and appends the rest', () => {
    const { state, added, updated } = mergeTextFormat(current, imported);
    expect([added, updated]).toEqual([1, 1]);
    expect(state.rules.map((r) => r.name)).toEqual(['Company', 'Person', 'Person', 'Paid']);
    expect(state.rules[1]).toMatchObject({ id: 'r2', template: '{prop:name|upper}', priority: 20 });
    // Same name on the other target is a different rule.
    expect(state.rules[2]).toMatchObject({ id: 'r3', template: '{src}' });
    expect(state.rules[3].id).toMatch(/^format-rule-/);
  });

  it('changes only the defaults the import names', () => {
    const { state } = mergeTextFormat(current, imported);
    expect(state.defaults).toEqual({ ...current.defaults, nodeTemplate: '{prop:name}' });
  });

  it('drops the current rules first when asked', () => {
    const { state, added, updated, removed } = mergeTextFormat(current, imported, { replaceRules: true });
    expect([added, updated, removed]).toEqual([2, 0, 3]);
    expect(state.rules.map((r) => r.name)).toEqual(['Person', 'Paid']);
    expect(state.defaults.nodeTooltipTemplate).toBe('tip');
  });

  it('does not touch the current state', () => {
    const before = JSON.stringify(current);
    mergeTextFormat(current, imported);
    expect(JSON.stringify(current)).toBe(before);
  });

  it('keeps duplicate names of an export apart', () => {
    const twins = ok([RULES[0], { ...RULES[0], template: '{node_id}' }]).textFormat;
    const { state } = mergeTextFormat({ ...current, rules: [] }, twins);
    expect(state.rules.map((r) => r.template)).toEqual(['{prop:name|upper}', '{node_id}']);
  });
});
