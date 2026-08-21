import { describe, it, expect } from 'vitest';
import {
  LAYOUT_OVERRIDE_SCHEMA,
  SUPPORTED_LAYOUTS,
  layoutQuerySignature,
  parseLayoutOverrides,
  settableFieldNames,
  summarizeLayoutIssues,
  type QueryLike,
} from '@/utils/layoutUrlOverrides';

/** Issue codes raised for a query, in order. */
function codes(query: QueryLike): string[] {
  return parseLayoutOverrides(query).issues.map((issue) => issue.code);
}

describe('parseLayoutOverrides — algorithm', () => {
  it('reads ?layout=ego', () => {
    expect(parseLayoutOverrides({ layout: 'ego' }).algorithm).toBe('ego');
  });

  it.each(SUPPORTED_LAYOUTS)('accepts %s', (name) => {
    const result = parseLayoutOverrides({ layout: name });
    expect(result.algorithm).toBe(name);
    expect(result.issues).toEqual([]);
  });

  it.each(['circular', 'grid'])(
    'rejects %s — named in the type but never implemented',
    (name) => {
      const result = parseLayoutOverrides({ layout: name });
      expect(result.algorithm).toBeUndefined();
      expect(result.issues[0].code).toBe('unknown-algorithm');
    },
  );

  it('rejects an unknown algorithm without throwing', () => {
    const result = parseLayoutOverrides({ layout: 'spiral' });
    expect(result.algorithm).toBeUndefined();
    expect(result.issues[0].message).toContain('“spiral” is not a layout');
  });

  it('reports nothing when the query carries no layout params', () => {
    const result = parseLayoutOverrides({ style: 'investigacao', graph: 'x' });
    expect(result.present).toBe(false);
    expect(result.issues).toEqual([]);
    expect(result.modeConfig).toEqual({});
  });
});

describe('parseLayoutOverrides — key grammar', () => {
  it('flags layout.ego — too few segments', () => {
    expect(codes({ 'layout.ego': 'x' })).toEqual(['malformed-key']);
  });

  it('flags layout.ego.a.b — too many segments', () => {
    expect(codes({ 'layout.ego.a.b': 'x' })).toEqual(['malformed-key']);
  });

  it('flags an empty segment', () => {
    expect(codes({ 'layout..maxHops': '2' })).toEqual(['malformed-key']);
  });

  it('flags an unknown mode', () => {
    expect(codes({ 'layout.bogus.x': '1' })).toEqual(['unknown-mode']);
  });

  it('flags an unknown field', () => {
    const result = parseLayoutOverrides({ 'layout.ego.bogus': '1' });
    expect(result.issues[0].code).toBe('unknown-field');
    expect(result.issues[0].message).toContain('focusNodeId');
  });

  it('judges each key on its own — one typo does not discard the rest', () => {
    const result = parseLayoutOverrides({
      'layout.ego.maxHops': 'abc',
      'layout.ego.direction': 'out',
    });
    expect(result.modeConfig.ego).toEqual({ direction: 'out' });
    expect(result.issues).toHaveLength(1);
  });

  it('marks the query present even when every key is bad', () => {
    expect(parseLayoutOverrides({ 'layout.ego.bogus': '1' }).present).toBe(true);
  });
});

describe('parseLayoutOverrides — the allowlist', () => {
  it.each([
    ['layout.ego.ringSpacing', '80'],
    ['layout.ego.ringOrdering', 'community'],
    ['layout.ego.ringOrderingKey', 'risk'],
    ['layout.ego.crossingHeuristic', 'sifting'],
    ['layout.ego.crossingSweeps', '8'],
    ['layout.ego.arcIntraRingEdges', 'false'],
    ['layout.hierarchical.levelSpacing', '200'],
    ['layout.hierarchical.nodeSpacing', '50'],
  ])('refuses %s — appearance belongs to a style preset', (key, value) => {
    const result = parseLayoutOverrides({ [key]: value });
    expect(result.issues[0].code).toBe('unknown-field');
    expect(result.issues[0].message).toContain('style preset');
    expect(result.modeConfig).toEqual({});
  });

  it('refuses every hive field, since none is settable from a link', () => {
    const result = parseLayoutOverrides({ 'layout.hive.axisKey': 'node_type' });
    expect(result.issues[0].code).toBe('field-not-url-settable');
    expect(result.issues[0].message).toContain('no settings a link can change');
  });

  it('exposes only the semantic ego fields', () => {
    expect(settableFieldNames('ego')).toEqual([
      'focusNodeId',
      'direction',
      'maxHops',
      'edgeTypes',
    ]);
  });

  it('exposes only the semantic hierarchical fields', () => {
    expect(settableFieldNames('hierarchical')).toEqual([
      'traversal',
      'direction',
      'edgeTypes',
    ]);
  });
});

