import { describe, it, expect } from 'vitest';
import { resolveTemplateAfterRun } from '@/utils/templateAfterRun';

describe('resolveTemplateAfterRun', () => {
  it('is null when the template sets nothing', () => {
    expect(resolveTemplateAfterRun(undefined, [], {})).toBeNull();
    expect(resolveTemplateAfterRun({}, [], {})).toBeNull();
  });

  it('substitutes $params, switches to ego and centres it on the focus node', () => {
    const resolved = resolveTemplateAfterRun(
      { layout: 'ego', focus: '$account', 'layout.ego.maxHops': '$hops' },
      ['account', 'hops'],
      { account: 'acct-9931', hops: '2' },
    )!;
    expect(resolved.layout.algorithm).toBe('ego');
    expect(resolved.layout.modeConfig.ego).toEqual({ focusNodeId: 'acct-9931', maxHops: 2 });
    expect(resolved.focusNodeId).toBe('acct-9931');
    expect(resolved.issues).toEqual([]);
  });

  it('keeps a hard-coded ego centre distinct from the focus node', () => {
    const resolved = resolveTemplateAfterRun(
      { layout: 'ego', 'layout.ego.focusNodeId': 'hub', focus: 'leaf' },
      [],
      {},
    )!;
    expect(resolved.layout.modeConfig.ego?.focusNodeId).toBe('hub');
    expect(resolved.focusNodeId).toBe('leaf');
  });

  it('focus alone moves the camera and does not change the layout', () => {
    const resolved = resolveTemplateAfterRun({ focus: '$n' }, ['n'], { n: 'a' })!;
    expect(resolved.layout.algorithm).toBeUndefined();
    expect(resolved.layout.modeConfig).toEqual({});
    expect(resolved.focusNodeId).toBe('a');
  });

  it('a blank optional parameter skips its field without an issue', () => {
    const resolved = resolveTemplateAfterRun(
      { layout: 'ego', focus: '$n', 'layout.ego.maxHops': '$hops' },
      ['n', 'hops'],
      { n: '', hops: '' },
    )!;
    expect(resolved.focusNodeId).toBeUndefined();
    expect(resolved.layout.algorithm).toBe('ego');
    expect(resolved.layout.modeConfig).toEqual({});
    expect(resolved.issues).toEqual([]);
  });

  it('drops a bad field, reports it and keeps the rest (fail-open)', () => {
    const resolved = resolveTemplateAfterRun(
      { layout: 'spiral', focus: 'a', 'layout.ego.maxHops': 'many' },
      [],
      {},
    )!;
    expect(resolved.layout.algorithm).toBeUndefined();
    expect(resolved.focusNodeId).toBe('a');
    expect(resolved.issues).toHaveLength(2);
    expect(resolved.issues.join(' ')).toContain('spiral');
  });
});
