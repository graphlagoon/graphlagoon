/**
 * Parser/validator for the Actions editor "Import JSON" box — the return leg
 * of the Ask-AI workflow (contextMenuActionSkill.ts): the LLM outputs a JSON
 * array of action configs and the user pastes it here.
 *
 * Lenient where safe (missing id/enabled/icon get defaults), strict where it
 * matters (kind, target, url prefix). Never trusts the input shape.
 */
import type {
  ContextMenuActionConfig,
  MenuActionMatch,
  PropertyCondition,
} from '@/types/contextMenuActions';
import { isKnownActionKind } from '@/types/contextMenuActions';
import type { PortableSourceSchema } from '@/types/portable';
import { validateUrlTemplate } from './safeUrl';
import { extractTemplateProperties } from './labelFormatter';

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

export function parseImportedActionConfigs(json: string): ImportResult {
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
  },
): ActionCompatibilityWarnings {
  const nodeTypes = new Set(current.nodeTypes);
  const edgeTypes = new Set(current.edgeTypes);
  const properties = new Set([...current.nodeProperties, ...current.edgeProperties]);
  const templateIds = new Set(current.templateIds);

  const missingNodeTypes = new Set<string>();
  const missingEdgeTypes = new Set<string>();
  const missingProperties = new Set<string>();
  const missingTemplateIds = new Set<string>();

  const checkTemplate = (template: string | undefined) => {
    if (typeof template !== 'string') return;
    for (const prop of extractTemplateProperties(template)) {
      if (!properties.has(prop)) missingProperties.add(prop);
    }
  };

  for (const config of configs) {
    for (const t of config.match.nodeTypes ?? []) if (!nodeTypes.has(t)) missingNodeTypes.add(t);
    for (const t of config.match.relationshipTypes ?? []) if (!edgeTypes.has(t)) missingEdgeTypes.add(t);
    for (const c of config.match.propertyConditions ?? []) {
      if (!properties.has(c.property) && !BUILTIN_PROPERTIES.has(c.property)) {
        missingProperties.add(c.property);
      }
    }
    if (config.kind === 'open-url') checkTemplate(config.urlTemplate);
    else if (config.kind === 'copy-text') checkTemplate(config.textTemplate);
    else {
      if (!templateIds.has(config.templateId)) missingTemplateIds.add(config.templateId);
      for (const binding of Object.values(config.paramBindings)) checkTemplate(binding);
    }
  }

  return {
    missingNodeTypes: [...missingNodeTypes],
    missingEdgeTypes: [...missingEdgeTypes],
    missingProperties: [...missingProperties],
    missingTemplateIds: [...missingTemplateIds],
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
    w.missingTemplateIds.length > 0
  );
}
