/**
 * Parser/validator for the Actions editor "Import JSON" box — the return leg
 * of the Ask-AI workflow (contextMenuActionSkill.ts): the LLM outputs a JSON
 * array of action configs and the user pastes it here.
 *
 * Lenient where safe (missing id/enabled/icon get defaults), strict where it
 * matters (kind, target, url prefix). Never trusts the input shape.
 */
import type {
  CanvasTableParam,
  CanvasTableSource,
  ContextMenuActionConfig,
  MenuActionMatch,
  PropertyCondition,
} from '@/types/contextMenuActions';
import { isKnownActionKind, MAX_NEIGHBORHOOD_HOPS, MAX_PROGRAM_CODE_LENGTH } from '@/types/contextMenuActions';
import type { PortableSourceSchema } from '@/types/portable';
import type { TableProviderInfo } from '@/types/graph';
import { configuredTableProviders } from './enrichmentSources';
import { paramProblem, paramText, paramValue } from './providerParams';
import { validateUrlTemplate } from './safeUrl';
import { extractTemplateProperties, extractTemplateMetrics, parseMetricRef } from './labelFormatter';

const TARGETS = ['node', 'edge', 'both'];
const OPERATORS = ['exists', 'not-empty', 'equals', 'not-equals', 'contains'];

export type ImportResult =
  | { ok: true; configs: ContextMenuActionConfig[]; source?: PortableSourceSchema }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function optionalSource(value: unknown): PortableSourceSchema | undefined {
  if (!isRecord(value)) return undefined;
  const list = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const templates = Array.isArray(value.query_templates)
    ? value.query_templates
        .filter(isRecord)
        .filter((t) => typeof t.id === 'string' && typeof t.name === 'string')
        .map((t) => ({ id: t.id as string, name: t.name as string, parameters: list(t.parameters) }))
    : undefined;
  return {
    context_title: typeof value.context_title === 'string' ? value.context_title : undefined,
    node_types: list(value.node_types),
    relationship_types: list(value.relationship_types),
    node_properties: list(value.node_properties),
    edge_properties: list(value.edge_properties),
    query_templates: templates,
  };
}

function asStringArray(value: unknown): string[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === 'string');
}

function parseMatch(raw: unknown, index: number): MenuActionMatch | string {
  if (raw == null || typeof raw !== 'object') {
    return `Action ${index + 1}: missing "match" object`;
  }
  const match = raw as Record<string, unknown>;
  const target = match.target;
  if (typeof target !== 'string' || !TARGETS.includes(target)) {
    return `Action ${index + 1}: match.target must be one of ${TARGETS.join(', ')}`;
  }
  const conditions: PropertyCondition[] = [];
  if (match.propertyConditions != null) {
    if (!Array.isArray(match.propertyConditions)) {
      return `Action ${index + 1}: match.propertyConditions must be an array`;
    }
    for (const rawCondition of match.propertyConditions) {
      const c = rawCondition as Record<string, unknown>;
      if (typeof c?.property !== 'string' || c.property === '') {
        return `Action ${index + 1}: a property condition is missing "property"`;
      }
      if (typeof c.operator !== 'string' || !OPERATORS.includes(c.operator)) {
        return `Action ${index + 1}: condition operator must be one of ${OPERATORS.join(', ')}`;
      }
      conditions.push({
        property: c.property,
        operator: c.operator as PropertyCondition['operator'],
        value: typeof c.value === 'string' ? c.value : undefined,
      });
    }
  }
  return {
    target: target as MenuActionMatch['target'],
    nodeTypes: asStringArray(match.nodeTypes),
    relationshipTypes: asStringArray(match.relationshipTypes),
    propertyConditions: conditions.length > 0 ? conditions : undefined,
  };
}

