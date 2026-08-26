import { ref, computed, watch } from 'vue';
import { ExternalLink, Copy, Play } from 'lucide-vue-next';
import type { Component } from 'vue';
import { useContextMenu, type ContextMenuTarget } from './useContextMenu';
import { useToast } from './useToast';
import { useGraphStore } from '@/stores/graph';
import { useContextMenuActionsStore } from '@/stores/contextMenuActions';
import { useQueryTemplatesStore } from '@/stores/queryTemplates';
import { useTemplateExecution } from './useTemplateExecution';
import { matchesAction } from '@/utils/menuActionMatcher';
import { buildUrlFromTemplate, openUrl } from '@/utils/safeUrl';
import {
  formatLabel,
  extractTemplateProperties,
  resolveItemValue,
} from '@/utils/labelFormatter';
import type { Node, Edge, QueryTemplate } from '@/types/graph';
import type {
  ContextMenuActionConfig,
  RunQueryTemplateActionConfig,
} from '@/types/contextMenuActions';
import { isKnownActionKind } from '@/types/contextMenuActions';

export const CONFIGURABLE_ACTION_PREFIX = 'configurable-action:';

const KIND_ICONS: Record<string, Component> = {
  'open-url': ExternalLink,
  'copy-text': Copy,
  'run-query-template': Play,
};

/**
 * Resolve a run-query-template action's parameter values for a clicked item.
 * Bound values win over template defaults; a binding whose referenced
 * properties are missing/unloaded resolves to '' rather than leaking the
 * `[name]` sentinel. `missingRequired` lists required params still empty —
 * the caller opens the execute modal pre-filled instead of running directly.
 */
export function resolveTemplateParamValues(
  config: RunQueryTemplateActionConfig,
  template: QueryTemplate,
  targetType: 'node' | 'edge',
  item: Node | Edge,
): { values: Record<string, string>; missingRequired: string[] } {
  const values: Record<string, string> = {};
  for (const parameter of template.parameters) {
    const binding = config.paramBindings[parameter.id];
    let bound = '';
    if (binding) {
      const unresolved = extractTemplateProperties(binding).some(
        (property) => resolveItemValue(targetType, item, property) === '',
      );
      bound = unresolved ? '' : formatLabel(binding, targetType, item);
    }
    values[parameter.id] = bound || parameter.default || '';
  }
  const missingRequired = template.parameters
    .filter((p) => p.required && !values[p.id]?.trim())
    .map((p) => p.id);
  return { values, missingRequired };
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
export function useConfigurableMenuActions() {
  const contextMenu = useContextMenu();
  const graphStore = useGraphStore();
  const actionsStore = useContextMenuActionsStore();
  const templatesStore = useQueryTemplatesStore();
  const { executeTemplateAsGraph } = useTemplateExecution();
  const { success, error } = useToast();

  const registered = ref(false);
  let registeredIds: string[] = [];

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
    if (!matchesAction(config, target.type, item)) return false;
    // A dangling/invisible template (deleted, or private to another user and
    // therefore never sent to this client) hides the action entirely.
    if (config.kind === 'run-query-template' && !findTemplate(config.templateId)) {
      return false;
    }
    return true;
  }

  async function runAction(config: ContextMenuActionConfig, target: ContextMenuTarget): Promise<void> {
    const item = lookupItem(target);
    if (!item) return;

    switch (config.kind) {
      case 'open-url': {
        const result = buildUrlFromTemplate(config.urlTemplate, target.type, item);
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
            formatLabel(config.textTemplate, target.type, item),
          );
          success('Copied');
        } catch {
          error('Failed to copy to clipboard');
        }
        return;
      }
      case 'run-query-template': {
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
    }
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
        icon: config.icon || KIND_ICONS[config.kind],
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

  return { register, unregister, pendingTemplateExecution, runAction, isVisible };
}
