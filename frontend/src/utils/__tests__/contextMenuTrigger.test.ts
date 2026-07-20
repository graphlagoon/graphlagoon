import { describe, it, expect } from 'vitest';
import {
  isStationaryRightClick,
  resolveContextMenuTarget,
  truncateMenuLabel,
  RIGHT_CLICK_DRAG_THRESHOLD,
} from '@/utils/contextMenuTrigger';

describe('isStationaryRightClick', () => {
  it('returns true when the pointer did not move', () => {
    expect(isStationaryRightClick({ x: 100, y: 100 }, 100, 100)).toBe(true);
  });

  it('returns true for small jitter within the threshold', () => {
    // Typical 1-3px jitter of a human right-click — the exact case the library
    // used to swallow as a "drag"
    expect(isStationaryRightClick({ x: 100, y: 100 }, 102, 101)).toBe(true);
    expect(isStationaryRightClick({ x: 100, y: 100 }, 103, 104)).toBe(true);
  });

  it('returns true exactly at the threshold distance', () => {
    expect(
      isStationaryRightClick({ x: 100, y: 100 }, 100 + RIGHT_CLICK_DRAG_THRESHOLD, 100),
    ).toBe(true);
  });

  it('returns false when the pointer travelled beyond the threshold (camera drag)', () => {
    expect(isStationaryRightClick({ x: 100, y: 100 }, 150, 100)).toBe(false);
    expect(isStationaryRightClick({ x: 100, y: 100 }, 104, 104)).toBe(false); // hypot ≈ 5.66
  });

  it('returns false when no mousedown position was tracked', () => {
    expect(isStationaryRightClick(null, 100, 100)).toBe(false);
  });

  it('respects a custom threshold', () => {
    expect(isStationaryRightClick({ x: 0, y: 0 }, 8, 0, 10)).toBe(true);
    expect(isStationaryRightClick({ x: 0, y: 0 }, 8, 0, 5)).toBe(false);
  });
});

describe('resolveContextMenuTarget', () => {
  it('returns a node target when a node is hovered', () => {
    const target = resolveContextMenuTarget({ id: 'n1', label: 'Alice' }, null);
    expect(target).toEqual({ type: 'node', id: 'n1', label: 'Alice' });
  });

  it('returns an edge target when only a link is hovered', () => {
    const target = resolveContextMenuTarget(null, { id: 'e1' });
    expect(target).toEqual({ type: 'edge', id: 'e1', label: 'e1' });
  });

  it('prioritizes the node when both node and link are hovered', () => {
    const target = resolveContextMenuTarget({ id: 'n1', label: 'Alice' }, { id: 'e1' });
    expect(target?.type).toBe('node');
    expect(target?.id).toBe('n1');
  });

  it('returns null when nothing is hovered', () => {
    expect(resolveContextMenuTarget(null, null)).toBeNull();
  });

  it('truncates long node labels to 24 chars plus ellipsis', () => {
    const longLabel = 'a'.repeat(30);
    const target = resolveContextMenuTarget({ id: 'n1', label: longLabel }, null);
    expect(target?.label).toBe('a'.repeat(24) + '...');
  });

  it('truncates long edge ids in the label but keeps the full id', () => {
    const longId = 'edge-'.repeat(10);
    const target = resolveContextMenuTarget(null, { id: longId });
    expect(target?.id).toBe(longId);
    expect(target?.label).toBe(longId.slice(0, 24) + '...');
  });
});

describe('truncateMenuLabel', () => {
  it('keeps labels at or under 24 chars intact', () => {
    expect(truncateMenuLabel('short')).toBe('short');
    expect(truncateMenuLabel('x'.repeat(24))).toBe('x'.repeat(24));
  });

  it('truncates labels over 24 chars', () => {
    expect(truncateMenuLabel('x'.repeat(25))).toBe('x'.repeat(24) + '...');
  });
});
