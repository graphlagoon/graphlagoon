import { describe, it, expect } from 'vitest';
import { parseImportedActionConfigs } from '../contextMenuActionImport';

const VALID_OPEN_URL = {
  kind: 'open-url',
  label: 'Search',
  match: { target: 'node', nodeTypes: ['Gene'] },
  urlTemplate: 'https://x.com/{prop:symbol}',
  openIn: 'new-tab',
};

describe('parseImportedActionConfigs', () => {
  it('rejects invalid JSON and empty lists', () => {
    expect(parseImportedActionConfigs('not json')).toEqual({ ok: false, error: 'Not valid JSON' });
    expect(parseImportedActionConfigs('[]')).toEqual({ ok: false, error: 'Empty list' });
  });

  it('parses a valid open-url action, generating an id and defaulting enabled', () => {
    const result = parseImportedActionConfigs(JSON.stringify([VALID_OPEN_URL]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const config = result.configs[0];
    expect(config.kind).toBe('open-url');
    expect(config.id).toBeTruthy();
    expect(config.enabled).toBe(true);
    expect(config.match.nodeTypes).toEqual(['Gene']);
  });

  it('accepts a single object (not wrapped in an array)', () => {
    const result = parseImportedActionConfigs(JSON.stringify(VALID_OPEN_URL));
    expect(result.ok).toBe(true);
  });

  it('rejects unknown kinds', () => {
    const result = parseImportedActionConfigs(
      JSON.stringify([{ ...VALID_OPEN_URL, kind: 'webhook' }]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('unknown kind');
  });

  it('rejects open-url templates without the http(s) prefix', () => {
    const result = parseImportedActionConfigs(
      JSON.stringify([{ ...VALID_OPEN_URL, urlTemplate: 'javascript:alert(1)' }]),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a bad match target and bad condition operator', () => {
    expect(
      parseImportedActionConfigs(
        JSON.stringify([{ ...VALID_OPEN_URL, match: { target: 'everything' } }]),
      ).ok,
    ).toBe(false);
    expect(
      parseImportedActionConfigs(
        JSON.stringify([
          {
            ...VALID_OPEN_URL,
            match: {
              target: 'node',
              propertyConditions: [{ property: 'x', operator: 'regex' }],
            },
          },
        ]),
      ).ok,
    ).toBe(false);
  });

  it('parses copy-text and run-query-template kinds', () => {
    const result = parseImportedActionConfigs(
      JSON.stringify([
        {
          kind: 'copy-text',
          label: 'Copy contact',
          match: { target: 'node' },
          textTemplate: '{prop:name}',
        },
        {
          kind: 'run-query-template',
          label: 'Expand',
          enabled: false,
          match: { target: 'both' },
          templateId: 'uuid-1',
          paramBindings: { person: '{prop:id}', bad: 42 },
        },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.configs[0].kind).toBe('copy-text');
    const runTemplate = result.configs[1];
    expect(runTemplate.kind).toBe('run-query-template');
    expect(runTemplate.enabled).toBe(false);
    if (runTemplate.kind === 'run-query-template') {
      // non-string binding values are dropped
      expect(runTemplate.paramBindings).toEqual({ person: '{prop:id}' });
    }
  });

  it('rejects run-query-template without templateId and copy-text without textTemplate', () => {
    expect(
      parseImportedActionConfigs(
        JSON.stringify([{ kind: 'run-query-template', label: 'X', match: { target: 'node' } }]),
      ).ok,
    ).toBe(false);
    expect(
      parseImportedActionConfigs(
        JSON.stringify([{ kind: 'copy-text', label: 'X', match: { target: 'node' } }]),
      ).ok,
    ).toBe(false);
  });
});
