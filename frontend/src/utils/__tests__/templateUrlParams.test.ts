/**
 * The `?template=` grammar and its fail-closed doctrine.
 *
 * These values end up spliced into a query a warehouse executes, so the tests
 * lean adversarial: hostile values must produce an issue (and therefore no
 * execution), and NO issue may ever be swallowed — a link that is only mostly
 * right must not run a query that is only mostly right.
 */

import { describe, it, expect } from 'vitest';
import {
  parseTemplateUrl,
  resolveTemplateExecution,
  summarizeTemplateIssues,
  templateQuerySignature,
  SAFE_VALUE_RE,
} from '@/utils/templateUrlParams';
import type { QueryTemplate, TemplateParameter } from '@/types/graph';

function createTemplate(overrides: Partial<QueryTemplate> = {}): QueryTemplate {
  return {
    id: 'tpl-1',
    graph_context_id: 'ctx-1',
    owner_email: 'me@example.com',
    name: 'Neighbors',
    query_type: 'cypher',
    query: 'MATCH (n {id: "$node_id"})-[r*..$depth]-() RETURN r',
    parameters: [],
    options: { procedural_bfs: true, large_results_mode: true },
    visibility: 'shared',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function param(overrides: Partial<TemplateParameter> & { id: string }): TemplateParameter {
  return { type: 'input', label: overrides.id, required: true, ...overrides };
}

const SUPPORTS_SQL = { supportsSql: true };

describe('parseTemplateUrl', () => {
  it('reads the name and the parameter values', () => {
    const parsed = parseTemplateUrl({
      template: 'Neighbors',
      'template.node_id': 'acct-9931',
      'template.depth': '2',
    });
    expect(parsed.name).toBe('Neighbors');
    expect(parsed.values).toEqual({ node_id: 'acct-9931', depth: '2' });
    expect(parsed.issues).toEqual([]);
    expect(parsed.present).toBe(true);
  });

  it('is absent for a URL with no template keys', () => {
    const parsed = parseTemplateUrl({ precomputed: 'g', style: 'dark', foo: '1' });
    expect(parsed.present).toBe(false);
    expect(parsed.name).toBeUndefined();
    expect(parsed.issues).toEqual([]);
  });

  it('takes a dotted paramId verbatim, without inventing structure', () => {
    const parsed = parseTemplateUrl({ template: 'T', 'template.a.b': 'x' });
    expect(parsed.values).toEqual({ 'a.b': 'x' });
    expect(parsed.issues).toEqual([]);
  });

  it('rejects an empty template name', () => {
    const parsed = parseTemplateUrl({ template: '' });
    expect(parsed.name).toBeUndefined();
    expect(parsed.issues.map((i) => i.code)).toEqual(['malformed-key']);
  });

  it('rejects an empty paramId', () => {
    const parsed = parseTemplateUrl({ template: 'T', 'template.': 'x' });
    expect(parsed.issues.map((i) => i.code)).toContain('malformed-key');
  });

  it('flags parameters that arrive without a template name', () => {
    const parsed = parseTemplateUrl({ 'template.node_id': 'x' });
    expect(parsed.present).toBe(true);
    expect(parsed.issues.map((i) => i.code)).toEqual(['orphan-param']);
  });

  it('does not follow the name through SAFE_VALUE_RE', () => {
    // The name is compared by equality and never substituted — a template
    // legitimately named with an apostrophe must stay linkable.
    const parsed = parseTemplateUrl({ template: "João's report" });
    expect(parsed.name).toBe("João's report");
    expect(parsed.issues).toEqual([]);
  });

  describe('hostile values', () => {
    it.each([
      ["'; DROP TABLE users--", 'a quote-and-chain attempt'],
      ["$hash('k')", 'a $hash macro call'],
      ['a"b', 'a double quote'],
      ['a\nb', 'a newline'],
      ['a\\b', 'a backslash'],
      ['$other_param', 'another parameter reference'],
      ['${x}', 'a template-literal shape'],
      ['`backtick`', 'backticks'],
      ['fn(x)', 'parentheses'],
      ['a;b', 'a statement separator'],
    ])('rejects %j (%s)', (value) => {
      const parsed = parseTemplateUrl({ template: 'T', 'template.p': value });
      expect(parsed.issues.map((i) => i.code)).toEqual(['unsafe-value']);
      expect(parsed.values).toEqual({});
    });

    it.each([
      'Acme Corp',
      '2026-08-23',
      'a@b.com',
      'path/to:thing',
      '1,2,3',
      'snake_case.dotted-kebab',
      '',
    ])('accepts %j', (value) => {
      const parsed = parseTemplateUrl({ template: 'T', 'template.p': value });
      expect(parsed.issues).toEqual([]);
      expect(parsed.values).toEqual({ p: value });
    });
  });

  it('refuses to write prototype keys, and leaves the prototype clean', () => {
    const parsed = parseTemplateUrl({
      template: 'T',
      'template.__proto__': 'polluted',
      'template.constructor': 'polluted',
      'template.prototype': 'polluted',
    } as Record<string, string>);
    expect(parsed.values).toEqual({});
    expect(parsed.issues.map((i) => i.code)).toEqual([
      'malformed-key',
      'malformed-key',
      'malformed-key',
    ]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('collapses identical repeats silently', () => {
    const parsed = parseTemplateUrl({ template: 'T', 'template.p': ['x', 'x'] });
    expect(parsed.values).toEqual({ p: 'x' });
    expect(parsed.issues).toEqual([]);
  });

  it('flags a repeat with different values — an ambiguous link must not run', () => {
    const parsed = parseTemplateUrl({ template: 'T', 'template.p': ['x', 'y'] });
    expect(parsed.issues.map((i) => i.code)).toEqual(['conflicting-duplicate']);
  });

  it('reads a valueless key as an empty string', () => {
    const parsed = parseTemplateUrl({ template: 'T', 'template.p': null });
    expect(parsed.values).toEqual({ p: '' });
    expect(parsed.issues).toEqual([]);
  });
});

describe('resolveTemplateExecution', () => {
  it('resolves a fully-specified link', () => {
    const template = createTemplate({
      parameters: [param({ id: 'node_id' }), param({ id: 'depth', required: false })],
    });
    const parsed = parseTemplateUrl({
      template: 'Neighbors',
      'template.node_id': 'acct-9931',
      'template.depth': '2',
    });
    const resolution = resolveTemplateExecution(parsed, [template], SUPPORTS_SQL);
    expect(resolution).toEqual({
      ok: true,
      template,
      values: { node_id: 'acct-9931', depth: '2' },
    });
  });

  it('reports a name that matches nothing', () => {
    const parsed = parseTemplateUrl({ template: 'Nope' });
    const resolution = resolveTemplateExecution(parsed, [createTemplate()], SUPPORTS_SQL);
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.issues.map((i) => i.code)).toEqual(['template-not-found']);
    }
  });

  it('refuses an ambiguous name instead of guessing', () => {
    const parsed = parseTemplateUrl({ template: 'Neighbors' });
    const resolution = resolveTemplateExecution(
      parsed,
      [createTemplate({ id: 'tpl-1' }), createTemplate({ id: 'tpl-2' })],
      SUPPORTS_SQL,
    );
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.issues.map((i) => i.code)).toEqual(['template-ambiguous']);
    }
  });

  it('refuses a SQL template on a datasource that cannot run SQL', () => {
    // The templates panel HIDES such templates; a link to one must error, not
    // silently pick something else to do.
    const parsed = parseTemplateUrl({ template: 'Neighbors' });
    const resolution = resolveTemplateExecution(
      parsed,
      [createTemplate({ query_type: 'sql' })],
      { supportsSql: false },
    );
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.issues.map((i) => i.code)).toEqual(['template-not-runnable']);
    }
  });

  it('refuses a template whose author disabled link execution', () => {
    const parsed = parseTemplateUrl({ template: 'Neighbors' });
    const resolution = resolveTemplateExecution(
      parsed,
      [
        createTemplate({
          options: {
            procedural_bfs: true,
            large_results_mode: true,
            allow_url_execution: false,
          },
        }),
      ],
      SUPPORTS_SQL,
    );
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.issues.map((i) => i.code)).toEqual(['template-not-linkable']);
    }
  });

  it('an absent allow_url_execution means linkable — the pre-flag contract', () => {
    // createTemplate's options carry no allow_url_execution, like every
    // template saved before the field existed.
    const parsed = parseTemplateUrl({ template: 'Neighbors' });
    expect(resolveTemplateExecution(parsed, [createTemplate()], SUPPORTS_SQL).ok).toBe(
      true,
    );
  });

  it('an explicit allow_url_execution: true is linkable', () => {
    const parsed = parseTemplateUrl({ template: 'Neighbors' });
    const resolution = resolveTemplateExecution(
      parsed,
      [
        createTemplate({
          options: {
            procedural_bfs: true,
            large_results_mode: true,
            allow_url_execution: true,
          },
        }),
      ],
      SUPPORTS_SQL,
    );
    expect(resolution.ok).toBe(true);
  });

  it('rejects a parameter the template never declared', () => {
    const parsed = parseTemplateUrl({ template: 'Neighbors', 'template.nope': 'x' });
    const resolution = resolveTemplateExecution(parsed, [createTemplate()], SUPPORTS_SQL);
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.issues.map((i) => i.code)).toEqual(['unknown-param']);
    }
  });

  it('satisfies a required parameter from the URL', () => {
    const template = createTemplate({ parameters: [param({ id: 'node_id' })] });
    const parsed = parseTemplateUrl({
      template: 'Neighbors',
      'template.node_id': 'acct-9931',
    });
    const resolution = resolveTemplateExecution(parsed, [template], SUPPORTS_SQL);
    expect(resolution.ok).toBe(true);
  });

  it('satisfies a required parameter from its default', () => {
    const template = createTemplate({
      parameters: [param({ id: 'depth', default: '2' })],
    });
    const parsed = parseTemplateUrl({ template: 'Neighbors' });
    const resolution = resolveTemplateExecution(parsed, [template], SUPPORTS_SQL);
    expect(resolution.ok).toBe(true);
    if (resolution.ok) expect(resolution.values).toEqual({ depth: '2' });
  });

  it('falls back to the default when the URL value is empty', () => {
    const template = createTemplate({
      parameters: [param({ id: 'depth', default: '2' })],
    });
    const parsed = parseTemplateUrl({ template: 'Neighbors', 'template.depth': ' ' });
    const resolution = resolveTemplateExecution(parsed, [template], SUPPORTS_SQL);
    expect(resolution.ok).toBe(true);
    if (resolution.ok) expect(resolution.values).toEqual({ depth: '2' });
  });

  it('reports a required parameter with neither value nor default', () => {
    const template = createTemplate({ parameters: [param({ id: 'node_id' })] });
    const parsed = parseTemplateUrl({ template: 'Neighbors' });
    const resolution = resolveTemplateExecution(parsed, [template], SUPPORTS_SQL);
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.issues.map((i) => i.code)).toEqual(['missing-required']);
    }
  });

  it('accepts a select value that is in the options', () => {
    const template = createTemplate({
      parameters: [param({ id: 'dir', type: 'select', options: ['in', 'out'] })],
    });
    const parsed = parseTemplateUrl({ template: 'Neighbors', 'template.dir': 'out' });
    expect(resolveTemplateExecution(parsed, [template], SUPPORTS_SQL).ok).toBe(true);
  });

  it('rejects a select value outside the options', () => {
    const template = createTemplate({
      parameters: [param({ id: 'dir', type: 'select', options: ['in', 'out'] })],
    });
    const parsed = parseTemplateUrl({ template: 'Neighbors', 'template.dir': 'up' });
    const resolution = resolveTemplateExecution(parsed, [template], SUPPORTS_SQL);
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.issues.map((i) => i.code)).toEqual(['not-in-options']);
    }
  });

  it('rejects a stale default that fell out of the options', () => {
    // Nobody retyped the value, but running it would still run a query the
    // template's current options no longer allow.
    const template = createTemplate({
      parameters: [
        param({ id: 'dir', type: 'select', options: ['in', 'out'], default: 'both' }),
      ],
    });
    const parsed = parseTemplateUrl({ template: 'Neighbors' });
    const resolution = resolveTemplateExecution(parsed, [template], SUPPORTS_SQL);
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.issues.map((i) => i.code)).toEqual(['not-in-options']);
    }
  });

  it('an optional select left empty is fine', () => {
    const template = createTemplate({
      parameters: [
        param({ id: 'dir', type: 'select', options: ['in', 'out'], required: false }),
      ],
    });
    const parsed = parseTemplateUrl({ template: 'Neighbors' });
    const resolution = resolveTemplateExecution(parsed, [template], SUPPORTS_SQL);
    expect(resolution.ok).toBe(true);
    if (resolution.ok) expect(resolution.values).toEqual({ dir: '' });
  });

  it('reports every issue at once, so the chip explains the whole link', () => {
    const template = createTemplate({
      parameters: [
        param({ id: 'node_id' }),
        param({ id: 'dir', type: 'select', options: ['in', 'out'] }),
      ],
    });
    const parsed = parseTemplateUrl({
      template: 'Neighbors',
      'template.dir': 'up',
      'template.nope': 'x',
    });
    const resolution = resolveTemplateExecution(parsed, [template], SUPPORTS_SQL);
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.issues.map((i) => i.code).sort()).toEqual([
        'missing-required',
        'not-in-options',
        'unknown-param',
      ]);
    }
  });

  it('refuses a nameless parse instead of executing on a guess', () => {
    const parsed = parseTemplateUrl({ 'template.p': 'x' });
    const resolution = resolveTemplateExecution(parsed, [createTemplate()], SUPPORTS_SQL);
    expect(resolution.ok).toBe(false);
  });
});

