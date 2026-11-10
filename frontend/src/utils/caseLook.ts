/**
 * Which look a case canvas wears, and whose focus it opens on.
 *
 * A graph item has up to two looks: the one saved on the item itself
 * (`item.state.look`, what the case decided) and the one its source carries
 * (the exploration's style block, or the `style` a frozen item embeds). The
 * item's wins. On a unified canvas the first canvas item (canvas order) with a
 * style sets the look for all — one look per canvas, no per-source styling.
 *
 * The focus resolves on its own: an item whose saved look only names a focus
 * keeps its exploration's colors. `focus_node_id: null` means "none, even if
 * the exploration has one"; an absent key inherits.
 *
 * Pure on purpose — no store, no Vue — so every rule is unit tested directly.
 */
import type { CaseItem, GraphLook } from '@/types/investigation';
import type { StylePresetSettings } from '@/types/graph';
import { baseSourceId, type UnifiedNode } from '@/utils/unifyGraph';

/** The slice of a loaded source the resolver reads (`SourceGraph` satisfies it). */
export interface LookSource {
  id: string;
  look?: GraphLook | null;
  state?: { revision?: number } | null;
}

/** The slice of a graph context the resolver reads (`GraphContext` satisfies it). */
export interface LookContext {
  default_behaviors?: Record<string, unknown> | null;
}

/**
 * A context's default look: the style block under the reserved
 * `default_behaviors.look` key (kept there so it needs no new column). Its
 * `behaviors` are dropped — a context's behaviors are the other keys.
 */
export function contextDefaultLook(ctx?: LookContext | null): StylePresetSettings | null {
  const raw = ctx?.default_behaviors?.look;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { behaviors: _b, ...rest } = raw as StylePresetSettings;
  return styleOf(rest as GraphLook);
}

/** A context's default behaviors: `default_behaviors` without the reserved `look` key, or null when empty. */
export function contextDefaultBehaviors(ctx?: LookContext | null): Record<string, unknown> | null {
  const raw = ctx?.default_behaviors;
  if (!raw) return null;
  const { look: _l, ...rest } = raw;
  return Object.keys(rest).length ? rest : null;
}

export interface ResolvedLook {
  /** What `applyStylePreset` receives; null = the stock look (`resetLook`). */
  look: StylePresetSettings | null;
  /** The node the canvas opens on, as the item knows it (an id local to that item). */
  focus: { sourceId: string; nodeId: string } | null;
  /** The item the look came from (a caption for the Look panel); null for a context default or the stock look. */
  sourceId: string | null;
  /** The context whose default look the canvas wears, when no item has one of its own. */
  contextId: string | null;
  /** An item of that context: ids in the default look (an ego focus) are mapped through it. */
  contextItemId: string | null;
  /** The canvas context's default behaviors (one context on the canvas), the baseline under a look's. */
  behaviors: Record<string, unknown> | null;
  /** Changes whenever anything that decides the look changes: the canvas, a version, a revision, a source's look, a saved look. */
  key: string;
}

