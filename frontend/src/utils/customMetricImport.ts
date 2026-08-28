/**
 * Parser/validator for custom-metric JSON — the return leg of the Ask-AI
 * prompt (customMetricSkill.ts) and the import side of "Export JSON".
 *
 * Accepts, in order of what people actually paste:
 *   - the bare object an LLM answers with: { name, target, value_type, code, description? }
 *   - an array of such objects
 *   - the portable envelope written by Export JSON ({ graphlagoon_export: 'custom-metrics', metrics: [...] })
 *   - an LLM answer wrapped in a ```json fence
 *
 * Lenient where safe (missing id → generated, missing value_type → number,
 * description trimmed), strict where it matters (name, target, value_type,
 * code and the server-side length caps). Never trusts the input shape.
 */
import type { CustomMetricDefinition } from '@/types/customMetrics';
import {
  CUSTOM_METRIC_MAX_CODE_LENGTH,
  CUSTOM_METRIC_MAX_DESCRIPTION_LENGTH,
  CUSTOM_METRIC_MAX_NAME_LENGTH,
} from '@/types/customMetrics';
import type { PortableSourceSchema } from '@/types/portable';

const TARGETS = ['node', 'edge'] as const;
const VALUE_TYPES = ['number', 'string', 'boolean'] as const;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export type CustomMetricImportResult =
  | { ok: true; definitions: CustomMetricDefinition[]; source?: PortableSourceSchema }
  | { ok: false; error: string };

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

/** Strip a ```json … ``` fence an LLM may wrap its answer in. */
function unfence(text: string): string {
  const m = /^\s*```(?:json|javascript|js)?\s*\n([\s\S]*?)\n\s*```\s*$/i.exec(text);
  return m ? m[1] : text;
}

function parseOne(raw: unknown, index: number, total: number): CustomMetricDefinition | string {
  const label = total > 1 ? `Metric ${index + 1}: ` : '';
  if (!isRecord(raw)) return `${label}not an object`;

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return `${label}missing "name"`;
  if (name.length > CUSTOM_METRIC_MAX_NAME_LENGTH) {
    return `${label}"name" must be at most ${CUSTOM_METRIC_MAX_NAME_LENGTH} characters`;
  }

  const target = raw.target;
  if (typeof target !== 'string' || !(TARGETS as readonly string[]).includes(target)) {
    return `${label}"target" must be one of ${TARGETS.join(', ')}`;
  }

  const valueType = raw.value_type ?? raw.valueType ?? 'number';
  if (typeof valueType !== 'string' || !(VALUE_TYPES as readonly string[]).includes(valueType)) {
    return `${label}"value_type" must be one of ${VALUE_TYPES.join(', ')}`;
  }

  // An LLM sometimes answers with an array of lines for readability.
  const code = Array.isArray(raw.code)
    ? raw.code.filter((l): l is string => typeof l === 'string').join('\n')
    : raw.code;
  if (typeof code !== 'string' || code.trim() === '') return `${label}missing "code"`;
  if (code.length > CUSTOM_METRIC_MAX_CODE_LENGTH) {
    return `${label}"code" must be at most ${CUSTOM_METRIC_MAX_CODE_LENGTH} characters`;
  }

  let description: string | undefined;
  if (raw.description != null) {
    if (typeof raw.description !== 'string') return `${label}"description" must be a string`;
    description = raw.description.trim() || undefined;
    if (description && description.length > CUSTOM_METRIC_MAX_DESCRIPTION_LENGTH) {
      return `${label}"description" must be at most ${CUSTOM_METRIC_MAX_DESCRIPTION_LENGTH} characters`;
    }
  }

  const id = typeof raw.id === 'string' && ID_PATTERN.test(raw.id) ? raw.id : crypto.randomUUID();
  const autoRun = raw.auto_run ?? raw.autoRun;
  if (autoRun !== undefined && typeof autoRun !== 'boolean') return `${label}"auto_run" must be a boolean`;
  const showInTable = raw.show_in_table ?? raw.showInTable;
  if (showInTable !== undefined && typeof showInTable !== 'boolean') {
    return `${label}"show_in_table" must be a boolean`;
  }

  const def: CustomMetricDefinition = {
    id,
    name,
    target: target as CustomMetricDefinition['target'],
    value_type: valueType as CustomMetricDefinition['value_type'],
    code,
  };
  if (description) def.description = description;
  if (autoRun === true) def.auto_run = true;
  if (showInTable === true) def.show_in_table = true;
  return def;
}