export function parseImportedActionConfigs(
  json: string,
  /** The table providers registered on this server: a `run-table-provider` action is checked against its own. */
  tableProviders: TableProviderInfo[] = configuredTableProviders(),
): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: 'Not valid JSON' };
  }
  // The Export button wraps the array in a portable envelope carrying the
  // origin schema; an LLM's answer is the bare array. Accept both.
  let source: PortableSourceSchema | undefined;
  if (isRecord(parsed) && parsed.graphlagoon_export != null) {
    if (parsed.graphlagoon_export !== 'context-menu-actions') {
      return {
        ok: false,
        error: `This file is a "${String(parsed.graphlagoon_export)}" export, not context-menu actions`,
      };
    }
    if (!Array.isArray(parsed.actions)) {
      return { ok: false, error: '"actions" must be an array' };
    }
    source = optionalSource(parsed.source);
    parsed = parsed.actions;
  }
  const rawList = Array.isArray(parsed) ? parsed : [parsed];
  if (rawList.length === 0) return { ok: false, error: 'Empty list' };

  const configs: ContextMenuActionConfig[] = [];
  for (let i = 0; i < rawList.length; i++) {
    const raw = rawList[i] as Record<string, unknown>;
    if (raw == null || typeof raw !== 'object') {
      return { ok: false, error: `Action ${i + 1}: not an object` };
    }
    const kind = raw.kind;
    if (typeof kind !== 'string' || !isKnownActionKind(kind)) {
      return { ok: false, error: `Action ${i + 1}: unknown kind "${String(kind)}"` };
    }
    if (typeof raw.label !== 'string' || raw.label.trim() === '') {
      return { ok: false, error: `Action ${i + 1}: missing "label"` };
    }
    const match = parseMatch(raw.match, i);
    if (typeof match === 'string') return { ok: false, error: match };

    const base = {
      id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : crypto.randomUUID(),
      label: raw.label.trim(),
      icon: typeof raw.icon === 'string' && raw.icon !== '' ? raw.icon : undefined,
      enabled: raw.enabled !== false,
      match,
    };

    if (kind === 'open-url') {
      if (typeof raw.urlTemplate !== 'string' || raw.urlTemplate.trim() === '') {
        return { ok: false, error: `Action ${i + 1}: missing "urlTemplate"` };
      }
      const urlError = validateUrlTemplate(raw.urlTemplate);
      if (urlError) return { ok: false, error: `Action ${i + 1}: ${urlError}` };
      configs.push({
        ...base,
        kind: 'open-url',
        urlTemplate: raw.urlTemplate.trim(),
        openIn: raw.openIn === 'same-tab' ? 'same-tab' : 'new-tab',
      });
    } else if (kind === 'copy-text') {
      if (typeof raw.textTemplate !== 'string' || raw.textTemplate.trim() === '') {
        return { ok: false, error: `Action ${i + 1}: missing "textTemplate"` };
      }
      configs.push({ ...base, kind: 'copy-text', textTemplate: raw.textTemplate });
    } else if (kind === 'show-same-value') {
      if (typeof raw.field !== 'string' || raw.field.trim() === '') {
        return { ok: false, error: `Action ${i + 1}: missing "field"` };
      }
      configs.push({
        ...base,
        // Isolating by a node's value: an edge has nothing to isolate by.
        match: { ...match, target: 'node' },
        kind: 'show-same-value',
        field: raw.field.trim(),
        mode: raw.mode === 'has' ? 'has' : 'same',
      });
    } else if (kind === 'show-table') {
      const parsedSource = parseCanvasTableSource(raw.source);
      if (typeof parsedSource === 'string') return { ok: false, error: `Action ${i + 1}: ${parsedSource}` };
      configs.push({
        ...base,
        kind: 'show-table',
        source: parsedSource,
        ...(parsedSource.type === 'program' ? { paramBindings: stringRecord(raw.paramBindings) } : {}),
      });
    } else if (kind === 'run-table-provider') {
      if (typeof raw.provider !== 'string' || raw.provider.trim() === '') {
        return { ok: false, error: `Action ${i + 1}: missing "provider" (a registered table provider's name)` };
      }
      const name = raw.provider.trim();
      const bindings = stringRecord(raw.paramBindings);
      const fixed: Record<string, string | number | boolean> = {};
      if (raw.params != null && typeof raw.params === 'object' && !Array.isArray(raw.params)) {
        for (const [key, value] of Object.entries(raw.params as Record<string, unknown>)) {
          if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') fixed[key] = value;
        }
      }
      // One registered here is checked now; one that is not is a warning (the actions may
      // come from another server), never a guess.
      const provider = tableProviders.find((p) => p.name === name);
      if (provider) {
        const declared = provider.params ?? [];
        for (const key of [...Object.keys(bindings), ...Object.keys(fixed)]) {
          const spec = declared.find((p) => p.name === key);
          if (!spec) {
            const known = declared.map((p) => p.name).join(', ') || 'none';
            return { ok: false, error: `Action ${i + 1}: provider "${name}" has no parameter "${key}" (it has: ${known})` };
          }
          if (key in fixed) {
            const problem = paramProblem(spec, paramText(fixed[key]));
            if (problem) return { ok: false, error: `Action ${i + 1}: params.${key} ${problem}` };
            fixed[key] = paramValue(spec, paramText(fixed[key]));
          }
        }
        const wanted = base.match.target === 'both' ? ['node', 'edge'] : [base.match.target];
        const unserved = wanted.find((t) => !provider.targets.includes(t as 'node' | 'edge'));
        if (unserved) return { ok: false, error: `Action ${i + 1}: provider "${name}" has no table for a ${unserved}` };
      }
      configs.push({
        ...base,
        kind: 'run-table-provider',
        provider: name,
        ...(Object.keys(bindings).length ? { paramBindings: bindings } : {}),
        ...(Object.keys(fixed).length ? { params: fixed } : {}),
      });
    } else {
      if (typeof raw.templateId !== 'string' || raw.templateId.trim() === '') {
        return { ok: false, error: `Action ${i + 1}: missing "templateId"` };
      }
      const bindings: Record<string, string> = {};
      if (raw.paramBindings != null && typeof raw.paramBindings === 'object') {
        for (const [key, value] of Object.entries(raw.paramBindings as Record<string, unknown>)) {
          if (typeof value === 'string') bindings[key] = value;
        }
      }
      configs.push({
        ...base,
        kind: 'run-query-template',
        templateId: raw.templateId.trim(),
        templateName: typeof raw.templateName === 'string' ? raw.templateName : undefined,
        paramBindings: bindings,
        ...(raw.resultMode === 'table' ? { resultMode: 'table' as const } : {}),
      });
    }
  }
  return { ok: true, configs, source };
}

