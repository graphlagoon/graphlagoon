/**
 * Find every place a saved exploration (or its context-level cluster programs)
 * references a property-column name, and flag the ones that don't exist in
 * the context's current property list.
 *
 * Warn-only, by design: this NEVER edits a saved exploration. It exists so a
 * schema resync can tell the user "N dangling references across M
 * explorations" before they apply, not to fix them — see
 * docs/dev/decision-log.md for why.
 */
import type { ExplorationState } from '@/types/graph';
import type { ClusterProgram } from '@/types/cluster';
import { extractTemplateProperties } from '@/utils/labelFormatter';

export type ReferenceKind =
  | 'label-template'
  | 'icon-config'
  | 'layout-hive'
  | 'layout-ego'
  | 'node-filter'
  | 'edge-filter'
  | 'similarity'
  | 'cluster-binding'
  | 'raw-query';

export interface PropertyReference {
  /** Human-readable path to where this reference lives, e.g. "textFormat.rules[\"VIP\"].template". */
  location: string;
  property: string;
  kind: ReferenceKind;
  /** False for a raw-query substring hit — those can't be parsed, only guessed. */
  certain: boolean;
}

// 'node_type'/'community'/'degree' are structural sentinels for these keys,
// not property references — see utils/layoutModes.ts categoryOf/metricOf.
const LAYOUT_SENTINELS = new Set(['node_type', 'community', 'degree']);

function stripPropPrefix(value: string): string {
  return value.startsWith('prop:') ? value.slice(5) : value;
}

/**
 * Walk every structured field of an exploration's state (plus its active
 * cluster programs, passed separately since they live in the cluster store,
 * not serialized into `state.clusters`) and collect every property reference.
 *
 * Deliberately does NOT parse `graph_query`, `cte_prefilter`, or query
 * templates — those are raw Cypher/SQL text; use `findRawQueryReferences` for
 * a best-effort (uncertain) substring check on those instead.
 */
export function collectPropertyReferences(
  state: ExplorationState,
  clusterPrograms: ClusterProgram[] = [],
): PropertyReference[] {
  const refs: PropertyReference[] = [];

  if (state.textFormat) {
    for (const rule of state.textFormat.rules ?? []) {
      for (const prop of extractTemplateProperties(rule.template)) {
        refs.push({
          location: `textFormat.rules["${rule.name}"].template`,
          property: prop,
          kind: 'label-template',
          certain: true,
        });
      }
    }
    const defaults = state.textFormat.defaults;
    if (defaults?.nodeTemplate) {
      for (const prop of extractTemplateProperties(defaults.nodeTemplate)) {
        refs.push({ location: 'textFormat.defaults.nodeTemplate', property: prop, kind: 'label-template', certain: true });
      }
    }
    if (defaults?.edgeTemplate) {
      for (const prop of extractTemplateProperties(defaults.edgeTemplate)) {
        refs.push({ location: 'textFormat.defaults.edgeTemplate', property: prop, kind: 'label-template', certain: true });
      }
    }
  }

  if (state.nodePropertyIconConfigs) {
    for (const [nodeType, config] of Object.entries(state.nodePropertyIconConfigs)) {
      if (config?.property) {
        refs.push({
          location: `nodePropertyIconConfigs["${nodeType}"].property`,
          property: config.property,
          kind: 'icon-config',
          certain: true,
        });
      }
    }
  }

  const lmc = state.layout_mode_config;
  if (lmc?.hive) {
    if (lmc.hive.axisKey && !LAYOUT_SENTINELS.has(lmc.hive.axisKey)) {
      refs.push({
        location: 'layout_mode_config.hive.axisKey',
        property: stripPropPrefix(lmc.hive.axisKey),
        kind: 'layout-hive',
        certain: true,
      });
    }
    if (lmc.hive.positionKey && !LAYOUT_SENTINELS.has(lmc.hive.positionKey)) {
      refs.push({
        location: 'layout_mode_config.hive.positionKey',
        property: stripPropPrefix(lmc.hive.positionKey),
        kind: 'layout-hive',
        certain: true,
      });
    }
  }
  if (lmc?.ego?.ringOrdering === 'property' && lmc.ego.ringOrderingKey) {
    refs.push({
      location: 'layout_mode_config.ego.ringOrderingKey',
      property: stripPropPrefix(lmc.ego.ringOrderingKey),
      kind: 'layout-ego',
      certain: true,
    });
  }

  for (const f of state.filters?.nodePropertyFilters ?? []) {
    if (f.property && !f.property.startsWith('metric:')) {
      refs.push({
        location: `filters.nodePropertyFilters["${f.id}"].property`,
        property: f.property,
        kind: 'node-filter',
        certain: true,
      });
    }
  }
  for (const f of state.filters?.edgePropertyFilters ?? []) {
    if (f.property && !f.property.startsWith('metric:')) {
      refs.push({
        location: `filters.edgePropertyFilters["${f.id}"].property`,
        property: f.property,
        kind: 'edge-filter',
        certain: true,
      });
    }
  }

  const keyProperty = state.similarity?.keyProperty;
  if (typeof keyProperty === 'string' && keyProperty !== 'node_id') {
    refs.push({ location: 'similarity.keyProperty', property: keyProperty, kind: 'similarity', certain: true });
  }

  for (const program of clusterPrograms) {
    for (const param of program.parameters ?? []) {
      if (param.node_binding?.startsWith('prop:')) {
        refs.push({
          location: `clusterProgram["${program.program_name}"].parameters["${param.id}"].node_binding`,
          property: param.node_binding.slice('prop:'.length),
          kind: 'cluster-binding',
          certain: true,
        });
      }
    }
  }

  return refs;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Best-effort (uncertain) check: for each column about to be removed, does it
 * appear as a whole word anywhere in a raw query string? Word-boundary
 * matching so removing `name` doesn't flag `full_name`. This is a substring
 * scan, not a parse — a column mentioned in a comment or string literal would
 * also match — hence `certain: false`.
 */
export function findRawQueryReferences(
  removedColumns: string[],
  queries: { location: string; text: string | undefined | null }[],
): PropertyReference[] {
  const refs: PropertyReference[] = [];
  for (const column of removedColumns) {
    const pattern = new RegExp(`\\b${escapeRegExp(column)}\\b`);
    for (const query of queries) {
      if (query.text && pattern.test(query.text)) {
        refs.push({ location: query.location, property: column, kind: 'raw-query', certain: false });
      }
    }
  }
  return refs;
}

/** Filter a reference list down to the ones whose property is NOT in `knownColumns`. */
export function findDanglingReferences(
  refs: PropertyReference[],
  knownColumns: Set<string>,
): PropertyReference[] {
  return refs.filter((r) => !knownColumns.has(r.property));
}
