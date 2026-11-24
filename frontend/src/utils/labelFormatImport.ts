/**
 * Parser and merge for the Labels panel "Import JSON" box — the return leg of
 * the export flow and of the Ask-AI prompt (labelTemplateSkill.ts), so one
 * answer sets the labels of many node/edge types at once.
 *
 * Accepts, in order:
 *   1. the portable envelope written by the Export button
 *      (`{ graphlagoon_export: "label-formats", textFormat, source }`),
 *   2. a style preset (envelope, server preset or bare settings) — only its
 *      `textFormat` is taken, so labels can be lifted out of a full look,
 *   3. a bare `{ defaults?, rules? }` object (what an LLM answers with),
 *   4. a bare array of rules, or a single rule.
 *
 * Strict per rule, like the actions import: the first bad rule fails the whole
 * import, so nothing is ever half applied.
 */
import type { TextFormatDefaults, TextFormatRule, TextFormatState } from '@/types/graph';
import type { PortableSourceSchema } from '@/types/portable';
import { validateTemplate } from './labelFormatter';
import { LABEL_TEMPLATE_SYNTAX_VERSION } from './labelModifiers';

export type ImportedLabelRule = Omit<TextFormatRule, 'id'>;

export interface ImportedLabelFormats {
  /** Only the defaults the JSON names; the others are left as they are. */
  defaults: Partial<TextFormatDefaults>;
  rules: ImportedLabelRule[];
}

export type LabelFormatImportResult =
  | { ok: true; textFormat: ImportedLabelFormats; source?: PortableSourceSchema }
  | { ok: false; error: string };

const DEFAULT_KEYS: { key: keyof TextFormatDefaults; label: string }[] = [
  { key: 'nodeTemplate', label: 'Default node template' },
  { key: 'edgeTemplate', label: 'Default edge template' },
  { key: 'nodeTooltipTemplate', label: 'Default node tooltip' },
  { key: 'edgeTooltipTemplate', label: 'Default edge tooltip' },
];
const SURFACES = ['label', 'tooltip', 'both'];
const SCOPES = ['global', 'context', 'exploration'];
/** Same starting priority the rule editor gives a new rule. */
const DEFAULT_PRIORITY = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function optionalSource(value: unknown): PortableSourceSchema | undefined {
  if (!isRecord(value)) return undefined;
  const list = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  return {
    context_title: typeof value.context_title === 'string' ? value.context_title : undefined,
    node_types: list(value.node_types),
    relationship_types: list(value.relationship_types),
    node_properties: list(value.node_properties),
    edge_properties: list(value.edge_properties),
  };
}

function templateError(template: string): string | null {
  const { errors } = validateTemplate(template);
  return errors.length > 0 ? errors[0] : null;
}

function parseDefaults(raw: unknown): Partial<TextFormatDefaults> | string {
  if (raw == null) return {};
  if (!isRecord(raw)) return '"defaults" must be an object';
  const defaults: Partial<TextFormatDefaults> = {};
  for (const { key, label } of DEFAULT_KEYS) {
    if (!(key in raw) || raw[key] == null) continue;
    const value = raw[key];
    if (typeof value !== 'string') return `${label}: must be a string`;
    const error = templateError(value);
    if (error) return `${label}: ${error}`;
    defaults[key] = value;
  }
  return defaults;
}

function parseRule(raw: unknown, index: number): ImportedLabelRule | string {
  const at = `Rule ${index + 1}`;
  if (!isRecord(raw)) return `${at}: not an object`;
  if (typeof raw.name !== 'string' || raw.name.trim() === '') return `${at}: missing "name"`;
  const named = `${at} ("${raw.name.trim()}")`;
  if (raw.target !== 'node' && raw.target !== 'edge') {
    return `${named}: "target" must be "node" or "edge"`;
  }
  if (typeof raw.template !== 'string' || raw.template === '') {
    return `${named}: missing "template"`;
  }
  const error = templateError(raw.template);
  if (error) return `${named}: ${error}`;
  if (raw.types != null && (!Array.isArray(raw.types) || raw.types.some((t) => typeof t !== 'string'))) {
    return `${named}: "types" must be an array of type names`;
  }
  if (raw.priority != null && (typeof raw.priority !== 'number' || !Number.isFinite(raw.priority))) {
    return `${named}: "priority" must be a number`;
  }
  if (raw.surface != null && !SURFACES.includes(raw.surface as string)) {
    return `${named}: "surface" must be one of ${SURFACES.join(', ')}`;
  }
  return {
    name: raw.name.trim(),
    target: raw.target,
    types: (raw.types as string[] | undefined) ?? [],
    template: raw.template,
    priority: (raw.priority as number | undefined) ?? DEFAULT_PRIORITY,
    enabled: raw.enabled !== false,
    // Nothing reads scope at runtime; keep a valid value, default to the editor's.
    scope: SCOPES.includes(raw.scope as string) ? (raw.scope as TextFormatRule['scope']) : 'exploration',
    surface: (raw.surface as TextFormatRule['surface']) ?? 'label',
  };
}

