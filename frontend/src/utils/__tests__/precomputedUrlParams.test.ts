/**
 * Which query keys belong to the precomputed graph, and how a link is watched.
 *
 * The denylist here is a security boundary of sorts: everything it does not
 * catch is forwarded to the server as a provider argument. And the signature is
 * what makes `?seed=7` → `?seed=8` refetch, so its two negative properties —
 * empty when no graph is named, and blind to style/layout — matter as much as
 * what it does include.
 */

import { describe, it, expect } from 'vitest';
import {
  isReservedKey,
  precomputedName,
  precomputedParams,
  precomputedQuerySignature,
} from '@/utils/precomputedUrlParams';
import { parseLayoutOverrides } from '@/utils/layoutUrlOverrides';

describe('isReservedKey', () => {
  it.each(['precomputed', 'style', 'exploration'])('reserves %s', (key) => {
    expect(isReservedKey(key)).toBe(true);
  });

  it.each([
    'layout',
    'layout.ego.focusNodeId',
    'layout.hive.scale',
    'layoutMode',
    'layoutFoo',
  ])('reserves the layout key %s', (key) => {
    expect(isReservedKey(key)).toBe(true);
  });

  it.each([
    'template',
    'template.node_id',
    'template.depth',
    'templateFoo',
  ])('reserves the template key %s', (key) => {
    // A template parameter forwarded as a provider argument would either 400
    // or, worse, be silently consumed by a provider that happens to declare
    // the same name.
    expect(isReservedKey(key)).toBe(true);
  });

  it('reserving template keys does not confuse the layout parser', () => {
    expect(parseLayoutOverrides({ 'template.p': 'x', template: 'T' }).present).toBe(
      false,
    );
  });

  it.each(['utm_source', 'utm_campaign', 'fbclid', 'gclid', 'mc_cid', '_hsenc'])(
    'ignores the tracking parameter %s',
    (key) => {
      expect(isReservedKey(key)).toBe(true);
    },
  );

  it.each(['seed', 'hops', 'edge_type', 'snapshot_date', 'max_edges'])(
    'forwards the provider argument %s',
    (key) => {
      expect(isReservedKey(key)).toBe(false);
    },
  );

  it('is a strict superset of what the layout parser claims', () => {
    // parseLayoutOverrides owns `layout.<mode>.<field>`; this denylist has to
    // cover at least that, or a layout key would leak into provider arguments.
    const layoutish = [
      'layout',
      'layout.ego.focusNodeId',
      'layout.ego.maxHops',
      'layout.hive.scale',
      'layout.hierarchical.direction',
    ];
    for (const key of layoutish) {
      expect(isReservedKey(key)).toBe(true);
    }
    // And it is genuinely wider: this one the layout parser ignores.
    expect(parseLayoutOverrides({ layoutMode: 'x' }).present).toBe(false);
    expect(isReservedKey('layoutMode')).toBe(true);
  });
});

describe('precomputedName', () => {
  it('reads the name', () => {
    expect(precomputedName({ precomputed: 'fraude-2024' })).toBe('fraude-2024');
  });

  it('is undefined when the URL names none', () => {
    expect(precomputedName({ style: 'dark' })).toBeUndefined();
  });

  it('treats an empty value as naming none', () => {
    expect(precomputedName({ precomputed: '' })).toBeUndefined();
  });

  it('takes the last of a repeated key, as hand-edited links do', () => {
    expect(precomputedName({ precomputed: ['a', 'b'] })).toBe('b');
  });
});

