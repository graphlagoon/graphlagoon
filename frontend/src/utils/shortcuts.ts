/**
 * Single source of truth for the graph canvas's mouse/keyboard shortcuts.
 *
 * Rendered by the canvas hint strip (GraphCanvas3D.vue) and by the About
 * modal's "Shortcuts" section (Toolbar.vue). The handlers themselves live in
 * GraphCanvas3D.vue (`onKeyDown`/`onKeyUp`), useAxisConstrainedRotation.ts and
 * GraphContextMenu.vue — when a binding changes there, change it here.
 */
export interface Shortcut {
  /** Key chord, one entry per key cap (rendered as <kbd>). */
  keys: string[];
  /** What it does, imperative and short. */
  label: string;
  /** Even shorter wording for the on-canvas strip (defaults to `label`). */
  short?: string;
  /** Show in the compact on-canvas strip (the About modal lists all). */
  onCanvas?: boolean;
}

export const GRAPH_SHORTCUTS: readonly Shortcut[] = [
  { keys: ['Right-click'], label: 'Node / edge actions', short: 'Actions', onCanvas: true },
  { keys: ['Alt', 'Click'], label: 'Expand node', onCanvas: true },
  { keys: ['X / Y / Z', 'Drag'], label: 'Axis rotation', onCanvas: true },
  { keys: ['Shift'], label: 'Blower (push nodes away)', short: 'Blower', onCanvas: true },
  { keys: ['Ctrl'], label: 'Vacuum (pull nodes in)' },
  { keys: ['Space', 'L'], label: 'Relayout', onCanvas: true },
  { keys: ['Space', 'C'], label: 'Reset view', onCanvas: true },
  { keys: ['Alt', 'Scroll'], label: 'Move the depth clipping plane' },
  { keys: ['Esc'], label: 'Clear selection / close menu' },
];

export const CANVAS_SHORTCUTS = GRAPH_SHORTCUTS.filter((s) => s.onCanvas);

/** Plain-text rendering, e.g. for a `title` tooltip. */
export function formatShortcuts(list: readonly Shortcut[] = GRAPH_SHORTCUTS): string {
  return list.map((s) => `${s.keys.join(' + ')} — ${s.label}`).join('\n');
}