describe('parseLayoutOverrides — ego fields', () => {
  it('sets focusNodeId', () => {
    const result = parseLayoutOverrides({ 'layout.ego.focusNodeId': 'n1' });
    expect(result.modeConfig.ego).toEqual({ focusNodeId: 'n1' });
  });

  it('an empty focusNodeId clears the focus', () => {
    const result = parseLayoutOverrides({ 'layout.ego.focusNodeId': '' });
    expect(result.modeConfig.ego).toEqual({ focusNodeId: null });
  });

  it('keeps a node id that happens to read as null', () => {
    const result = parseLayoutOverrides({ 'layout.ego.focusNodeId': 'null' });
    expect(result.modeConfig.ego).toEqual({ focusNodeId: 'null' });
  });

  it.each(['both', 'out', 'in'])('parses direction=%s', (value) => {
    expect(
      parseLayoutOverrides({ 'layout.ego.direction': value }).modeConfig.ego,
    ).toEqual({ direction: value });
  });

  it('rejects an unknown direction', () => {
    expect(codes({ 'layout.ego.direction': 'sideways' })).toEqual(['unknown-enum']);
  });

  it('parses maxHops', () => {
    expect(parseLayoutOverrides({ 'layout.ego.maxHops': '3' }).modeConfig.ego).toEqual(
      { maxHops: 3 },
    );
  });

  it('an empty maxHops means no cutoff', () => {
    expect(parseLayoutOverrides({ 'layout.ego.maxHops': '' }).modeConfig.ego).toEqual({
      maxHops: null,
    });
  });

  it('accepts maxHops beyond the panel slider, which stops at 6', () => {
    expect(parseLayoutOverrides({ 'layout.ego.maxHops': '12' }).modeConfig.ego).toEqual(
      { maxHops: 12 },
    );
  });

  it('rejects a negative maxHops', () => {
    expect(codes({ 'layout.ego.maxHops': '-1' })).toEqual(['out-of-range']);
  });

  it('rejects maxHops beyond the sanity ceiling', () => {
    expect(codes({ 'layout.ego.maxHops': '999' })).toEqual(['out-of-range']);
  });

  it('rejects a fractional maxHops', () => {
    expect(codes({ 'layout.ego.maxHops': '2.5' })).toEqual(['not-an-integer']);
  });

  it('rejects 3abc, which parseInt would have accepted', () => {
    expect(codes({ 'layout.ego.maxHops': '3abc' })).toEqual(['not-a-number']);
  });

  it.each(['0x10', '1e3', 'Infinity', ' ', 'NaN'])('rejects %s as a number', (value) => {
    expect(codes({ 'layout.ego.maxHops': value })).toEqual(['not-a-number']);
  });

  it('parses edgeTypes as a comma-separated list', () => {
    const result = parseLayoutOverrides({ 'layout.ego.edgeTypes': 'KNOWS,WORKS_AT' });
    expect(result.modeConfig.ego).toEqual({ edgeTypes: ['KNOWS', 'WORKS_AT'] });
  });

  it('trims items and drops empty ones', () => {
    const result = parseLayoutOverrides({
      'layout.ego.edgeTypes': ' KNOWS , , WORKS_AT ',
    });
    expect(result.modeConfig.ego).toEqual({ edgeTypes: ['KNOWS', 'WORKS_AT'] });
  });

  it('an empty edgeTypes means all types', () => {
    expect(parseLayoutOverrides({ 'layout.ego.edgeTypes': '' }).modeConfig.ego).toEqual(
      { edgeTypes: null },
    );
  });

  it('a list of only commas means all types', () => {
    expect(parseLayoutOverrides({ 'layout.ego.edgeTypes': ',,' }).modeConfig.ego).toEqual(
      { edgeTypes: null },
    );
  });
});

describe('parseLayoutOverrides — hierarchical fields', () => {
  it('parses traversal and direction together', () => {
    const result = parseLayoutOverrides({
      'layout.hierarchical.traversal': 'out',
      'layout.hierarchical.direction': 'lr',
    });
    expect(result.modeConfig.hierarchical).toEqual({
      traversal: 'out',
      direction: 'lr',
    });
  });

  it('rejects an unknown direction', () => {
    expect(codes({ 'layout.hierarchical.direction': 'diagonal' })).toEqual([
      'unknown-enum',
    ]);
  });

  it('an empty edgeTypes means all types', () => {
    const result = parseLayoutOverrides({ 'layout.hierarchical.edgeTypes': '' });
    expect(result.modeConfig.hierarchical).toEqual({ edgeTypes: null });
  });
});

