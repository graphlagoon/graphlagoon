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

  it('rejects open-url templates with an in-browser scheme', () => {
    const result = parseImportedActionConfigs(
      JSON.stringify([{ ...VALID_OPEN_URL, urlTemplate: 'javascript:alert(1)' }]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('not allowed');
  });

  it('accepts open-url app links (vscode://, claude-cli://)', () => {
    const result = parseImportedActionConfigs(
      JSON.stringify([
        { ...VALID_OPEN_URL, urlTemplate: 'vscode://file/repo/{prop:symbol}' },
        { ...VALID_OPEN_URL, urlTemplate: 'claude-cli://open?q={prop:symbol}' },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.configs.map((c) => (c.kind === 'open-url' ? c.urlTemplate : ''))).toEqual([
      'vscode://file/repo/{prop:symbol}',
      'claude-cli://open?q={prop:symbol}',
    ]);
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

  it('keeps resultMode table and drops any other value (absent = graph)', () => {
    const action = (resultMode: unknown) => ({
      kind: 'run-query-template', label: 'Tx', match: { target: 'node' }, templateId: 'u', resultMode,
    });
    const result = parseImportedActionConfigs(JSON.stringify([action('table'), action('graph'), action('nope')]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.configs.map((c) => (c.kind === 'run-query-template' ? c.resultMode : 'x'))).toEqual([
      'table', undefined, undefined,
    ]);
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

  it('parses show-same-value, forcing the target to nodes', () => {
    const r = parseImportedActionConfigs(JSON.stringify([
      { kind: 'show-same-value', label: 'Same branch', match: { target: 'both' }, field: ' branch_id ', mode: 'same' },
      { kind: 'show-same-value', label: 'Has email', match: { target: 'node' }, field: 'email', mode: 'whatever' },
    ]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.configs[0]).toMatchObject({ kind: 'show-same-value', field: 'branch_id', mode: 'same', match: { target: 'node' } });
    // An unknown mode falls back to "same".
    expect(r.configs[1]).toMatchObject({ field: 'email', mode: 'same' });
  });

  it('parses show-table sources: neighborhood (normalized) and program (with params and bindings)', () => {
    const r = parseImportedActionConfigs(JSON.stringify([
      {
        kind: 'show-table', label: 'Transfers', match: { target: 'node' },
        source: { type: 'neighborhood', hops: '2', direction: 'sideways', nodeTypes: ['Account', ''], list: 'edges', listEdgeTypes: ['TRANSFER'] },
      },
      {
        kind: 'show-table', label: 'Big', match: { target: 'node' }, paramBindings: { min: '{prop:limit}', bad: 3 },
        source: { type: 'program', code: 'return []', params: [{ id: 'min', default: '10', type: 'select', options: ['10', '20'] }] },
      },
    ]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.configs[0]).toMatchObject({
      kind: 'show-table',
      source: { type: 'neighborhood', hops: 2, direction: 'any', nodeTypes: ['Account'], list: 'edges', listEdgeTypes: ['TRANSFER'] },
    });
    expect(r.configs[1]).toMatchObject({
      paramBindings: { min: '{prop:limit}' },
      source: { type: 'program', code: 'return []', params: [{ id: 'min', label: 'min', default: '10', type: 'select', options: ['10', '20'] }] },
    });
  });

  it('rejects a show-table source that cannot run', () => {
    const bad = (source: unknown) =>
      parseImportedActionConfigs(JSON.stringify([{ kind: 'show-table', label: 'X', match: { target: 'node' }, source }]));
    expect(bad(undefined)).toMatchObject({ ok: false, error: expect.stringContaining('source') });
    expect(bad({ type: 'neighborhood', hops: 9 })).toMatchObject({ ok: false, error: expect.stringContaining('hops') });
    expect(bad({ type: 'program', code: ' ' })).toMatchObject({ ok: false, error: expect.stringContaining('code') });
    expect(bad({ type: 'program', code: 'x', params: [{ id: 'a b' }] })).toMatchObject({ ok: false, error: expect.stringContaining('plain name') });
    expect(bad({ type: 'sql' })).toMatchObject({ ok: false, error: expect.stringContaining('source.type') });
  });

  it('rejects show-same-value without a field', () => {
    const r = parseImportedActionConfigs(
      JSON.stringify([{ kind: 'show-same-value', label: 'X', match: { target: 'node' }, mode: 'has' }]),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('field');
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

  it('show-same-value: an unknown field is a missing property, a metric a session ref, node_type fine', () => {
    const base = { label: 'Same', enabled: true, kind: 'show-same-value' as const, mode: 'same' as const, match: { target: 'node' as const } };
    const w = actionCompatibilityWarnings(
      [
        { ...base, id: '1', field: 'branch_id' },
        { ...base, id: '2', field: 'metric:degree' },
        { ...base, id: '3', field: 'node_type' },
        { ...base, id: '4', field: 'full_name' },
      ],
      CURRENT,
    );
    expect(w.missingProperties).toEqual(['branch_id']);
    expect(w.sessionMetricRefs).toEqual(['degree']);
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

describe('run-table-provider actions', () => {
  // What the context declares: `account` and `days` open, `tenant` set by the context.
  const sources = [{
    name: 'tx_history', label: 'Transactions', description: '', provider: 'tx-history', registered: true,
    targets: ['node' as const], columns: [],
    params: [
      { name: 'account', type: 'str' as const, required: true, default: null, description: '', choices: null, min: null, max: null },
      { name: 'days', type: 'int' as const, required: false, default: 90, description: '', choices: null, min: 1, max: 365 },
    ],
    locked: [{ name: 'tenant', value: 'br' }],
  }];
  const action = (over: Record<string, unknown> = {}) =>
    JSON.stringify([{ kind: 'run-table-provider', label: 'Tx', match: { target: 'node' }, source: 'tx_history',
      paramBindings: { account: '{node_id}' }, params: { days: '30' }, ...over }]);

  it('imports one checked against the source this context declares, with typed fixed values', () => {
    const r = parseImportedActionConfigs(action(), sources);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.configs[0]).toMatchObject({
      kind: 'run-table-provider', source: 'tx_history', paramBindings: { account: '{node_id}' }, params: { days: 30 },
    });
    // An action older than sources names the provider: it takes the source that uses it.
    const legacy = parseImportedActionConfigs(action({ source: undefined, provider: 'tx-history' }), sources);
    expect(legacy.ok && legacy.configs[0]).toMatchObject({ source: 'tx_history' });
  });

  it('says which field is wrong', () => {
    const error = (over: Record<string, unknown>) => {
      const r = parseImportedActionConfigs(action(over), sources);
      return r.ok ? '' : r.error;
    };
    expect(error({ source: '' })).toContain('missing "source"');
    expect(error({ params: { days: 9999 } })).toContain('params.days must be at most 365');
    expect(error({ paramBindings: { acct: '{node_id}' } })).toContain('has no parameter "acct" (it has: account, days)');
    expect(error({ params: { tenant: 'us' } })).toContain('"tenant" is set by the context');
    expect(error({ match: { target: 'edge' } })).toContain('has no table for a edge');
  });

  it('one whose source this context does not declare imports with a warning', () => {
    const r = parseImportedActionConfigs(action({ source: 'elsewhere', params: { anything: 1 } }), sources);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const w = actionCompatibilityWarnings(r.configs, {
      nodeTypes: [], edgeTypes: [], nodeProperties: [], edgeProperties: [], templateIds: [], tableSources: sources,
    });
    expect(w.missingProviders).toEqual(['elsewhere']);
    expect(hasActionCompatibilityWarnings(w)).toBe(true);
  });
});
