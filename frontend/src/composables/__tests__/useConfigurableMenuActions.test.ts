import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import {
  useConfigurableMenuActions,
  resolveTemplateParamValues,
  CONFIGURABLE_ACTION_PREFIX,
} from '@/composables/useConfigurableMenuActions';
import { useContextMenu, type ContextMenuTarget } from '@/composables/useContextMenu';
import { useToast } from '@/composables/useToast';
import { useGraphStore } from '@/stores/graph';
import { useContextMenuActionsStore } from '@/stores/contextMenuActions';
import { useQueryTemplatesStore } from '@/stores/queryTemplates';
import type { QueryTemplate } from '@/types/graph';
import type { ContextMenuActionConfig } from '@/types/contextMenuActions';

const executeTemplateAsGraph = vi.fn();
vi.mock('@/composables/useTemplateExecution', () => ({
  useTemplateExecution: () => ({
    executeTemplateAsGraph: (...args: unknown[]) => executeTemplateAsGraph(...args),
  }),
}));

function nodeTarget(id: string): ContextMenuTarget {
  return { type: 'node', id, label: id };
}

function makeTemplate(overrides: Partial<QueryTemplate> = {}): QueryTemplate {
  return {
    id: 'tpl-1',
    graph_context_id: 'ctx-1',
    owner_email: 'me@example.com',
    name: 'Neighbors',
    query_type: 'sql',
    query: 'SELECT * FROM edges WHERE src = $person',
    parameters: [
      {
        id: 'person',
        type: 'input',
        label: 'Person',
        required: true,
      },
    ],
    options: { procedural_bfs: true, large_results_mode: true },
    visibility: 'shared',
    created_at: '',
    updated_at: '',
    ...overrides,
  } as QueryTemplate;
}

function makeOpenUrlConfig(overrides: Partial<ContextMenuActionConfig> = {}): ContextMenuActionConfig {
  return {
    id: 'cfg-url',
    label: 'Search',
    enabled: true,
    kind: 'open-url',
    urlTemplate: 'https://x.com/{prop:symbol}',
    openIn: 'new-tab',
    match: { target: 'node', nodeTypes: ['Gene'] },
    ...overrides,
  } as ContextMenuActionConfig;
}

function configuredActions() {
  return useContextMenu().actions.value.filter((a) =>
    a.id.startsWith(CONFIGURABLE_ACTION_PREFIX),
  );
}

function seedGraph() {
  const graphStore = useGraphStore();
  graphStore.nodes = [
    { node_id: 'n1', node_type: 'Gene', properties: { symbol: 'BRCA1' } },
    { node_id: 'n2', node_type: 'Person', properties: { name: 'Ada' } },
    { node_id: 'n3', node_type: 'Gene' }, // properties not loaded yet
  ];
  graphStore.edges = [
    { edge_id: 'e1', src: 'n1', dst: 'n2', relationship_type: 'MENTIONS' },
  ];
  return graphStore;
}