const STYLE_KEYS: (keyof StylePresetSettings)[] = [
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

/** A look that says something about the style (not only a focus). */
export function hasStyleFields(look?: GraphLook | null): boolean {
  return !!look && STYLE_KEYS.some((k) => look[k] !== undefined && look[k] !== null);
}

/** Only the style block of a look (no focus), or null when it has none. */
export function styleOf(look?: GraphLook | null): StylePresetSettings | null {
  if (!hasStyleFields(look)) return null;
  const out: Record<string, unknown> = {};
  for (const k of STYLE_KEYS) if (look![k] !== undefined && look![k] !== null) out[k] = look![k];
  return out as StylePresetSettings;
}

/** One item's own resolution: the saved look over the source's, each field on its own rule. */
export function itemLook(item: CaseItem, source: LookSource | undefined): { style: StylePresetSettings | null; focus: string | null } {
  const saved = item.state?.look ?? null;
  const style = styleOf(saved) ?? styleOf(source?.look) ?? null;
  const focus =
    saved && 'focus_node_id' in saved
      ? (saved.focus_node_id ?? null)
      : (source?.look?.focus_node_id ?? null);
  return { style, focus };
}

/**
 * The canvas: the first canvas item with a style decides; its focus goes with it.
 * When no item has a style (saved or from its source), the first item whose
 * context has a default look gives it; then the stock look.
 */
export function resolveCanvasLook(
  canvasItems: CaseItem[],
  sources: LookSource[],
  contexts: Record<string, LookContext | undefined> = {},
): ResolvedLook {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const ctxOf = (i: CaseItem) => (i.context_id ? contexts[i.context_id] : undefined);
  // The source's look is in the key too: a source that was not loaded yet and
  // the same source once loaded must not look like the same answer. So is the
  // context's default, for an edit of the context to land.
  const key = canvasItems
    .map((i) => {
      const source = byId.get(i.id);
      return `${i.id}:${i.current_version}:${source?.state?.revision ?? ''}:${JSON.stringify(source?.look ?? null)}:${JSON.stringify(i.state?.look ?? null)}:${JSON.stringify(ctxOf(i)?.default_behaviors ?? null)}`;
    })
    .join('|');
  const contextIds = new Set(canvasItems.map((i) => i.context_id ?? null));
  const single = contextIds.size === 1 ? [...contextIds][0] : null;
  const behaviors = single ? contextDefaultBehaviors(contexts[single]) : null;
  let styled: { item: CaseItem; style: StylePresetSettings; focus: string | null } | null = null;
  let firstFocus: { item: CaseItem; focus: string } | null = null;
  for (const item of canvasItems) {
    const { style, focus } = itemLook(item, byId.get(item.id));
    if (!styled && style) styled = { item, style, focus };
    if (!firstFocus && focus) firstFocus = { item, focus };
  }
  // The focus follows the styled item when it has one; else the first item that names one.
  const focusOwner = styled?.focus ? { item: styled.item, focus: styled.focus } : firstFocus;
  const fallback = styled
    ? null
    : canvasItems.map((item) => ({ item, look: contextDefaultLook(ctxOf(item)) })).find((c) => c.look) ?? null;
  return {
    look: styled?.style ?? fallback?.look ?? null,
    focus: focusOwner ? { sourceId: focusOwner.item.id, nodeId: focusOwner.focus } : null,
    sourceId: styled?.item.id ?? null,
    contextId: fallback?.item.context_id ?? null,
    contextItemId: fallback?.item.id ?? null,
    behaviors,
    key,
  };
}

/**
 * Whether applying `next` over what is on screen changes the layout (algorithm,
 * mode config, forces). `applyStylePreset` fills what a look omits from the
 * defaults, so a look with no layout block means "the default layout": the
 * comparison is between effective values, `defaults` being what the store
 * would fill in (`current` comes from `buildStylePreset()`, already complete).
 */
export function layoutBlockChanged(
  current: StylePresetSettings,
  next: StylePresetSettings | null,
  defaults: Pick<StylePresetSettings, 'layout_mode_config' | 'force3d_settings'> = {},
): boolean {
  const modeDefaults = (defaults.layout_mode_config ?? {}) as Record<string, Record<string, unknown>>;
  const effective = (s: StylePresetSettings | null) => {
    const mode = (s?.layout_mode_config ?? {}) as Record<string, Record<string, unknown>>;
    const modes = [...new Set([...Object.keys(modeDefaults), ...Object.keys(mode)])].sort();
    return JSON.stringify({
      algorithm: s?.layout_algorithm ?? 'force',
      mode: Object.fromEntries(modes.map((m) => [m, { ...(modeDefaults[m] ?? {}), ...(mode[m] ?? {}) }])),
      force: { ...(defaults.force3d_settings ?? {}), ...(s?.force3d_settings ?? {}) },
    });
  };
  return effective(current) !== effective(next);
}

/** The unified id of a node the item knows as `localId` (an expansion counts as its base source). */
export function toUnifiedId(nodes: UnifiedNode[], sourceId: string, localId: string): string | null {
  const hit = nodes.find((n) => n.__sources?.some((o) => baseSourceId(o.sourceId) === sourceId && o.nodeId === localId));
  return hit?.node_id ?? null;
}

/** The id the item knows for a unified node, if the node came from it. */
export function toLocalId(nodes: UnifiedNode[], sourceId: string, unifiedId: string): string | null {
  const node = nodes.find((n) => n.node_id === unifiedId);
  const origin = node?.__sources?.find((o) => baseSourceId(o.sourceId) === sourceId);
  return origin?.nodeId ?? null;
}

/**
 * A look as the canvas can apply it: node ids inside it (the ego focus) are
 * the item's own; the canvas knows the unified ones. A node that is not on the
 * canvas maps to null — the canvas renders ego inert without a focus.
 */
export function mapLookToCanvas(look: StylePresetSettings, sourceId: string, nodes: UnifiedNode[]): StylePresetSettings {
  const ego = look.layout_mode_config?.ego;
  if (!ego?.focusNodeId) return look;
  return {
    ...look,
    layout_mode_config: {
      ...look.layout_mode_config!,
      ego: { ...ego, focusNodeId: toUnifiedId(nodes, sourceId, ego.focusNodeId) },
    },
  };
}

/** The inverse, before saving: a unified ego focus becomes the item's own id (or nothing). */
export function mapLookToItem(look: StylePresetSettings, sourceId: string, nodes: UnifiedNode[]): StylePresetSettings {
  const ego = look.layout_mode_config?.ego;
  if (!ego?.focusNodeId) return look;
  return {
    ...look,
    layout_mode_config: {
      ...look.layout_mode_config!,
      ego: { ...ego, focusNodeId: toLocalId(nodes, sourceId, ego.focusNodeId) },
    },
  };
}
