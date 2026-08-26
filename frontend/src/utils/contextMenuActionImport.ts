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
import { validateUrlTemplate } from './safeUrl';

const TARGETS = ['node', 'edge', 'both'];
const OPERATORS = ['exists', 'not-empty', 'equals', 'not-equals', 'contains'];

export type ImportResult =
  | { ok: true; configs: ContextMenuActionConfig[] }
  | { ok: false; error: string };

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
  return { ok: true, configs };
}
