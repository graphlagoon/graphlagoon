/**
 * Hover tooltip content.
 *
 * The tooltip reuses the label template language (see `labelFormatter.ts`), but
 * it is a DOM node rather than the canvas MSDF font, so it can afford what a
 * label cannot: accents, emoji, several lines, and longer text.
 *
 * Three rules shape everything here:
 *
 * 0. A custom rule whose surface includes tooltips wins for its types — the
 *    per-type escape hatch that needs no `{if:}`.
 * 1. Otherwise an empty tooltip template means "show what the label shows".
 *    That is the stock configuration, so a graph nobody has configured — and
 *    every preset or exploration saved before tooltip templates existed —
 *    renders exactly the tooltip it always did.
 * 2. The type chip is structural and always present. The template owns the
 *    body only, so a template that forgets to mention the type cannot leave
 *    the user without it.
 */

import type { Edge, Node, TextFormatDefaults, TextFormatRule } from '@/types/graph';
import {
  findMatchingRule,
  formatLabel,
  formatNodeLabel,
  type FormatOptions,
} from './labelFormatter';

export interface TooltipContent {
  /** Body text. May contain '\n' — rendered as line breaks (white-space: pre-line). */
  body: string;
  /** The small type chip to the right of the body. Never empty. */
  typeChip: string;
}

/**
 * Defensive cap. A template like `{prop:description}` over a column holding an
 * article would otherwise paint an unbounded box; the tooltip is
 * `pointer-events: none`, so the user cannot scroll it back into view.
 */
export const MAX_TOOLTIP_CHARS = 2000;

/** Label shown in the chip for edges, which have no "type" column of their own. */
export const EDGE_TYPE_CHIP = 'Edge';

/** Whitespace-only counts as unconfigured — a stray space must not change the tooltip. */
function isConfigured(template: string | undefined): template is string {
  return !!template && template.trim().length > 0;
}

function clamp(text: string): string {
  return text.length > MAX_TOOLTIP_CHARS
    ? `${text.slice(0, MAX_TOOLTIP_CHARS)}…`
    : text;
}

/**
 * Build the tooltip for a node.
 *
 * Resolution chain: matching tooltip-surface rule → configured tooltip default
 * → the node's label, exactly as the canvas draws it (label rules included).
 */
export function buildNodeTooltip(
  node: Node,
  rules: TextFormatRule[],
  defaults: TextFormatDefaults,
  options?: FormatOptions,
): TooltipContent {
  const rule = findMatchingRule(rules, 'node', node.node_type, 'tooltip');
  const template = rule?.template ?? defaults.nodeTooltipTemplate;
  const body = isConfigured(template)
    ? formatLabel(template, 'node', node, options)
    : formatNodeLabel(node, rules, defaults.nodeTemplate, options);

  return { body: clamp(body), typeChip: node.node_type };
}

/**
 * Build the tooltip for an edge.
 *
 * Same chain as nodes, except the final fallback is the raw
 * `relationship_type` rather than the edge *label* template: that is what the
 * tooltip showed before templates existed, and rule 1 is about preserving it.
 */
export function buildEdgeTooltip(
  edge: Edge,
  rules: TextFormatRule[],
  defaults: TextFormatDefaults,
  options?: FormatOptions,
): TooltipContent {
  const rule = findMatchingRule(rules, 'edge', edge.relationship_type, 'tooltip');
  const template = rule?.template ?? defaults.edgeTooltipTemplate;
  const body = isConfigured(template)
    ? formatLabel(template, 'edge', edge, options)
    : edge.relationship_type || '';

  return { body: clamp(body), typeChip: EDGE_TYPE_CHIP };
}