describe('templateQuerySignature', () => {
  it('is empty when the URL carries no template key at all', () => {
    // Load-bearing: a stray ?foo=1 must not fire the template watcher.
    expect(templateQuerySignature({})).toBe('');
    expect(templateQuerySignature({ precomputed: 'g', foo: '1' })).toBe('');
  });

  it('is non-empty for an orphaned parameter, so the chip can render', () => {
    expect(templateQuerySignature({ 'template.p': 'x' })).not.toBe('');
  });

  it('changes when a value changes', () => {
    expect(
      templateQuerySignature({ template: 'T', 'template.depth': '2' }),
    ).not.toBe(templateQuerySignature({ template: 'T', 'template.depth': '3' }));
  });

  it('is stable under reordering', () => {
    expect(
      templateQuerySignature({ template: 'T', 'template.a': '1', 'template.b': '2' }),
    ).toBe(
      templateQuerySignature({ 'template.b': '2', template: 'T', 'template.a': '1' }),
    );
  });

  it('does not move when only style, layout or provider args change', () => {
    const base = templateQuerySignature({ template: 'T', 'template.a': '1' });
    expect(
      templateQuerySignature({
        template: 'T',
        'template.a': '1',
        style: 'dark',
        'layout.ego.maxHops': '5',
        seed: '7',
      }),
    ).toBe(base);
  });
});

describe('summarizeTemplateIssues', () => {
  it('joins every message into one tooltip', () => {
    const parsed = parseTemplateUrl({
      'template.a': "bad'value",
      'template.b': 'also"bad',
    });
    const summary = summarizeTemplateIssues(parsed.issues);
    for (const issue of parsed.issues) {
      expect(summary).toContain(issue.message);
    }
  });
});

describe('SAFE_VALUE_RE', () => {
  it('is anchored on both ends', () => {
    // A partial match would let "safe-prefix'; DROP" through.
    expect(SAFE_VALUE_RE.test("safe'unsafe")).toBe(false);
  });
});