const NOT_LABELS =
  'Not label formats: expected "rules" (a list of label rules) and/or "defaults"';

/** Find the `{defaults?, rules?}` payload inside whatever was pasted. */
function locatePayload(
  parsed: unknown,
): { payload: unknown; source?: PortableSourceSchema } | string {
  if (Array.isArray(parsed)) return { payload: { rules: parsed } };
  if (!isRecord(parsed)) return 'Expected a JSON object (label formats)';

  const kind = parsed.graphlagoon_export;
  if (kind != null && kind !== 'label-formats' && kind !== 'style-preset') {
    return `This file is a "${String(kind)}" export, not label formats`;
  }
  const source = optionalSource(parsed.source);

  // A style preset: lift the labels out of it.
  if (isRecord(parsed.settings)) {
    if (!isRecord(parsed.settings.textFormat)) return 'This style preset has no label formats';
    return { payload: parsed.settings.textFormat, source };
  }
  if ('textFormat' in parsed) {
    if (!isRecord(parsed.textFormat)) return '"textFormat" must be an object';
    return { payload: parsed.textFormat, source };
  }
  if ('rules' in parsed || 'defaults' in parsed) return { payload: parsed, source };
  // A single rule on its own.
  if ('template' in parsed && 'target' in parsed) return { payload: { rules: [parsed] } };
  return NOT_LABELS;
}

export function parseImportedLabelFormats(json: string): LabelFormatImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: 'Not valid JSON' };
  }
  const located = locatePayload(parsed);
  if (typeof located === 'string') return { ok: false, error: located };
  const payload = located.payload as Record<string, unknown>;

  const defaults = parseDefaults(payload.defaults);
  if (typeof defaults === 'string') return { ok: false, error: defaults };

  if (payload.rules != null && !Array.isArray(payload.rules)) {
    return { ok: false, error: '"rules" must be an array' };
  }
  const rules: ImportedLabelRule[] = [];
  for (const [i, raw] of ((payload.rules as unknown[] | undefined) ?? []).entries()) {
    const rule = parseRule(raw, i);
    if (typeof rule === 'string') return { ok: false, error: rule };
    rules.push(rule);
  }

  if (rules.length === 0 && Object.keys(defaults).length === 0) {
    return { ok: false, error: 'Nothing to import: no rules and no default templates' };
  }
  return { ok: true, textFormat: { defaults, rules }, source: located.source };
}

function newRuleId(): string {
  return `format-rule-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export interface LabelFormatMerge {
  state: TextFormatState;
  added: number;
  updated: number;
  /** Current rules dropped by `replaceRules`. */
  removed: number;
}

/**
 * Fold imported label formats into the current ones. A rule with the same
 * target and name as a current rule replaces it in place (keeping its id and
 * position); the rest are appended. Defaults the import does not name stay.
 * `replaceRules` drops the current rules first.
 */
export function mergeTextFormat(
  current: TextFormatState,
  imported: ImportedLabelFormats,
  options: { replaceRules?: boolean } = {},
): LabelFormatMerge {
  const rules: TextFormatRule[] = options.replaceRules ? [] : [...current.rules];
  // Each current rule is replaced at most once, so duplicates in an export
  // round-trip instead of collapsing into one.
  const taken = new Set<string>();
  let added = 0;
  let updated = 0;
  for (const rule of imported.rules) {
    const index = rules.findIndex(
      (r) => !taken.has(r.id) && r.target === rule.target && r.name.trim() === rule.name,
    );
    if (index >= 0) {
      const id = rules[index].id;
      rules[index] = { ...rule, id };
      taken.add(id);
      updated++;
    } else {
      const id = newRuleId();
      rules.push({ ...rule, id });
      taken.add(id);
      added++;
    }
  }
  return {
    state: {
      rules,
      defaults: { ...current.defaults, ...imported.defaults },
      syntaxVersion: LABEL_TEMPLATE_SYNTAX_VERSION,
    },
    added,
    updated,
    removed: options.replaceRules ? current.rules.length : 0,
  };
}