beforeEach(() => {
  setActivePinia(createPinia());
  useContextMenu().resetActions();
  useToast().toasts.value.splice(0);
  executeTemplateAsGraph.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useConfigurableMenuActions', () => {
  describe('registration & reconciliation', () => {
    it('register adds one action per enabled config; disabled configs are skipped', () => {
      const store = useContextMenuActionsStore();
      store.hydrateFromContext([
        makeOpenUrlConfig({ id: 'a' }),
        makeOpenUrlConfig({ id: 'b', enabled: false }),
      ]);
      const menu = useConfigurableMenuActions();
      menu.register();
      expect(configuredActions().map((a) => a.id)).toEqual([
        CONFIGURABLE_ACTION_PREFIX + 'a',
      ]);
    });

    it('reconciles when configs change (add / disable / remove)', async () => {
      const store = useContextMenuActionsStore();
      const menu = useConfigurableMenuActions();
      menu.register();
      expect(configuredActions()).toHaveLength(0);

      store.hydrateFromContext([makeOpenUrlConfig({ id: 'a' })]);
      await nextTick();
      expect(configuredActions()).toHaveLength(1);

      store.setEnabled('a', false);
      await nextTick();
      expect(configuredActions()).toHaveLength(0);

      store.setEnabled('a', true);
      await nextTick();
      store.removeConfig('a');
      await nextTick();
      expect(configuredActions()).toHaveLength(0);
    });

    it('unregister removes everything; re-register does not duplicate', () => {
      const store = useContextMenuActionsStore();
      store.hydrateFromContext([makeOpenUrlConfig()]);
      const menu = useConfigurableMenuActions();
      menu.register();
      menu.register();
      expect(configuredActions()).toHaveLength(1);
      menu.unregister();
      expect(configuredActions()).toHaveLength(0);
    });
  });

  describe('visibility', () => {
    it('matches node type and property conditions through the store lookup', () => {
      seedGraph();
      const store = useContextMenuActionsStore();
      store.hydrateFromContext([
        makeOpenUrlConfig({
          match: {
            target: 'node',
            nodeTypes: ['Gene'],
            propertyConditions: [{ property: 'symbol', operator: 'not-empty' }],
          },
        }),
      ]);
      const menu = useConfigurableMenuActions();
      menu.register();
      const action = configuredActions()[0];
      expect(action.visible!(nodeTarget('n1'))).toBe(true); // Gene with symbol
      expect(action.visible!(nodeTarget('n2'))).toBe(false); // Person
      expect(action.visible!(nodeTarget('n3'))).toBe(false); // Gene, symbol unloaded
      expect(action.visible!(nodeTarget('ghost'))).toBe(false); // not in store
      expect(action.visible!({ type: 'edge', id: 'e1', label: 'e1' })).toBe(false);
    });

    it('run-query-template action is hidden while its template id is not in the store', () => {
      seedGraph();
      const templatesStore = useQueryTemplatesStore();
      const store = useContextMenuActionsStore();
      store.hydrateFromContext([
        {
          id: 'cfg-tpl',
          label: 'Expand',
          enabled: true,
          kind: 'run-query-template',
          templateId: 'tpl-1',
          paramBindings: { person: '{node_id}' },
          match: { target: 'node' },
        },
      ]);
      const menu = useConfigurableMenuActions();
      menu.register();
      const action = configuredActions()[0];
      expect(action.visible!(nodeTarget('n1'))).toBe(false); // dangling template
      templatesStore.templates = [makeTemplate()];
      expect(action.visible!(nodeTarget('n1'))).toBe(true);
    });
  });

  describe('open-url handler', () => {
    it('opens the encoded URL in a new tab', async () => {
      seedGraph();
      const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
      const store = useContextMenuActionsStore();
      store.hydrateFromContext([makeOpenUrlConfig()]);
      const menu = useConfigurableMenuActions();
      menu.register();

      await configuredActions()[0].handler(nodeTarget('n1'));
      expect(openSpy).toHaveBeenCalledWith(
        'https://x.com/BRCA1',
        '_blank',
        'noopener,noreferrer',
      );
    });

    it('missing property → error toast, nothing opens', async () => {
      seedGraph();
      const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
      const store = useContextMenuActionsStore();
      store.hydrateFromContext([makeOpenUrlConfig({ match: { target: 'node' } })]);
      const menu = useConfigurableMenuActions();
      menu.register();

      await configuredActions()[0].handler(nodeTarget('n3'));
      expect(openSpy).not.toHaveBeenCalled();
      const last = useToast().toasts.value.at(-1);
      expect(last?.type).toBe('error');
      expect(last?.message).toContain('symbol');
    });
  });

  describe('copy-text handler', () => {
    it('copies the formatted text to the clipboard', async () => {
      seedGraph();
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
      const store = useContextMenuActionsStore();
      store.hydrateFromContext([
        {
          id: 'cfg-copy',
          label: 'Copy',
          enabled: true,
          kind: 'copy-text',
          textTemplate: '{node_type}: {prop:name}',
          match: { target: 'node' },
        },
      ]);
      const menu = useConfigurableMenuActions();
      menu.register();

      await configuredActions()[0].handler(nodeTarget('n2'));
      expect(writeText).toHaveBeenCalledWith('Person: Ada');
      vi.unstubAllGlobals();
    });
  });

  describe('run-query-template handler', () => {
    it('executes directly when all required parameters resolve from bindings', async () => {
      seedGraph();
      useQueryTemplatesStore().templates = [makeTemplate()];
      const store = useContextMenuActionsStore();
      store.hydrateFromContext([
        {
          id: 'cfg-tpl',
          label: 'Expand',
          enabled: true,
          kind: 'run-query-template',
          templateId: 'tpl-1',
          paramBindings: { person: '{node_id}' },
          match: { target: 'node' },
        },
      ]);
      const menu = useConfigurableMenuActions();
      menu.register();

      await configuredActions()[0].handler(nodeTarget('n1'));
      expect(executeTemplateAsGraph).toHaveBeenCalledTimes(1);
      expect(executeTemplateAsGraph.mock.calls[0][1]).toEqual({ person: 'n1' });
      expect(menu.pendingTemplateExecution.value).toBeNull();
    });

    it('opens the pre-filled modal instead when a required parameter stays unbound', async () => {
      seedGraph();
      useQueryTemplatesStore().templates = [
        makeTemplate({
          parameters: [
            { id: 'person', type: 'input', label: 'Person', required: true },
            { id: 'depth', type: 'input', label: 'Depth', required: true },
          ],
        }),
      ];
      const store = useContextMenuActionsStore();
      store.hydrateFromContext([
        {
          id: 'cfg-tpl',
          label: 'Expand',
          enabled: true,
          kind: 'run-query-template',
          templateId: 'tpl-1',
          paramBindings: { person: '{node_id}' },
          match: { target: 'node' },
        },
      ]);
      const menu = useConfigurableMenuActions();
      menu.register();

      await configuredActions()[0].handler(nodeTarget('n1'));
      expect(executeTemplateAsGraph).not.toHaveBeenCalled();
      expect(menu.pendingTemplateExecution.value?.template.id).toBe('tpl-1');
      expect(menu.pendingTemplateExecution.value?.initialValues).toEqual({
        person: 'n1',
        depth: '',
      });
    });

    it('errors when the template was deleted between render and click', async () => {
      seedGraph();
      useQueryTemplatesStore().templates = [];
      const store = useContextMenuActionsStore();
      store.hydrateFromContext([
        {
          id: 'cfg-tpl',
          label: 'Expand',
          enabled: true,
          kind: 'run-query-template',
          templateId: 'tpl-gone',
          paramBindings: {},
          match: { target: 'node' },
        },
      ]);
      const menu = useConfigurableMenuActions();
      menu.register();

      await configuredActions()[0].handler(nodeTarget('n1'));
      expect(executeTemplateAsGraph).not.toHaveBeenCalled();
      const last = useToast().toasts.value.at(-1);
      expect(last?.type).toBe('error');
      expect(last?.message).toContain('no longer exists');
    });
  });
});