describe('precomputedParams', () => {
  it('forwards every non-reserved key', () => {
    expect(
      precomputedParams({ precomputed: 'g', seed: '99872', hops: '3' }),
    ).toEqual({ seed: '99872', hops: '3' });
  });

  it('forwards nothing when no graph is named', () => {
    // Arguments without a name belong to nobody; attaching them to whatever the
    // page is doing would be worse than dropping them.
    expect(precomputedParams({ seed: '99872' })).toEqual({});
  });

  it('drops style, exploration, layout and template keys', () => {
    expect(
      precomputedParams({
        precomputed: 'g',
        style: 'dark',
        exploration: 'exp-1',
        layout: 'ego',
        'layout.ego.maxHops': '2',
        template: 'T',
        'template.node_id': 'x',
        seed: '1',
      }),
    ).toEqual({ seed: '1' });
  });

  it('drops tracking parameters so a shared link still works', () => {
    expect(
      precomputedParams({ precomputed: 'g', utm_source: 'slack', seed: '1' }),
    ).toEqual({ seed: '1' });
  });

  it('collapses a repeated key to its last value', () => {
    expect(precomputedParams({ precomputed: 'g', seed: ['a', 'b'] })).toEqual({
      seed: 'b',
    });
  });

  it('reads a valueless key as an empty string', () => {
    expect(precomputedParams({ precomputed: 'g', seed: null })).toEqual({
      seed: '',
    });
  });

  it('refuses to write prototype keys', () => {
    const params = precomputedParams({
      precomputed: 'g',
      __proto__: 'polluted',
      constructor: 'polluted',
      seed: '1',
    } as Record<string, string>);
    expect(params).toEqual({ seed: '1' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('precomputedQuerySignature', () => {
  it('is empty when the URL names no precomputed graph', () => {
    // Load-bearing: otherwise a stray ?foo=1 on an ordinary context URL would
    // move the signature, fire the watcher, and re-run the default auto-load.
    expect(precomputedQuerySignature({})).toBe('');
    expect(precomputedQuerySignature({ foo: '1', style: 'dark' })).toBe('');
  });

  it('changes when the name changes', () => {
    expect(precomputedQuerySignature({ precomputed: 'a' })).not.toBe(
      precomputedQuerySignature({ precomputed: 'b' }),
    );
  });

  it('changes when an argument changes — the point of the whole mechanism', () => {
    expect(precomputedQuerySignature({ precomputed: 'g', seed: '7' })).not.toBe(
      precomputedQuerySignature({ precomputed: 'g', seed: '8' }),
    );
  });

  it('changes when an argument is added or removed', () => {
    expect(precomputedQuerySignature({ precomputed: 'g' })).not.toBe(
      precomputedQuerySignature({ precomputed: 'g', seed: '7' }),
    );
  });

  it('is stable under reordering, so rewriting a link by hand is a no-op', () => {
    expect(precomputedQuerySignature({ precomputed: 'g', a: '1', b: '2' })).toBe(
      precomputedQuerySignature({ b: '2', precomputed: 'g', a: '1' }),
    );
  });

  it('does not move when only the style changes', () => {
    // The ?style= watcher re-applies the preset without refetching the graph;
    // folding style in here would shadow that with a full reload.
    expect(precomputedQuerySignature({ precomputed: 'g', style: 'dark' })).toBe(
      precomputedQuerySignature({ precomputed: 'g', style: 'light' }),
    );
  });

  it('does not move when only a layout override changes', () => {
    expect(
      precomputedQuerySignature({ precomputed: 'g', 'layout.ego.maxHops': '2' }),
    ).toBe(
      precomputedQuerySignature({ precomputed: 'g', 'layout.ego.maxHops': '5' }),
    );
  });

  it('does not move when only a template param changes', () => {
    // A template alongside ?precomputed= is ignored, so editing its params
    // must not refire the precomputed watcher either.
    expect(
      precomputedQuerySignature({ precomputed: 'g', 'template.depth': '2' }),
    ).toBe(
      precomputedQuerySignature({ precomputed: 'g', 'template.depth': '5' }),
    );
  });

  it('does not move when only a tracking parameter is appended', () => {
    expect(precomputedQuerySignature({ precomputed: 'g' })).toBe(
      precomputedQuerySignature({ precomputed: 'g', utm_source: 'slack' }),
    );
  });
});