export interface ActionCompatibilityWarnings {
  missingNodeTypes: string[];
  missingEdgeTypes: string[];
  missingProperties: string[];
  /** `run-query-template` ids that no template of this context has. */
  missingTemplateIds: string[];
  /** `run-table-provider` names this server has no provider for. */
  missingProviders: string[];
  /**
   * Metric refs used in templates or `metric:` conditions. Metrics are
   * session-computed, so this is always a warning (never an import blocker):
   * the action will not work until the metric is computed here.
   */
  sessionMetricRefs: string[];
}

/**
 * Names the actions refer to that the current graph does not know — the
 * signal that they came from a different graph and want the AI "adapt"
 * prompt rather than a blind import.
 */
export function actionCompatibilityWarnings(
  configs: ContextMenuActionConfig[],
  current: {
    nodeTypes: string[];
    edgeTypes: string[];
    nodeProperties: string[];
    edgeProperties: string[];
    templateIds: string[];
    /** Registered table provider names (default: this server's). */
    tableProviders?: string[];
  },
): ActionCompatibilityWarnings {
  const providers = new Set(current.tableProviders ?? configuredTableProviders().map((p) => p.name));
  const missingProviders = new Set<string>();
  const nodeTypes = new Set(current.nodeTypes);
  const edgeTypes = new Set(current.edgeTypes);
  const properties = new Set([...current.nodeProperties, ...current.edgeProperties]);
  const templateIds = new Set(current.templateIds);

  const missingNodeTypes = new Set<string>();
  const missingEdgeTypes = new Set<string>();
  const missingProperties = new Set<string>();
  const missingTemplateIds = new Set<string>();
  const sessionMetricRefs = new Set<string>();

  const checkTemplate = (template: string | undefined) => {
    if (typeof template !== 'string') return;
    for (const prop of extractTemplateProperties(template)) {
      if (!properties.has(prop)) missingProperties.add(prop);
    }
    for (const ref of extractTemplateMetrics(template)) sessionMetricRefs.add(ref);
  };

  for (const config of configs) {
    for (const t of config.match.nodeTypes ?? []) if (!nodeTypes.has(t)) missingNodeTypes.add(t);
    for (const t of config.match.relationshipTypes ?? []) if (!edgeTypes.has(t)) missingEdgeTypes.add(t);
    for (const c of config.match.propertyConditions ?? []) {
      // metric: conditions are session refs, not columns — flagging them as a
      // missing property would always false-flag; they get the metric warning.
      const metricRef = parseMetricRef(c.property);
      if (metricRef != null) {
        sessionMetricRefs.add(metricRef);
        continue;
      }
      if (!properties.has(c.property) && !BUILTIN_PROPERTIES.has(c.property)) {
        missingProperties.add(c.property);
      }
    }
    if (config.kind === 'open-url') checkTemplate(config.urlTemplate);
    else if (config.kind === 'copy-text') checkTemplate(config.textTemplate);
    else if (config.kind === 'show-same-value') {
      const metricRef = parseMetricRef(config.field);
      if (metricRef != null) sessionMetricRefs.add(metricRef);
      else if (!properties.has(config.field) && !BUILTIN_PROPERTIES.has(config.field)) missingProperties.add(config.field);
    } else if (config.kind === 'show-table') {
      const src = config.source;
      if (src.type === 'neighborhood') {
        for (const t of src.nodeTypes ?? []) if (!nodeTypes.has(t)) missingNodeTypes.add(t);
        for (const t of [...(src.edgeTypes ?? []), ...(src.listEdgeTypes ?? [])]) if (!edgeTypes.has(t)) missingEdgeTypes.add(t);
        for (const c of src.columns ?? []) {
          const metricRef = parseMetricRef(c);
          if (metricRef != null) sessionMetricRefs.add(metricRef);
          else if (!properties.has(c) && !BUILTIN_PROPERTIES.has(c)) missingProperties.add(c);
        }
      }
      for (const binding of Object.values(config.paramBindings ?? {})) checkTemplate(binding);
    } else if (config.kind === 'run-table-provider') {
      if (!providers.has(config.provider)) missingProviders.add(config.provider);
      for (const binding of Object.values(config.paramBindings ?? {})) checkTemplate(binding);
    } else {
      if (!templateIds.has(config.templateId)) missingTemplateIds.add(config.templateId);
      for (const binding of Object.values(config.paramBindings)) checkTemplate(binding);
    }
  }

  return {
    missingNodeTypes: [...missingNodeTypes],
    missingEdgeTypes: [...missingEdgeTypes],
    missingProperties: [...missingProperties],
    missingTemplateIds: [...missingTemplateIds],
    missingProviders: [...missingProviders],
    sessionMetricRefs: [...sessionMetricRefs],
  };
}