describe('parseLayoutOverrides — repeated params', () => {
  it('takes the last value when a param repeats', () => {
    const result = parseLayoutOverrides({ 'layout.ego.maxHops': ['1', '3'] });
    expect(result.modeConfig.ego).toEqual({ maxHops: 3 });
  });

  it('reports a conflict when the repeated values differ', () => {
    const result = parseLayoutOverrides({ 'layout.ego.maxHops': ['1', '3'] });
    expect(result.issues[0].code).toBe('conflicting-duplicate');
  });

  it('stays silent when a param is repeated identically', () => {
    const result = parseLayoutOverrides({ 'layout.ego.maxHops': ['3', '3'] });
    expect(result.issues).toEqual([]);
    expect(result.modeConfig.ego).toEqual({ maxHops: 3 });
  });

  it('treats a valueless param as empty', () => {
    const result = parseLayoutOverrides({ 'layout.ego.maxHops': null });
    expect(result.modeConfig.ego).toEqual({ maxHops: null });
    expect(result.issues).toEqual([]);
  });
});

describe('parseLayoutOverrides — output shape', () => {
  it('returns only the fields the URL named', () => {
    const result = parseLayoutOverrides({
      'layout.ego.focusNodeId': 'n1',
      'layout.ego.maxHops': '2',
    });
    // The property that makes handing this to updateLayoutModeConfig safe.
    expect(Object.keys(result.modeConfig.ego!).sort()).toEqual([
      'focusNodeId',
      'maxHops',
    ]);
  });

  it('omits a mode entirely when it has no valid overrides', () => {
    const result = parseLayoutOverrides({ 'layout.ego.maxHops': 'abc' });
    expect(result.modeConfig).toEqual({});
  });

  it('never lets a key reach through the prototype chain', () => {
    const result = parseLayoutOverrides({
      'layout.ego.__proto__': 'polluted',
      'layout.__proto__.x': 'polluted',
      'layout.ego.constructor': 'polluted',
    });
    expect(result.modeConfig).toEqual({});
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(result.issues).toHaveLength(3);
  });

  it('survives hostile values without throwing', () => {
    expect(() =>
      parseLayoutOverrides({
        'layout.ego.focusNodeId': 'x'.repeat(10_000),
        'layout.ego.edgeTypes': '\u{1F4A5}, ,<script>',
      }),
    ).not.toThrow();
  });
});

describe('summarizeLayoutIssues', () => {
  it('joins every message', () => {
    const { issues } = parseLayoutOverrides({
      'layout.ego.maxHops': 'abc',
      'layout.ego.direction': 'sideways',
    });
    const summary = summarizeLayoutIssues(issues);
    expect(summary).toContain('maxHops');
    expect(summary).toContain('direction');
  });

  it('is empty for no issues', () => {
    expect(summarizeLayoutIssues([])).toBe('');
  });
});

describe('layoutQuerySignature', () => {
  it('is stable across key order', () => {
    const a = layoutQuerySignature({ 'layout.ego.maxHops': '2', layout: 'ego' });
    const b = layoutQuerySignature({ layout: 'ego', 'layout.ego.maxHops': '2' });
    expect(a).toBe(b);
  });

  it('is empty when no layout params are present', () => {
    expect(layoutQuerySignature({ style: 'x', graph: 'y' })).toBe('');
  });

  it('changes when a value changes', () => {
    expect(layoutQuerySignature({ 'layout.ego.maxHops': '2' })).not.toBe(
      layoutQuerySignature({ 'layout.ego.maxHops': '3' }),
    );
  });

  it('ignores non-layout params', () => {
    expect(layoutQuerySignature({ layout: 'ego', style: 'x' })).toBe('layout=ego');
  });
});

describe('LAYOUT_OVERRIDE_SCHEMA', () => {
  it('gives every allowlisted field a parser', () => {
    for (const mode of Object.keys(LAYOUT_OVERRIDE_SCHEMA)) {
      const fields =
        LAYOUT_OVERRIDE_SCHEMA[mode as keyof typeof LAYOUT_OVERRIDE_SCHEMA];
      for (const [name, spec] of Object.entries(fields)) {
        expect(typeof spec.parse, `${mode}.${name}`).toBe('function');
        expect(spec.expects.length, `${mode}.${name}`).toBeGreaterThan(0);
      }
    }
  });
});
