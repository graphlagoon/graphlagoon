import { describe, it, expect } from 'vitest';
import {
  parseImportedStylePreset,
  styleCompatibilityWarnings,
  hasCompatibilityWarnings,
} from '../stylePresetImport';

const SETTINGS = {
  nodeTypeColors: { Person: '#ff0000', Company: '#00ff00' },
  edgeTypeColors: { KNOWS: '#0000ff' },
  nodeTypeIcons: { Person: 'user' },
  nodePropertyIconConfigs: {
    Company: { property: 'sector', valueIcons: { tech: 'cpu' } },
  },
  textFormat: {
    defaults: { nodeTemplate: '{prop:name}', edgeTemplate: '{prop:since}' },
    rules: [
      {
        id: 'r1',
        name: 'Company',
        target: 'node',
        types: ['Company'],
        template: '{prop:name|upper} ({prop:country})',
        priority: 1,
        enabled: true,
        scope: 'context',
      },
    ],
  },
  layout_algorithm: 'force',
};

describe('parseImportedStylePreset', () => {
  it('rejects invalid JSON and non-objects', () => {
    expect(parseImportedStylePreset('nope').ok).toBe(false);
    expect(parseImportedStylePreset('[1,2]').ok).toBe(false);
    expect(parseImportedStylePreset('{"foo": 1}').ok).toBe(false);
  });

  it('unwraps the portable envelope with name, description and source', () => {
    const result = parseImportedStylePreset(
      JSON.stringify({
        graphlagoon_export: 'style-preset',
        export_version: 1,
        name: 'investigacao',
        description: 'Fraud look',
        source: { node_types: ['Person'], relationship_types: [], node_properties: ['name'], edge_properties: [] },
        settings: SETTINGS,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.name).toBe('investigacao');
    expect(result.description).toBe('Fraud look');
    expect(result.source?.node_types).toEqual(['Person']);
    expect(result.settings.nodeTypeColors).toEqual(SETTINGS.nodeTypeColors);
  });

  it('refuses an envelope of another kind', () => {
    const result = parseImportedStylePreset(
      JSON.stringify({ graphlagoon_export: 'context-menu-actions', actions: [] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('context-menu-actions');
  });

  it('accepts a full server StylePreset object', () => {
    const result = parseImportedStylePreset(
      JSON.stringify({
        preset_version: 1,
        name: 'p',
        context_id: 'ctx',
        created_at: '2026-01-01',
        created_by: 'me',
        settings: SETTINGS,
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.name).toBe('p');
  });

  it('accepts bare settings (what an LLM answers with)', () => {
    const result = parseImportedStylePreset(JSON.stringify(SETTINGS));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.name).toBeUndefined();
      expect(result.settings.layout_algorithm).toBe('force');
    }
  });

  it('drops non-string entries from type-keyed maps and bad shapes', () => {
    const result = parseImportedStylePreset(
      JSON.stringify({
        nodeTypeColors: { Person: '#fff', Bad: 42 },
        edgeTypeIcons: 'oops',
        textFormat: 'oops',
        layout_algorithm: 3,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.settings.nodeTypeColors).toEqual({ Person: '#fff' });
    expect(result.settings.edgeTypeIcons).toBeUndefined();
    expect(result.settings.textFormat).toBeUndefined();
    expect(result.settings.layout_algorithm).toBeUndefined();
  });
});

describe('styleCompatibilityWarnings', () => {
  const CURRENT = {
    nodeTypes: ['Customer'],
    edgeTypes: ['KNOWS'],
    nodeProperties: ['name'],
    edgeProperties: [],
  };

  it('lists types and properties the current graph lacks', () => {
    const w = styleCompatibilityWarnings(SETTINGS as any, CURRENT);
    expect(w.missingNodeTypes.sort()).toEqual(['Company', 'Person']);
    expect(w.missingEdgeTypes).toEqual([]);
    expect(w.missingProperties.sort()).toEqual(['country', 'sector', 'since']);
    expect(hasCompatibilityWarnings(w)).toBe(true);
  });

  it('reports a column referenced only by a tooltip template', () => {
    const w = styleCompatibilityWarnings(
      {
        textFormat: {
          defaults: {
            nodeTemplate: '{prop:name}',
            edgeTemplate: '{relationship_type}',
            nodeTooltipTemplate: '{prop:no_such_column}',
          },
          rules: [],
        },
      } as never,
      CURRENT,
    );
    expect(w.missingProperties).toEqual(['no_such_column']);
  });

  it('is empty when everything matches', () => {
    const w = styleCompatibilityWarnings(
      { nodeTypeColors: { Customer: '#fff' }, textFormat: { defaults: { nodeTemplate: '{prop:name}', edgeTemplate: '{relationship_type}' }, rules: [] } } as any,
      CURRENT,
    );
    expect(hasCompatibilityWarnings(w)).toBe(false);
  });

  it('ignores presets without type-keyed content', () => {
    const w = styleCompatibilityWarnings({ aesthetics: { nodeSize: 10 } }, CURRENT);
    expect(hasCompatibilityWarnings(w)).toBe(false);
  });

  it('collects label-template metric refs as session warnings, not missing columns', () => {
    const w = styleCompatibilityWarnings(
      {
        textFormat: {
          defaults: { nodeTemplate: '{prop:name} ({metric:PageRank})', edgeTemplate: '{if:metric:Weight>1|+|-}' },
          rules: [],
        },
      } as never,
      CURRENT,
    );
    expect(w.sessionMetricRefs.sort()).toEqual(['PageRank', 'Weight']);
    expect(w.missingProperties).toEqual([]);
    expect(hasCompatibilityWarnings(w)).toBe(true);
  });
});
