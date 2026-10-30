/**
 * Which look a case canvas wears (utils/caseLook): the item's saved look over
 * its source's, the focus on its own rule, the first styled canvas item on a
 * unified canvas, and the id mapping between an item and the unified graph.
 */
import { describe, it, expect } from 'vitest';
import {
  hasStyleFields,
  itemLook,
  layoutBlockChanged,
  mapLookToCanvas,
  mapLookToItem,
  resolveCanvasLook,
  toLocalId,
  toUnifiedId,
} from '@/utils/caseLook';
import type { CaseItem } from '@/types/investigation';
import type { UnifiedNode } from '@/utils/unifyGraph';

const item = (id: string, extra: Partial<CaseItem> = {}): CaseItem =>
  ({ id, kind: 'graph', subkind: 'exploration_ref', title: id, tags: [], status: 'confirmed', current_version: 1, position: 0, pinned: [], accessible: true, ...extra }) as CaseItem;

const RED = { nodeTypeColors: { Person: '#f00' } };
const BLUE = { nodeTypeColors: { Person: '#00f' } };

const nodes: UnifiedNode[] = [
  { node_id: 'a@c1', node_type: 'Person', properties: {}, __sources: [{ sourceId: 's1', nodeId: 'a', contextId: 'c1' }] },
  { node_id: 'b@c1', node_type: 'Person', properties: {}, __sources: [{ sourceId: 'expansion:s1', nodeId: 'b', contextId: 'c1' }] },
  { node_id: 'x@c2', node_type: 'Person', properties: {}, __sources: [{ sourceId: 's2', nodeId: 'x', contextId: 'c2' }] },
] as UnifiedNode[];

describe('hasStyleFields', () => {
  it('is false for nothing, an empty look and a focus-only look', () => {
    expect(hasStyleFields(null)).toBe(false);
    expect(hasStyleFields({})).toBe(false);
    expect(hasStyleFields({ focus_node_id: 'a' })).toBe(false);
    expect(hasStyleFields({ nodeTypeColors: {} })).toBe(true);
  });
});

describe('itemLook', () => {
  it('the saved look wins over the source look', () => {
    const r = itemLook(item('s1', { state: { look: RED } }), { id: 's1', look: BLUE });
    expect(r.style?.nodeTypeColors).toEqual(RED.nodeTypeColors);
  });

  it('a focus-only saved look keeps the source style and sets the focus', () => {
    const r = itemLook(item('s1', { state: { look: { focus_node_id: 'a' } } }), { id: 's1', look: { ...BLUE, focus_node_id: 'z' } });
    expect(r.style?.nodeTypeColors).toEqual(BLUE.nodeTypeColors);
    expect(r.style).not.toHaveProperty('focus_node_id');
    expect(r.focus).toBe('a');
  });

  it('focus_node_id: null beats the source focus; an absent key inherits it', () => {
    expect(itemLook(item('s1', { state: { look: { ...RED, focus_node_id: null } } }), { id: 's1', look: { focus_node_id: 'z' } }).focus).toBeNull();
    expect(itemLook(item('s1', { state: { look: RED } }), { id: 's1', look: { focus_node_id: 'z' } }).focus).toBe('z');
    expect(itemLook(item('s1'), { id: 's1', look: null }).focus).toBeNull();
  });

  it('nothing anywhere: no style, no focus', () => {
    expect(itemLook(item('s1'), undefined)).toEqual({ style: null, focus: null });
  });
});

