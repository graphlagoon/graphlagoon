import type { ContextMenuTarget } from '@/composables/useContextMenu';

/** Max pointer travel (px) between right-button press and release for it to count as a click. */
export const RIGHT_CLICK_DRAG_THRESHOLD = 5;

const MAX_LABEL_LENGTH = 24;

export function truncateMenuLabel(label: string): string {
  return label.length > MAX_LABEL_LENGTH ? label.slice(0, MAX_LABEL_LENGTH) + '...' : label;
}

/**
 * A right-click counts as stationary (menu-opening) when the pointer travelled at most
 * `threshold` px between mousedown and mouseup. Returns false when no mousedown was
 * tracked (e.g. the press started outside the canvas).
 */
export function isStationaryRightClick(
  downPos: { x: number; y: number } | null,
  upX: number,
  upY: number,
  threshold: number = RIGHT_CLICK_DRAG_THRESHOLD,
): boolean {
  if (!downPos) return false;
  return Math.hypot(upX - downPos.x, upY - downPos.y) <= threshold;
}

/**
 * Resolves the context-menu target from the currently hovered node/link.
 * Nodes take priority over links; returns null when nothing is hovered.
 */
export function resolveContextMenuTarget(
  hoveredNode: { id: string; label: string } | null,
  hoveredLink: { id: string } | null,
): ContextMenuTarget | null {
  if (hoveredNode) {
    return { type: 'node', id: hoveredNode.id, label: truncateMenuLabel(hoveredNode.label) };
  }
  if (hoveredLink) {
    return { type: 'edge', id: hoveredLink.id, label: truncateMenuLabel(hoveredLink.id) };
  }
  return null;
}
