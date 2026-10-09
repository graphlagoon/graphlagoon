import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildUrlFromTemplate, isAppUrl, openUrl, urlScheme, validateUrlTemplate } from '../safeUrl';
import { createNode } from '@/__tests__/fixtures/nodes';
import { createEdge } from '@/__tests__/fixtures/edges';

describe('validateUrlTemplate', () => {
  it('accepts web links with an explicit http(s):// prefix', () => {
    expect(validateUrlTemplate('https://x.com/{prop:id}')).toBeNull();
    expect(validateUrlTemplate('http://x.com')).toBeNull();
    expect(validateUrlTemplate('  https://x.com')).toBeNull();
    expect(validateUrlTemplate('https:x.com')).toContain('https://');
  });

  it('accepts any app scheme the template spells out literally', () => {
    expect(validateUrlTemplate('vscode://file/home/me/repo/{prop:path}:{prop:line}')).toBeNull();
    expect(validateUrlTemplate('claude-cli://open?repo={prop:repo}&q=Explain%20{node_id}')).toBeNull();
    expect(validateUrlTemplate('vscode://anthropic.claude-code/open?prompt={prop:q}')).toBeNull();
    expect(validateUrlTemplate('obsidian://open?vault=kb&file={prop:note}')).toBeNull();
    expect(validateUrlTemplate('mailto:{prop:email}')).toBeNull();
    expect(validateUrlTemplate(' VSCode://file/x')).toBeNull();
    expect(validateUrlTemplate('x-my.app+v2://go')).toBeNull();
    expect(validateUrlTemplate('ftp://x.com')).toBeNull();
  });

  it('rejects schemes the browser runs or renders itself, in any case', () => {
    for (const template of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      'vbscript:msgbox',
      'data:text/html,<script>alert(1)</script>',
      'blob:https://x.com/uuid',
      'file:///etc/passwd',
      'about:blank',
      'view-source:https://x.com',
    ]) {
      expect(validateUrlTemplate(template), template).toContain('not allowed');
    }
  });

  it('rejects templates whose scheme is missing or comes from a placeholder', () => {
    expect(validateUrlTemplate('/relative/path')).not.toBeNull();
    expect(validateUrlTemplate('x.com/path')).not.toBeNull();
    expect(validateUrlTemplate('{prop:url}')).not.toBeNull();
    expect(validateUrlTemplate('{prop:scheme}://x.com')).not.toBeNull();
    expect(validateUrlTemplate('vs{prop:x}://file')).not.toBeNull();
    expect(validateUrlTemplate('1app://x')).not.toBeNull();
  });
});

describe('urlScheme / isAppUrl', () => {
  it('reads the literal scheme, lowercased', () => {
    expect(urlScheme(' VSCode://file/x')).toBe('vscode');
    expect(urlScheme('mailto:a@b.c')).toBe('mailto');
    expect(urlScheme('{prop:u}')).toBeNull();
  });

  it('is true only for accepted non-web schemes', () => {
    expect(isAppUrl('vscode://file/x')).toBe(true);
    expect(isAppUrl('claude-cli://open')).toBe(true);
    expect(isAppUrl('https://x.com')).toBe(false);
    expect(isAppUrl('HTTP://x.com')).toBe(false);
    expect(isAppUrl('javascript:alert(1)')).toBe(false);
    expect(isAppUrl('/relative')).toBe(false);
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

  it('rejects in-browser schemes before interpolating', () => {
    const node = createNode({ properties: { u: 'x' } });
    const result = buildUrlFromTemplate('javascript:alert({prop:u})', 'node', node);
    expect(result.ok).toBe(false);
    expect('error' in result && result.error).toContain('not allowed');
  });

  it('builds app links with every interpolated value encoded', () => {
    const node = createNode({ node_id: 'n 1', properties: { repo: 'acme/payments', q: 'a&b=c' } });
    const result = buildUrlFromTemplate(
      'claude-cli://open?repo={prop:repo}&q=Explain%20{node_id}%20{prop:q}',
      'node',
      node,
    );
    expect(result).toEqual({
      ok: true,
      url: 'claude-cli://open?repo=acme%2Fpayments&q=Explain%20n%201%20a%26b%3Dc',
    });
  });

  it('VS Code recipe: an absolute path drops its encoded leading slash via replace', () => {
    // vscode://file/<path> needs exactly one "/" after "file"; VS Code
    // percent-decodes the rest, so %2F inside the path is fine.
    const node = createNode({ properties: { path: '/home/me/repo/a b.py', line: 12 } });
    const result = buildUrlFromTemplate(
      'vscode://file/{prop:path|replace:/^%2F/:}:{prop:line}',
      'node',
      node,
    );
    expect(result).toEqual({
      ok: true,
      url: 'vscode://file/home%2Fme%2Frepo%2Fa%20b.py:12',
    });
  });

  it('a property value cannot turn an app link into a script URL', () => {
    const node = createNode({ properties: { p: 'javascript:alert(1)' } });
    const result = buildUrlFromTemplate('vscode://file/{prop:p}', 'node', node);
    expect(result).toEqual({
      ok: true,
      url: `vscode://file/${encodeURIComponent('javascript:alert(1)')}`,
    });
  });

  it('still aborts app links on missing properties', () => {
    const node = createNode({ properties: {} });
    const result = buildUrlFromTemplate('vscode://file/root/{prop:path}', 'node', node);
    expect(result).toEqual({ ok: false, missing: ['path'] });
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

  it('app links always hand off via location.assign, never a (blank) new tab', () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    const assignSpy = vi
      .spyOn(window.location, 'assign')
      .mockImplementation(() => undefined);
    openUrl('vscode://file/x.py', 'new-tab');
    openUrl('claude-cli://open', 'same-tab');
    expect(openSpy).not.toHaveBeenCalled();
    expect(assignSpy).toHaveBeenNthCalledWith(1, 'vscode://file/x.py');
    expect(assignSpy).toHaveBeenNthCalledWith(2, 'claude-cli://open');
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