describe('resolveCanvasLook', () => {
  it('a single item: its look and focus, named as the source', () => {
    const r = resolveCanvasLook([item('s1', { state: { look: { ...RED, focus_node_id: 'a' } } })], [{ id: 's1', look: null }]);
    expect(r.look?.nodeTypeColors).toEqual(RED.nodeTypeColors);
    expect(r.focus).toEqual({ sourceId: 's1', nodeId: 'a' });
    expect(r.sourceId).toBe('s1');
  });

  it('a unified canvas: the first canvas item with a style decides, in canvas order', () => {
    const r = resolveCanvasLook(
      [item('s1'), item('s2', { state: { look: BLUE } }), item('s3', { state: { look: RED } })],
      [{ id: 's1', look: null }, { id: 's2', look: null }, { id: 's3', look: null }],
    );
    expect(r.look?.nodeTypeColors).toEqual(BLUE.nodeTypeColors);
    expect(r.sourceId).toBe('s2');
  });

  it('the focus follows the styled item when it has one, else the first item that names one', () => {
    const styledWithFocus = resolveCanvasLook(
      [item('s1', { state: { look: { focus_node_id: 'a' } } }), item('s2', { state: { look: { ...BLUE, focus_node_id: 'x' } } })],
      [],
    );
    expect(styledWithFocus.focus).toEqual({ sourceId: 's2', nodeId: 'x' });
    const styledWithout = resolveCanvasLook(
      [item('s1', { state: { look: { focus_node_id: 'a' } } }), item('s2', { state: { look: BLUE } })],
      [],
    );
    expect(styledWithout.focus).toEqual({ sourceId: 's1', nodeId: 'a' });
  });

  it('no look anywhere resolves to null (the stock look), never to a leftover', () => {
    const r = resolveCanvasLook([item('s1')], [{ id: 's1', look: null }]);
    expect(r.look).toBeNull();
    expect(r.sourceId).toBeNull();
  });

  it('the key changes with the canvas, a version, a revision, a source look and a saved look', () => {
    const base = resolveCanvasLook([item('s1')], [{ id: 's1', look: null, state: { revision: 1 } }]).key;
    expect(resolveCanvasLook([item('s1')], []).key).not.toBe(base); // not loaded yet
    expect(resolveCanvasLook([item('s1')], [{ id: 's1', look: RED, state: { revision: 1 } }]).key).not.toBe(base);
    expect(resolveCanvasLook([item('s1'), item('s2')], [{ id: 's1', look: null, state: { revision: 1 } }]).key).not.toBe(base);
    expect(resolveCanvasLook([item('s1', { current_version: 2 })], [{ id: 's1', look: null, state: { revision: 1 } }]).key).not.toBe(base);
    expect(resolveCanvasLook([item('s1')], [{ id: 's1', look: null, state: { revision: 2 } }]).key).not.toBe(base);
    expect(resolveCanvasLook([item('s1', { state: { look: RED } })], [{ id: 's1', look: null, state: { revision: 1 } }]).key).not.toBe(base);
    expect(resolveCanvasLook([item('s1')], [{ id: 's1', look: null, state: { revision: 1 } }]).key).toBe(base);
  });
});

describe('layoutBlockChanged', () => {
  it('ignores colors and labels, notices the algorithm, the mode config and the forces', () => {
    const current = { layout_algorithm: 'force' as const, nodeTypeColors: { Person: '#f00' } };
    expect(layoutBlockChanged(current, { nodeTypeColors: { Person: '#00f' } })).toBe(false);
    expect(layoutBlockChanged(current, null)).toBe(false);
    expect(layoutBlockChanged(current, { layout_algorithm: 'hive' })).toBe(true);
    expect(layoutBlockChanged(current, { force3d_settings: { charge: -30 } })).toBe(true);
  });

  it('a look with no layout block means the default layout: unchanged when the screen is at the defaults, changed otherwise', () => {
    const defaults = { layout_mode_config: { ego: { maxHops: 2 } }, force3d_settings: { charge: -30 } } as any;
    const atDefaults = { layout_algorithm: 'force' as const, layout_mode_config: { ego: { maxHops: 2 } }, force3d_settings: { charge: -30 } } as any;
    const moved = { ...atDefaults, force3d_settings: { charge: -80 } };
    expect(layoutBlockChanged(atDefaults, { nodeTypeColors: {} }, defaults)).toBe(false);
    expect(layoutBlockChanged(moved, { nodeTypeColors: {} }, defaults)).toBe(true);
    expect(layoutBlockChanged(moved, { force3d_settings: { charge: -80 } }, defaults)).toBe(false);
  });
});

describe('id mapping', () => {
  it('maps an item-local id to the unified id and back, through expansions too', () => {
    expect(toUnifiedId(nodes, 's1', 'a')).toBe('a@c1');
    expect(toUnifiedId(nodes, 's1', 'b')).toBe('b@c1');
    expect(toUnifiedId(nodes, 's2', 'a')).toBeNull();
    expect(toLocalId(nodes, 's1', 'a@c1')).toBe('a');
    expect(toLocalId(nodes, 's2', 'a@c1')).toBeNull();
  });

  it('maps the ego focus of a look both ways', () => {
    const look = { layout_algorithm: 'ego' as const, layout_mode_config: { ego: { focusNodeId: 'a', direction: 'both', maxHops: 2, edgeTypes: [] }, hive: {}, hierarchical: {} } as any };
    const onCanvas = mapLookToCanvas(look, 's1', nodes);
    expect(onCanvas.layout_mode_config?.ego.focusNodeId).toBe('a@c1');
    expect(mapLookToItem(onCanvas, 's1', nodes).layout_mode_config?.ego.focusNodeId).toBe('a');
    expect(mapLookToCanvas(look, 's2', nodes).layout_mode_config?.ego.focusNodeId).toBeNull();
    expect(mapLookToCanvas({ nodeTypeColors: {} }, 's1', nodes)).toEqual({ nodeTypeColors: {} });
  });
});
