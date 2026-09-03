/**
 * Pure visibility matcher for user-configurable context-menu actions.
 *
 * Decides whether a config applies to the clicked item: target kind,
 * node/edge type membership, and property conditions (AND). Property values
 * resolve with the exact label-template semantics (`resolveItemValue`), so a
 * condition and a `{prop:x}` placeholder can never disagree.
 *
 * Deferred properties: an unloaded property resolves to '' and fails its
 * condition, hiding the action; the menu recomputes reactively, so the entry
 * appears as soon as the progressive loader delivers the value.
 *
 * Metric conditions: a condition whose `property` is `metric:<id-or-name>`
 * resolves through the optional MetricResolver instead of item.properties.
 * An uncomputed metric fails all its conditions and hides the action; like
 * deferred properties, it reappears once computed because visibility is
 * evaluated at menu-open time.
 */
import type { Node, Edge } from '@/types/graph';
import type {
  ContextMenuActionConfig,
  PropertyCondition,
} from '@/types/contextMenuActions';
import {
  resolveItemValue,
  resolveItemMetricValue,
  parseMetricRef,
  type MetricResolver,
} from './labelFormatter';

const NODE_BUILTINS = new Set(['node_id', 'node_type']);
const EDGE_BUILTINS = new Set(['edge_id', 'relationship_type', 'src', 'dst']);

function propertyExists(
  targetType: 'node' | 'edge',
  item: Node | Edge,
  property: string,
): boolean {
  if (item.properties && property in item.properties) return true;
  return targetType === 'node'
    ? NODE_BUILTINS.has(property)
    : EDGE_BUILTINS.has(property);
}

function conditionHolds(
  condition: PropertyCondition,
  targetType: 'node' | 'edge',
  item: Node | Edge,
  metrics?: MetricResolver,
): boolean {
  const metricRef = parseMetricRef(condition.property);
  const value =
    metricRef != null
      ? resolveItemMetricValue(targetType, item, metricRef, metrics)
      : resolveItemValue(targetType, item, condition.property);
  switch (condition.operator) {
    case 'exists':
      if (metricRef != null) {
        // A metric "exists" when it is computed AND has a value for this item.
        const id =
          targetType === 'node' ? (item as Node).node_id : (item as Edge).edge_id;
        return metrics?.(targetType, id, metricRef) !== undefined;
      }
      return propertyExists(targetType, item, condition.property);
    case 'not-empty':
      return value !== '';
    case 'equals':
      return value === (condition.value ?? '');
    case 'not-equals':
      return value !== (condition.value ?? '');
    case 'contains':
      return condition.value != null && condition.value !== ''
        ? value.includes(condition.value)
        : false;
    default:
      return false;
  }
}

/**
 * Whether `config` should be offered for the clicked item. `item` is the
 * store-shape Node/Edge already looked up by the caller (the composable owns
 * store access; this stays pure).
 */
export function matchesAction(
  config: ContextMenuActionConfig,
  targetType: 'node' | 'edge',
  item: Node | Edge,
  metrics?: MetricResolver,
): boolean {
  if (!config.enabled) return false;

  const { match } = config;
  if (match.target !== 'both' && match.target !== targetType) return false;

  if (targetType === 'node') {
    const types = match.nodeTypes ?? [];
    if (types.length > 0 && !types.includes((item as Node).node_type)) return false;
  } else {
    const types = match.relationshipTypes ?? [];
    if (types.length > 0 && !types.includes((item as Edge).relationship_type)) {
      return false;
    }
  }

  for (const condition of match.propertyConditions ?? []) {
    if (!conditionHolds(condition, targetType, item, metrics)) return false;
  }

  return true;
}
