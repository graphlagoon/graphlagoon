import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildUrlFromTemplate, openUrl, validateUrlTemplate } from '../safeUrl';
import { createNode } from '@/__tests__/fixtures/nodes';
import { createEdge } from '@/__tests__/fixtures/edges';

describe('validateUrlTemplate', () => {
  it('accepts http/https prefixes only', () => {
    expect(validateUrlTemplate('https://x.com/{prop:id}')).toBeNull();
    expect(validateUrlTemplate('http://x.com')).toBeNull();
    expect(validateUrlTemplate('  https://x.com')).toBeNull();
    expect(validateUrlTemplate('javascript:alert(1)')).not.toBeNull();
    expect(validateUrlTemplate('ftp://x.com')).not.toBeNull();
    expect(validateUrlTemplate('/relative/path')).not.toBeNull();
    expect(validateUrlTemplate('{prop:url}')).not.toBeNull();
  });
});

describe('buildUrlFromTemplate', () => {
  it('interpolates node properties URL-encoded', () => {
    const node = createNode({ properties: { q: 'a b&c=d/e?f#g' } });
    const result = buildUrlFromTemplate('https://x.com/search?q={prop:q}', 'node', node);
    expect(result).toEqual({
      ok: true,
      url: `https://x.com/search?q=${encodeURIComponent('a b&c=d/e?f#g')}`,
    });
  });

  it('encodes built-in fields too (node_id, edge src/dst)', () => {
    const node = createNode({ node_id: 'id with space' });
    const nodeResult = buildUrlFromTemplate('https://x.com/{node_id}', 'node', node);
    expect(nodeResult).toEqual({ ok: true, url: 'https://x.com/id%20with%20space' });

    const edge = createEdge({ src: 'a/b', dst: 'c d' });
    const edgeResult = buildUrlFromTemplate('https://x.com/{src}/{dst}', 'edge', edge);
    expect(edgeResult).toEqual({ ok: true, url: 'https://x.com/a%2Fb/c%20d' });
  });

  it('reports missing referenced properties instead of opening a partial URL', () => {
    const node = createNode({ properties: { present: 'x' } });
    const result = buildUrlFromTemplate(
      'https://x.com/{prop:present}/{prop:absent}',
      'node',
      node,
    );
    expect(result).toEqual({ ok: false, missing: ['absent'] });
  });

  it('treats unloaded (deferred) properties as missing', () => {
    const node = createNode(); // no properties at all yet
    const result = buildUrlFromTemplate('https://x.com/{prop:symbol}', 'node', node);
    expect(result).toEqual({ ok: false, missing: ['symbol'] });
  });

  it('rejects non-http(s) templates before interpolating', () => {
    const node = createNode({ properties: { u: 'x' } });
    const result = buildUrlFromTemplate('javascript:alert({prop:u})', 'node', node);
    expect(result.ok).toBe(false);
    expect('error' in result && result.error).toContain('must start with http');
  });

  it('a property value cannot smuggle a different scheme (it is encoded into the path)', () => {
    const node = createNode({ properties: { u: 'javascript:alert(1)' } });
    const result = buildUrlFromTemplate('https://x.com/{prop:u}', 'node', node);
    expect(result).toEqual({
      ok: true,
      url: `https://x.com/${encodeURIComponent('javascript:alert(1)')}`,
    });
  });

  it('rejects a result that does not parse as a URL', () => {
    const node = createNode({ properties: { u: 'x' } });
    const result = buildUrlFromTemplate('https://', 'node', node);
    expect(result.ok).toBe(false);
  });
});

describe('openUrl', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('new-tab uses window.open with noopener,noreferrer', () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    openUrl('https://x.com', 'new-tab');
    expect(openSpy).toHaveBeenCalledWith('https://x.com', '_blank', 'noopener,noreferrer');
  });

  it('same-tab uses location.assign', () => {
    const assignSpy = vi
      .spyOn(window.location, 'assign')
      .mockImplementation(() => undefined);
    openUrl('https://x.com', 'same-tab');
    expect(assignSpy).toHaveBeenCalledWith('https://x.com');
  });
});

describe('metric refs in URL templates', () => {
  const RAW_ID = 'id with space';
  const metricValues: Record<string, string | number> = {
    score: 'a b&c=d/e?f#g',
    PR: 0.5,
  };
  // Keyed by the RAW item id — proves the lookup never sees the encoded id.
  const resolver = (target: 'node' | 'edge', itemId: string, ref: string) =>
    target === 'node' && itemId === RAW_ID ? metricValues[ref] : undefined;

  it('interpolates metric values URL-encoded', () => {
    const node = createNode({ node_id: RAW_ID });
    const result = buildUrlFromTemplate('https://x.com/?s={metric:score}', 'node', node, {
      metrics: resolver,
    });
    expect(result).toEqual({
      ok: true,
      url: `https://x.com/?s=${encodeURIComponent('a b&c=d/e?f#g')}`,
    });
  });

  it('uses the raw item id for the metric lookup even when the id needs encoding', () => {
    const node = createNode({ node_id: RAW_ID });
    const result = buildUrlFromTemplate('https://x.com/{node_id}?pr={metric:PR}', 'node', node, {
      metrics: resolver,
    });
    expect(result).toEqual({ ok: true, url: 'https://x.com/id%20with%20space?pr=0.5' });
  });

  it('reports missing metrics as metric:<ref>, alongside missing properties', () => {
    const node = createNode({ node_id: RAW_ID, properties: { present: 'x' } });
    const result = buildUrlFromTemplate(
      'https://x.com/{prop:present}/{prop:absent}/{metric:nope}',
      'node',
      node,
      { metrics: resolver },
    );
    expect(result).toEqual({ ok: false, missing: ['absent', 'metric:nope'] });
  });

  it('without a resolver every metric ref is missing (never a sentinel URL)', () => {
    const node = createNode({ node_id: RAW_ID });
    const result = buildUrlFromTemplate('https://x.com/{metric:PR}', 'node', node);
    expect(result).toEqual({ ok: false, missing: ['metric:PR'] });
  });

  it('guards metric conditional refs too', () => {
    const node = createNode({ node_id: RAW_ID });
    const ok = buildUrlFromTemplate(
      'https://x.com/{if:metric:PR>0.1|hub|leaf}',
      'node',
      node,
      { metrics: resolver },
    );
    expect(ok).toEqual({ ok: true, url: 'https://x.com/hub' });
    const missing = buildUrlFromTemplate(
      'https://x.com/{if:metric:nope>0.1|hub|leaf}',
      'node',
      node,
      { metrics: resolver },
    );
    expect(missing).toEqual({ ok: false, missing: ['metric:nope'] });
  });
});
