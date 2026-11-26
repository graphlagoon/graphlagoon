import { ref, computed, watch } from 'vue';
import { ExternalLink, Copy, Play, Focus, Table } from 'lucide-vue-next';
import type { Component } from 'vue';
import { useContextMenu, type ContextMenuTarget } from './useContextMenu';
import { useToast } from './useToast';
import { useGraphStore } from '@/stores/graph';
import { useContextMenuActionsStore } from '@/stores/contextMenuActions';
import { useMetricsStore } from '@/stores/metrics';
import { useQueryTemplatesStore } from '@/stores/queryTemplates';
import { useTemplateExecution } from './useTemplateExecution';
import type { MenuActionTableRequest } from './useMenuActionTable';
import { matchesAction } from '@/utils/menuActionMatcher';
import { nodeFieldValue } from '@/utils/isolation';
import { buildUrlFromTemplate, openUrl } from '@/utils/safeUrl';
import {
  formatLabel,
  extractTemplateProperties,
  extractTemplateMetrics,
  resolveItemValue,
  resolveItemMetricValue,
  type FormatOptions,
} from '@/utils/labelFormatter';
import type { Node, Edge, QueryTemplate } from '@/types/graph';
import type {
  ContextMenuActionConfig,
  RunQueryTemplateActionConfig,
  RunTableProviderActionConfig,
  ShowTableActionConfig,
} from '@/types/contextMenuActions';
import { isKnownActionKind, isTableAction } from '@/types/contextMenuActions';
import { configuredTableProviders } from '@/utils/enrichmentSources';

export const CONFIGURABLE_ACTION_PREFIX = 'configurable-action:';

const KIND_ICONS: Record<string, Component> = {
  'open-url': ExternalLink,
  'copy-text': Copy,
  'run-query-template': Play,
  'show-same-value': Focus,
  'show-table': Table,
  'run-table-provider': Table,
};

/**
 * Resolve a run-query-template action's parameter values for a clicked item.
 * Bound values win over template defaults; a binding whose referenced
 * properties or metrics are missing/unloaded resolves to '' rather than
 * leaking the `[name]`/`[metric:x]` sentinel. `missingRequired` lists
 * required params still empty — the caller opens the execute modal
 * pre-filled instead of running directly.
 */
export function resolveTemplateParamValues(
  config: RunQueryTemplateActionConfig,
  template: QueryTemplate,
  targetType: 'node' | 'edge',
  item: Node | Edge,
  options?: FormatOptions,
): { values: Record<string, string>; missingRequired: string[] } {
  const values: Record<string, string> = {};
  for (const parameter of template.parameters) {
    const binding = config.paramBindings[parameter.id];
    let bound = '';
    if (binding) {
      const unresolved =
        extractTemplateProperties(binding).some(
          (property) => resolveItemValue(targetType, item, property) === '',
        ) ||
        extractTemplateMetrics(binding).some(
          (ref) => resolveItemMetricValue(targetType, item, ref, options?.metrics) === '',
        );
      bound = unresolved ? '' : formatLabel(binding, targetType, item, options);
    }
    values[parameter.id] = bound || parameter.default || '';
  }
  const missingRequired = template.parameters
    .filter((p) => p.required && !values[p.id]?.trim())
    .map((p) => p.id);
  return { values, missingRequired };
}

/**
 * The table action's parameter values the browser can resolve from the clicked
 * item: each binding whose placeholders all resolve (properties, enriched
 * values, metrics, modifiers). The rest go to the server, which falls back to
 * the template defaults.
 */
export function resolveBoundValues(
  bindings: Record<string, string>,
  targetType: 'node' | 'edge',
  item: Node | Edge,
  options?: FormatOptions,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, binding] of Object.entries(bindings)) {
    if (!binding) continue;
    const unresolved =
      extractTemplateProperties(binding).some((property) => resolveItemValue(targetType, item, property) === '') ||
      extractTemplateMetrics(binding).some((ref) => resolveItemMetricValue(targetType, item, ref, options?.metrics) === '');
    if (!unresolved) out[id] = formatLabel(binding, targetType, item, options);
  }
  return out;
}

/** Where the actions run: the exploration's context, or a case canvas's. */
export interface MenuActionHost {
  contextId: () => string | null | undefined;
  /** The datasource id of a clicked node (on a case canvas: the source node, not the unified one). */
  sourceNodeId?: (node: Node) => string | null | undefined;
  /**
   * The datasource ids of a clicked edge (on a case canvas the edge id is the case's
   * `<item>:<edge>` and its ends are merged uids). Null: the edge is not this context's.
   * A host that maps nodes but not edges offers no edge table actions.
   */
  sourceEdge?: (edge: Edge) => { id: string; src: string; dst: string } | null | undefined;
}