/** Condition properties that are not columns (see menuActionMatcher.ts). */
const BUILTIN_PROPERTIES = new Set([
  'node_id',
  'node_type',
  'edge_id',
  'relationship_type',
  'src',
  'dst',
]);

export function hasActionCompatibilityWarnings(w: ActionCompatibilityWarnings): boolean {
  return (
    w.missingNodeTypes.length > 0 ||
    w.missingEdgeTypes.length > 0 ||
    w.missingProperties.length > 0 ||
    w.missingTemplateIds.length > 0 ||
    w.missingProviders.length > 0 ||
    w.sessionMetricRefs.length > 0
  );
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value != null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) if (typeof v === 'string') out[key] = v;
  }
  return out;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const kept = value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim());
  return kept.length ? kept : undefined;
}

/** A `show-table` action's source, or what is wrong with it. Shared by the import and the editor. */
export function parseCanvasTableSource(value: unknown): CanvasTableSource | string {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return 'missing "source"';
  const raw = value as Record<string, unknown>;
  if (raw.type === 'neighborhood') {
    const hops = Math.trunc(Number(raw.hops ?? 1));
    if (!Number.isFinite(hops) || hops < 1 || hops > MAX_NEIGHBORHOOD_HOPS) {
      return `"source.hops" must be 1 to ${MAX_NEIGHBORHOOD_HOPS}`;
    }
    const optional = (key: string) => {
      const list = stringList(raw[key]);
      return list ? { [key]: list } : {};
    };
    return {
      type: 'neighborhood',
      hops,
      direction: raw.direction === 'out' || raw.direction === 'in' ? raw.direction : 'any',
      list: raw.list === 'edges' ? 'edges' : 'nodes',
      ...optional('edgeTypes'),
      ...optional('nodeTypes'),
      ...optional('listEdgeTypes'),
      ...optional('columns'),
    };
  }
  if (raw.type === 'program') {
    if (typeof raw.code !== 'string' || raw.code.trim() === '') return 'missing "source.code"';
    if (raw.code.length > MAX_PROGRAM_CODE_LENGTH) return `"source.code" is longer than ${MAX_PROGRAM_CODE_LENGTH} characters`;
    const params: CanvasTableParam[] = [];
    if (raw.params != null) {
      if (!Array.isArray(raw.params)) return '"source.params" must be an array';
      for (const p of raw.params as unknown[]) {
        if (p == null || typeof p !== 'object') return '"source.params" entries must be objects';
        const r = p as Record<string, unknown>;
        if (typeof r.id !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(r.id)) return `parameter id "${String(r.id)}" must be a plain name`;
        const options = stringList(r.options);
        params.push({
          id: r.id,
          label: typeof r.label === 'string' && r.label.trim() ? r.label.trim() : r.id,
          ...(r.type === 'select' && options ? { type: 'select' as const, options } : { type: 'input' as const }),
          ...(typeof r.default === 'string' ? { default: r.default } : {}),
          ...(r.required === true ? { required: true } : {}),
          ...(typeof r.description === 'string' && r.description ? { description: r.description } : {}),
        });
      }
    }
    return { type: 'program', code: raw.code, ...(params.length ? { params } : {}) };
  }
  return '"source.type" must be "neighborhood" or "program"';
}