describe('resolveTemplateParamValues', () => {
  const item = { node_id: 'n1', node_type: 'Gene', properties: { symbol: 'BRCA1' } };

  it('bound values win over defaults; unbound params use defaults', () => {
    const template = makeTemplate({
      parameters: [
        { id: 'gene', type: 'input', label: 'Gene', required: true },
        { id: 'depth', type: 'input', label: 'Depth', default: '2', required: false },
      ],
    });
    const config = {
      id: 'c',
      label: 'x',
      enabled: true,
      kind: 'run-query-template',
      templateId: 'tpl-1',
      paramBindings: { gene: '{prop:symbol}' },
      match: { target: 'node' },
    } as const;
    const { values, missingRequired } = resolveTemplateParamValues(
      config,
      template,
      'node',
      item,
    );
    expect(values).toEqual({ gene: 'BRCA1', depth: '2' });
    expect(missingRequired).toEqual([]);
  });

  it('a binding referencing a missing property resolves empty (no [name] sentinel) and lands in missingRequired', () => {
    const template = makeTemplate({
      parameters: [{ id: 'gene', type: 'input', label: 'Gene', required: true }],
    });
    const config = {
      id: 'c',
      label: 'x',
      enabled: true,
      kind: 'run-query-template',
      templateId: 'tpl-1',
      paramBindings: { gene: '{prop:absent}' },
      match: { target: 'node' },
    } as const;
    const { values, missingRequired } = resolveTemplateParamValues(
      config,
      template,
      'node',
      item,
    );
    expect(values.gene).toBe('');
    expect(missingRequired).toEqual(['gene']);
  });

  it('metric bindings resolve through options.metrics', () => {
    const resolver = (target: 'node' | 'edge', itemId: string, ref: string) =>
      target === 'node' && itemId === 'n1' && ref === 'PageRank' ? 0.8 : undefined;
    const template = makeTemplate({
      parameters: [{ id: 'score', type: 'input', label: 'Score', required: true }],
    });
    const config = {
      id: 'c', label: 'Run', enabled: true, kind: 'run-query-template',
      templateId: template.id, match: { target: 'node' },
      paramBindings: { score: '{metric:PageRank}' },
    } as ContextMenuActionConfig & { paramBindings: Record<string, string> };
    const item = { node_id: 'n1', node_type: 'Gene' };
    const { values, missingRequired } = resolveTemplateParamValues(
      config as never, template, 'node', item as never, { metrics: resolver },
    );
    expect(values.score).toBe('0.8');
    expect(missingRequired).toEqual([]);
  });

  it('unresolved metric bindings fall back to the default, never the sentinel', () => {
    const template = makeTemplate({
      parameters: [{ id: 'score', type: 'input', label: 'Score', required: false, default: '1' }],
    });
    const config = {
      id: 'c', label: 'Run', enabled: true, kind: 'run-query-template',
      templateId: template.id, match: { target: 'node' },
      paramBindings: { score: '{metric:PageRank}' },
    };
    const item = { node_id: 'n1', node_type: 'Gene' };
    // No resolver at all (back-compat callers) and resolver without the metric
    for (const options of [undefined, { metrics: () => undefined }]) {
      const { values, missingRequired } = resolveTemplateParamValues(
        config as never, template, 'node', item as never, options as never,
      );
      expect(values.score).toBe('1');
      expect(missingRequired).toEqual([]);
    }
  });
});
