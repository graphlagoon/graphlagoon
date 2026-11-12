/**
 * `options.after_run` of a query template — what the canvas does once the
 * template's graph has loaded: switch layout, set ego settings, focus a node.
 *
 * The keys are the `?layout=` link grammar (`layout`, `layout.<mode>.<field>`)
 * plus `focus`, so one parser judges both and an author can copy keys from a
 * working link. Values may carry `$param` placeholders, substituted with the
 * same single-pass rule as the query itself.
 *
 * Unlike the template link, this is fail-open: the query already ran, so a bad
 * field is dropped and reported, and the rest still applies.
 */
import { parseLayoutOverrides, type ParsedLayoutOverrides } from '@/utils/layoutUrlOverrides';
import { substituteTemplateParams } from '@/utils/templateSubstitution';

export interface ResolvedAfterRun {
  layout: ParsedLayoutOverrides;
  /** Node to select and move the camera to; absent when unset or blank. */
  focusNodeId?: string;
  /** One user-facing sentence per dropped field. */
  issues: string[];
}

export function resolveTemplateAfterRun(
  afterRun: Record<string, string> | undefined,
  paramIds: string[],
  values: Record<string, string>,
): ResolvedAfterRun | null {
  if (!afterRun || Object.keys(afterRun).length === 0) return null;

  const substituted: Record<string, string> = {};
  for (const [key, raw] of Object.entries(afterRun)) {
    substituted[key] = substituteTemplateParams(raw, paramIds, values).trim();
  }

  // An optional parameter left blank empties a field: that means "not this
  // time", not an error — so blank fields are skipped before parsing.
  const layoutQuery: Record<string, string> = {};
  for (const [key, value] of Object.entries(substituted)) {
    if (key !== 'focus' && value !== '') layoutQuery[key] = value;
  }
  const layout = parseLayoutOverrides(layoutQuery);
  const focusNodeId = substituted.focus || undefined;

  // Ego without an explicit centre centres on the focus node — the common
  // case ("ego around the account I asked for") needs one field, not two.
  if (layout.algorithm === 'ego' && focusNodeId && !layout.modeConfig.ego?.focusNodeId) {
    layout.modeConfig.ego = { ...layout.modeConfig.ego, focusNodeId };
  }

  return {
    layout,
    focusNodeId,
    issues: layout.issues.map((issue) => issue.message),
  };
}
