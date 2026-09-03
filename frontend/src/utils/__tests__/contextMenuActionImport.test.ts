import { describe, it, expect } from 'vitest';
import {
  parseImportedActionConfigs,
  actionCompatibilityWarnings,
  hasActionCompatibilityWarnings,
} from '../contextMenuActionImport';

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

describe('parseImportedActionConfigs — portable envelope', () => {
  it('unwraps the envelope and returns its source schema', () => {
    const result = parseImportedActionConfigs(
      JSON.stringify({
        graphlagoon_export: 'context-menu-actions',
        export_version: 1,
        source: {
          context_title: 'Old',
          node_types: ['Person'],
          relationship_types: [],
          node_properties: ['name'],
          edge_properties: [],
          query_templates: [{ id: 'old-t', name: 'Old tpl', parameters: ['p'] }],
        },
        actions: [
          { kind: 'copy-text', label: 'Copy', match: { target: 'node' }, textTemplate: '{prop:name}' },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.configs).toHaveLength(1);
    expect(result.source?.context_title).toBe('Old');
    expect(result.source?.query_templates).toEqual([{ id: 'old-t', name: 'Old tpl', parameters: ['p'] }]);
  });

  it('refuses an envelope of another kind', () => {
    const result = parseImportedActionConfigs(
      JSON.stringify({ graphlagoon_export: 'style-preset', settings: {} }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('style-preset');
  });

  it('requires "actions" to be an array inside an envelope', () => {
    const result = parseImportedActionConfigs(
      JSON.stringify({ graphlagoon_export: 'context-menu-actions', actions: {} }),
    );
    expect(result.ok).toBe(false);
  });
});

describe('actionCompatibilityWarnings', () => {
  const CURRENT = {
    nodeTypes: ['Customer'],
    edgeTypes: ['PAID'],
    nodeProperties: ['full_name'],
    edgeProperties: ['amount'],
    templateIds: ['t-new'],
  };

  it('reports types, properties and template ids this graph lacks', () => {
    const configs = [
      {
        id: '1', label: 'Search', enabled: true, kind: 'open-url' as const, openIn: 'new-tab' as const,
        match: { target: 'node' as const, nodeTypes: ['Person'], propertyConditions: [{ property: 'email', operator: 'not-empty' as const }, { property: 'node_id', operator: 'exists' as const }] },
        urlTemplate: 'https://x.com/?q={prop:email}&n={node_id}',
      },
      {
        id: '2', label: 'Run', enabled: true, kind: 'run-query-template' as const,
        match: { target: 'edge' as const, relationshipTypes: ['KNOWS'] },
        templateId: 't-old', paramBindings: { p: '{prop:amount}', q: '{prop:since}' },
      },
      {
        id: '3', label: 'Copy', enabled: true, kind: 'copy-text' as const,
        match: { target: 'node' as const, nodeTypes: ['Customer'] },
        textTemplate: '{prop:full_name}',
      },
    ];
    const w = actionCompatibilityWarnings(configs, CURRENT);
    expect(w.missingNodeTypes).toEqual(['Person']);
    expect(w.missingEdgeTypes).toEqual(['KNOWS']);
    expect(w.missingProperties.sort()).toEqual(['email', 'since']);
    expect(w.missingTemplateIds).toEqual(['t-old']);
    expect(hasActionCompatibilityWarnings(w)).toBe(true);
  });

  it('is empty when every reference resolves', () => {
    const w = actionCompatibilityWarnings(
      [
        {
          id: '3', label: 'Copy', enabled: true, kind: 'copy-text',
          match: { target: 'node', nodeTypes: ['Customer'] },
          textTemplate: '{prop:full_name}',
        },
      ],
      CURRENT,
    );
    expect(hasActionCompatibilityWarnings(w)).toBe(false);
  });

  it('collects metric refs as session warnings, never as missing columns', () => {
    const w = actionCompatibilityWarnings(
      [
        {
          id: '1', label: 'Search', enabled: true, kind: 'open-url' as const, openIn: 'new-tab' as const,
          match: {
            target: 'node' as const,
            propertyConditions: [{ property: 'metric:PageRank', operator: 'not-empty' as const }],
          },
          urlTemplate: 'https://x.com/?s={metric:custom:score}&n={prop:full_name}',
        },
      ],
      CURRENT,
    );
    expect(w.sessionMetricRefs.sort()).toEqual(['PageRank', 'custom:score']);
    expect(w.missingProperties).toEqual([]);
    expect(hasActionCompatibilityWarnings(w)).toBe(true);
  });
});
