/**
 * Parser for the Style Presets "Import JSON" box — the return leg of the
 * export flow and of the Ask-AI "adapt this preset" prompt
 * (stylePresetSkill.ts).
 *
 * Accepts, in order of preference:
 *   1. the portable envelope written by the Export button
 *      (`{ graphlagoon_export: "style-preset", settings, source, ... }`),
 *   2. a full server `StylePreset` (`{ name, settings, ... }`),
 *   3. a bare `StylePresetSettings` object (what an LLM usually answers with).
 *
 * Lenient on purpose: the server stores settings opaquely and
 * `graphStore.applyStylePreset` already normalizes every field (unknown
 * layout → 'force', absent maps → empty, behaviors through the validated
 * merge). This only rejects what is clearly not a preset and drops values
 * that would crash the type-keyed maps.
 */
import type { StylePresetSettings } from '@/types/graph';
import type { PortableSourceSchema } from '@/types/portable';
import { extractTemplateProperties, extractTemplateMetrics } from './labelFormatter';

export type StyleImportResult =
  | {
      ok: true;
      settings: StylePresetSettings;
      name?: string;
      description?: string | null;
      source?: PortableSourceSchema;
    }
  | { ok: false; error: string };

/** Keys that identify an object as a StylePresetSettings. */
const SETTINGS_KEYS: (keyof StylePresetSettings)[] = [
  'aesthetics',
  'nodeTypeColors',
  'edgeTypeColors',
  'nodeTypeIcons',
  'edgeTypeIcons',
  'nodePropertyIconConfigs',
  'textFormat',
  'layout_algorithm',
  'layout_mode_config',
  'force3d_settings',
  'visual_mapping',
  'property_visibility',
  'behaviors',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function looksLikeSettings(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && SETTINGS_KEYS.some((k) => k in value);
}

/** Keep only string→string entries of a type-keyed map. */
function stringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string') out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeSettings(raw: Record<string, unknown>): StylePresetSettings {
  const settings: Record<string, unknown> = { ...raw };
  for (const key of ['nodeTypeColors', 'edgeTypeColors', 'nodeTypeIcons', 'edgeTypeIcons']) {
    if (key in settings) settings[key] = stringMap(settings[key]);
  }
  if ('nodePropertyIconConfigs' in settings && !isRecord(settings.nodePropertyIconConfigs)) {
    delete settings.nodePropertyIconConfigs;
  }
  if ('textFormat' in settings && !isRecord(settings.textFormat)) {
    delete settings.textFormat;
  }
  if ('layout_algorithm' in settings && typeof settings.layout_algorithm !== 'string') {
    delete settings.layout_algorithm;
  }
  return settings as StylePresetSettings;
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

export function parseImportedStylePreset(json: string): StyleImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: 'Not valid JSON' };
  }
  if (!isRecord(parsed)) {
    return { ok: false, error: 'Expected a JSON object (a style preset)' };
  }

  if (parsed.graphlagoon_export != null && parsed.graphlagoon_export !== 'style-preset') {
    return {
      ok: false,
      error: `This file is a "${String(parsed.graphlagoon_export)}" export, not a style preset`,
    };
  }

  // Envelope or server StylePreset: the settings are nested.
  if ('settings' in parsed) {
    if (!isRecord(parsed.settings)) {
      return { ok: false, error: '"settings" must be an object' };
    }
    return {
      ok: true,
      settings: sanitizeSettings(parsed.settings),
      name: typeof parsed.name === 'string' ? parsed.name : undefined,
      description: typeof parsed.description === 'string' ? parsed.description : undefined,
      source: optionalSource(parsed.source),
    };
  }

  if (looksLikeSettings(parsed)) {
    return { ok: true, settings: sanitizeSettings(parsed) };
  }

  return {
    ok: false,
    error:
      'Not a style preset: expected "settings" or at least one of ' +
      SETTINGS_KEYS.slice(0, 5).join(', ') +
      ', …',
  };
}

export interface StyleCompatibilityWarnings {
  /** Node types the preset styles that the current graph does not have. */
  missingNodeTypes: string[];
  /** Relationship types the preset styles that the current graph does not have. */
  missingEdgeTypes: string[];
  /** Property columns referenced by label templates / icon configs that do not exist here. */
  missingProperties: string[];
  /**
   * Metric refs used by label templates. Session-computed — always a warning,
   * never a blocker: labels show the `[metric:x]` sentinel until computed.
   */
  sessionMetricRefs: string[];
}

/**
 * Names the preset refers to that the current graph does not know. Used to
 * tell the user "this came from a different graph — ask the AI to adapt it"
 * rather than silently applying colors nothing will ever match.
 */
export function styleCompatibilityWarnings(
  settings: StylePresetSettings,
  current: {
    nodeTypes: string[];
    edgeTypes: string[];
    nodeProperties: string[];
    edgeProperties: string[];
  },
): StyleCompatibilityWarnings {
  const nodeTypes = new Set(current.nodeTypes);
  const edgeTypes = new Set(current.edgeTypes);
  const nodeProps = new Set(current.nodeProperties);
  const edgeProps = new Set(current.edgeProperties);

  const missingNodeTypes = new Set<string>();
  const missingEdgeTypes = new Set<string>();
  const missingProperties = new Set<string>();
  const sessionMetricRefs = new Set<string>();

  for (const map of [settings.nodeTypeColors, settings.nodeTypeIcons, settings.nodePropertyIconConfigs]) {
    for (const type of Object.keys(map ?? {})) if (!nodeTypes.has(type)) missingNodeTypes.add(type);
  }
  for (const map of [settings.edgeTypeColors, settings.edgeTypeIcons]) {
    for (const type of Object.keys(map ?? {})) if (!edgeTypes.has(type)) missingEdgeTypes.add(type);
  }
  for (const config of Object.values(settings.nodePropertyIconConfigs ?? {})) {
    if (config?.property && !nodeProps.has(config.property)) missingProperties.add(config.property);
  }

  const textFormat = settings.textFormat;
  if (textFormat) {
    const check = (template: string | undefined, target: 'node' | 'edge') => {
      if (typeof template !== 'string') return;
      const known = target === 'node' ? nodeProps : edgeProps;
      for (const prop of extractTemplateProperties(template)) {
        if (!known.has(prop)) missingProperties.add(prop);
      }
      for (const ref of extractTemplateMetrics(template)) sessionMetricRefs.add(ref);
    };
    check(textFormat.defaults?.nodeTemplate, 'node');
    check(textFormat.defaults?.edgeTemplate, 'edge');
    check(textFormat.defaults?.nodeTooltipTemplate, 'node');
    check(textFormat.defaults?.edgeTooltipTemplate, 'edge');
    for (const rule of textFormat.rules ?? []) {
      check(rule.template, rule.target);
      const known = rule.target === 'node' ? nodeTypes : edgeTypes;
      const missing = rule.target === 'node' ? missingNodeTypes : missingEdgeTypes;
      for (const type of rule.types ?? []) if (!known.has(type)) missing.add(type);
    }
  }

  return {
    missingNodeTypes: [...missingNodeTypes],
    missingEdgeTypes: [...missingEdgeTypes],
    missingProperties: [...missingProperties],
    sessionMetricRefs: [...sessionMetricRefs],
  };
}

export function hasCompatibilityWarnings(w: StyleCompatibilityWarnings): boolean {
  return (
    w.missingNodeTypes.length > 0 ||
    w.missingEdgeTypes.length > 0 ||
    w.missingProperties.length > 0 ||
    w.sessionMetricRefs.length > 0
  );
}