/**
 * Registers the user-configurable context-menu actions (from the current
 * context's `context_menu_actions`) into the shared context-menu registry.
 *
 * Mirrors useClusterProgramMenuActions: the owning view calls
 * register()/unregister() in its mount/unmount hooks and the list reconciles
 * whenever the configs change (edit, hydrate on context switch, ...).
 *
 * `pendingTemplateExecution` drives a TemplateExecuteModal in the owning
 * view: it is set when a run-query-template action cannot run directly
 * because a required parameter is still unbound.
 */
export function useConfigurableMenuActions(host?: MenuActionHost) {
  const contextMenu = useContextMenu();
  const graphStore = useGraphStore();
  const actionsStore = useContextMenuActionsStore();
  const metricsStore = useMetricsStore();
  const templatesStore = useQueryTemplatesStore();
  // Same pattern as GraphCanvas3D: lets {metric:<ref>} work in copy-text,
  // URL templates, param bindings, and metric: visibility conditions.
  const labelOptions: FormatOptions = { metrics: metricsStore.metricResolver };
  const { executeTemplateAsGraph } = useTemplateExecution();
  const { success, error } = useToast();

  const registered = ref(false);
  let registeredIds: string[] = [];

  /** Drives a MenuActionTableModal in the owning view. */
  const pendingTable = ref<MenuActionTableRequest | null>(null);
  const contextIdOf = () => (host ? host.contextId() : graphStore.currentContext?.id) ?? null;

  const pendingTemplateExecution = ref<{
    template: QueryTemplate;
    initialValues: Record<string, string>;
  } | null>(null);

  const eligible = computed(() =>
    actionsStore.actionConfigs.filter(
      (c) => c.enabled && isKnownActionKind(c.kind),
    ),
  );

  function lookupItem(target: ContextMenuTarget): Node | Edge | undefined {
    return target.type === 'node'
      ? graphStore.nodes.find((n) => n.node_id === target.id)
      : graphStore.edges.find((e) => e.edge_id === target.id);
  }

  function findTemplate(templateId: string): QueryTemplate | undefined {
    return templatesStore.templates.find((t) => t.id === templateId);
  }

  function isVisible(config: ContextMenuActionConfig, target: ContextMenuTarget): boolean {
    // Real graph items only — cluster synthetic nodes are not in graphStore.nodes
    const item = lookupItem(target);
    if (!item) return false;
    if (!matchesAction(config, target.type, item, metricsStore.metricResolver)) return false;
    // A table action on an edge needs the edge's datasource ids.
    if (isTableAction(config) && target.type === 'edge' && host?.sourceNodeId && !host.sourceEdge?.(item as Edge)) {
      return false;
    }
    // A dangling/invisible template (deleted, or private to another user and
    // therefore never sent to this client) hides the action entirely.
    // A table action runs on the server, which reports a template that is gone; a case
    // canvas has no templates store to look in.
    if (config.kind === 'run-query-template' && !isTableAction(config) && !findTemplate(config.templateId)) {
      return false;
    }
    // A provider this server does not have, or one with no table for this kind of item, offers nothing.
    if (config.kind === 'run-table-provider') {
      const provider = configuredTableProviders().find((p) => p.name === config.provider);
      if (!provider || !provider.targets.includes(target.type)) return false;
    }
    return true;
  }

  async function runAction(config: ContextMenuActionConfig, target: ContextMenuTarget): Promise<void> {
    const item = lookupItem(target);
    if (!item) return;

    switch (config.kind) {
      case 'open-url': {
        const result = buildUrlFromTemplate(config.urlTemplate, target.type, item, labelOptions);
        if (!result.ok) {
          error(
            result.missing
              ? `Cannot open "${config.label}": missing ${result.missing.map((p) => `"${p}"`).join(', ')}`
              : result.error,
          );
          return;
        }
        openUrl(result.url, config.openIn);
        return;
      }
      case 'copy-text': {
        try {
          await navigator.clipboard.writeText(
            formatLabel(config.textTemplate, target.type, item, labelOptions),
          );
          success('Copied');
        } catch {
          error('Failed to copy to clipboard');
        }
        return;
      }
      case 'run-query-template': {
        if (isTableAction(config)) {
          openTable(config, target, item);
          return;
        }
        const template = findTemplate(config.templateId);
        if (!template) {
          error(`Query template for "${config.label}" no longer exists`);
          return;
        }
        const { values, missingRequired } = resolveTemplateParamValues(
          config,
          template,
          target.type,
          item,
          labelOptions,
        );
        if (missingRequired.length > 0) {
          // Let the user fill the rest in the execute modal, pre-filled with
          // everything the click could resolve.
          pendingTemplateExecution.value = { template, initialValues: values };
          return;
        }
        await executeTemplateAsGraph(template, values);
        return;
      }
      case 'show-same-value': {
        if (target.type !== 'node') return;
        const value = nodeFieldValue(item as Node, config.field, metricsStore.metricResolver);
        if (config.mode === 'same' && value === '') {
          error(`"${config.label}": this node has no ${config.field}`);
          return;
        }
        graphStore.isolate(
          config.mode === 'has'
            ? { kind: 'value', field: config.field, value: null, mode: 'has', label: `${config.field} is set` }
            : { kind: 'value', field: config.field, value, mode: 'same', label: `${config.field} = ${value}` },
        );
        return;
      }
      case 'show-table':
        openCanvasTable(config, target, item);
        return;
      case 'run-table-provider':
        openTable(config, target, item);
        return;
    }
  }

  /**
   * A canvas table: the rows come from the graph on the canvas, so the clicked
   * item keeps its canvas ids (on a case canvas: the unified ones, files and
   * derived nodes included) and no datasource mapping is needed.
   */
  function openCanvasTable(config: ShowTableActionConfig, target: ContextMenuTarget, item: Node | Edge) {
    const canvasItem: NonNullable<MenuActionTableRequest['canvas']>['item'] =
      target.type === 'node'
        ? { type: 'node', node_id: (item as Node).node_id, node_type: (item as Node).node_type, properties: (item as Node).properties }
        : {
            type: 'edge',
            edge_id: (item as Edge).edge_id,
            src: (item as Edge).src,
            dst: (item as Edge).dst,
            relationship_type: (item as Edge).relationship_type,
            properties: (item as Edge).properties,
          };
    const bindings = config.source.type === 'program' ? config.paramBindings ?? {} : {};
    pendingTable.value = {
      contextId: contextIdOf() ?? '',
      actionId: config.id,
      label: config.label,
      target:
        canvasItem.type === 'node'
          ? { type: 'node', id: canvasItem.node_id, node_type: canvasItem.node_type }
          : { type: 'edge', id: canvasItem.edge_id, relationship_type: canvasItem.relationship_type, src: canvasItem.src, dst: canvasItem.dst },
      parameters: resolveBoundValues(bindings, target.type, item, labelOptions),
      canvas: { source: config.source, item: canvasItem, bindings },
    };
  }

  function openTable(config: RunQueryTemplateActionConfig | RunTableProviderActionConfig, target: ContextMenuTarget, item: Node | Edge) {
    const contextId = contextIdOf();
    if (!contextId) {
      error(`"${config.label}" needs a graph context`);
      return;
    }
    let target_: MenuActionTableRequest['target'];
    let bindingItem: Node | Edge = item;
    if (target.type === 'node') {
      const node = item as Node;
      const sourceId = host?.sourceNodeId ? host.sourceNodeId(node) : node.node_id;
      if (!sourceId) {
        error(`"${config.label}": this node does not come from this context`);
        return;
      }
      // Bindings read the datasource id: {node_id} must be what the template's tables hold.
      bindingItem = { ...node, node_id: sourceId };
      target_ = { type: 'node', id: sourceId, node_type: node.node_type };
    } else {
      const edge = item as Edge;
      const ids = host?.sourceNodeId ? host.sourceEdge?.(edge) : { id: edge.edge_id, src: edge.src, dst: edge.dst };
      if (!ids) {
        error(`"${config.label}": this edge does not come from this context`);
        return;
      }
      // Bindings read the datasource ids too: {edge_id}, {src}, {dst}.
      bindingItem = { ...edge, edge_id: ids.id, src: ids.src, dst: ids.dst };
      target_ = { type: 'edge', id: ids.id, relationship_type: edge.relationship_type, src: ids.src, dst: ids.dst };
    }
    pendingTable.value = {
      contextId,
      actionId: config.id,
      label: config.label,
      target: target_,
      parameters: resolveBoundValues(config.paramBindings ?? {}, target.type, bindingItem, labelOptions),
    };
  }

  /** Drop all our actions and re-add from the current eligible list. */
  function reconcile() {
    for (const actionId of registeredIds) {
      contextMenu.removeAction(actionId);
    }
    registeredIds = [];
    if (!registered.value) return;

    for (const config of eligible.value) {
      const actionId = CONFIGURABLE_ACTION_PREFIX + config.id;
      contextMenu.addAction({
        id: actionId,
        label: config.label,
        icon: config.icon || (isTableAction(config) ? Table : KIND_ICONS[config.kind]),
        visible: (t) => isVisible(config, t),
        handler: (t) => runAction(config, t),
      });
      registeredIds.push(actionId);
    }
  }

  watch(eligible, reconcile, { deep: true });

  function register() {
    registered.value = true;
    reconcile();
  }

  function unregister() {
    registered.value = false;
    reconcile();
  }

  return { register, unregister, pendingTemplateExecution, pendingTable, runAction, isVisible };
}