export function parseImportedCustomMetrics(json: string): CustomMetricImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfence(json));
  } catch {
    return { ok: false, error: 'Not valid JSON' };
  }

  let source: PortableSourceSchema | undefined;
  if (isRecord(parsed) && parsed.graphlagoon_export != null) {
    if (parsed.graphlagoon_export !== 'custom-metrics') {
      return {
        ok: false,
        error: `This file is a "${String(parsed.graphlagoon_export)}" export, not custom metrics`,
      };
    }
    if (!Array.isArray(parsed.metrics)) return { ok: false, error: '"metrics" must be an array' };
    source = optionalSource(parsed.source);
    parsed = parsed.metrics;
  }

  const rawList = Array.isArray(parsed) ? parsed : [parsed];
  if (rawList.length === 0) return { ok: false, error: 'Empty list' };

  const definitions: CustomMetricDefinition[] = [];
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  for (let i = 0; i < rawList.length; i++) {
    const def = parseOne(rawList[i], i, rawList.length);
    if (typeof def === 'string') return { ok: false, error: def };
    // Ids and names must be unique within one import (the server rejects duplicates).
    if (seenIds.has(def.id)) def.id = crypto.randomUUID();
    const key = def.name.toLowerCase();
    if (seenNames.has(key)) return { ok: false, error: `Duplicate metric name "${def.name}"` };
    seenIds.add(def.id);
    seenNames.add(key);
    definitions.push(def);
  }
  return { ok: true, definitions, source };
}

// ---------------------------------------------------------------------------
// Compatibility warnings
// ---------------------------------------------------------------------------

/** `item.properties.foo`, `item.properties['foo']`, `item.properties["foo"]`, `n.properties.foo` (ctx.node(...)). */
const PROPERTY_REFS = /\.properties(?:\.([A-Za-z_$][\w$]*)|\[\s*(['"])([^'"]+)\2\s*\])/g;
/** `ctx.metric('ref')` / `ctx.metrics['Name']` / `ctx.metrics.Name`. */
const METRIC_REFS = /ctx\.metric\(\s*(['"])([^'"]+)\1|ctx\.metrics(?:\[\s*(['"])([^'"]+)\3\s*\]|\.([A-Za-z_$][\w$]*))/g;

/** Property names a definition's code reads (best-effort static scan). */
export function extractCodeProperties(code: string): string[] {
  const out = new Set<string>();
  for (const m of code.matchAll(PROPERTY_REFS)) out.add(m[1] ?? m[3]);
  return [...out];
}

/** Metric references (`ctx.metric('pagerank')`, `ctx.metrics['Degree']`) a definition's code uses. */
export function extractCodeMetricRefs(code: string): string[] {
  const out = new Set<string>();
  for (const m of code.matchAll(METRIC_REFS)) out.add(m[2] ?? m[4] ?? m[5]);
  return [...out];
}

export interface CustomMetricCompatibilityWarnings {
  /** Properties the code reads that neither node nor edge properties of this context declare. */
  missingProperties: string[];
  /** Metric references (algorithm ids / names) not available on this graph right now. */
  missingMetricRefs: string[];
  /** Names that collide with existing custom metrics (case-insensitive). */
  nameCollisions: string[];
}

export function customMetricCompatibilityWarnings(
  definitions: CustomMetricDefinition[],
  current: {
    nodeProperties: string[];
    edgeProperties: string[];
    /** Metric names + algorithm ids reachable through ctx.metric / ctx.metrics */
    metricRefs: string[];
    existingNames: string[];
  },
): CustomMetricCompatibilityWarnings {
  const properties = new Set([...current.nodeProperties, ...current.edgeProperties]);
  const metricRefs = new Set(current.metricRefs);
  const existing = new Set(current.existingNames.map((n) => n.toLowerCase()));
  const missingProperties = new Set<string>();
  const missingMetricRefs = new Set<string>();
  const nameCollisions = new Set<string>();

  for (const def of definitions) {
    for (const p of extractCodeProperties(def.code)) if (!properties.has(p)) missingProperties.add(p);
    for (const r of extractCodeMetricRefs(def.code)) if (!metricRefs.has(r)) missingMetricRefs.add(r);
    if (existing.has(def.name.toLowerCase())) nameCollisions.add(def.name);
  }
  return {
    missingProperties: [...missingProperties],
    missingMetricRefs: [...missingMetricRefs],
    nameCollisions: [...nameCollisions],
  };
}

export function hasCustomMetricCompatibilityWarnings(w: CustomMetricCompatibilityWarnings): boolean {
  return w.missingProperties.length > 0 || w.missingMetricRefs.length > 0 || w.nameCollisions.length > 0;
}
