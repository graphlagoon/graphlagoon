import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useToast } from '@/composables/useToast';

describe('useToast — undoable', () => {
  const { toasts, undoable, remove } = useToast();

  beforeEach(() => {
    toasts.value.splice(0, toasts.value.length);
    vi.useFakeTimers();
  });

  it('shows a toast carrying an Undo action', () => {
    undoable('Label rule deleted', () => {});
    expect(toasts.value).toHaveLength(1);
    expect(toasts.value[0].message).toBe('Label rule deleted');
    expect(toasts.value[0].action?.label).toBe('Undo');
  });

  it('runs the callback once and dismisses itself', () => {
    const onUndo = vi.fn();
    undoable('Cluster deleted', onUndo);

    toasts.value[0].action!.onClick();

    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(toasts.value).toHaveLength(0);
  });

  it('stays up longer than a plain toast, then goes away on its own', () => {
    undoable('Metric deleted', () => {});
    expect(toasts.value[0].duration).toBe(8000);

    vi.advanceTimersByTime(3000);
    expect(toasts.value).toHaveLength(1);

    vi.advanceTimersByTime(5000);
    expect(toasts.value).toHaveLength(0);
  });

  it('leaves other toasts alone when one is dismissed', () => {
    const first = undoable('one', () => {});
    undoable('two', () => {});
    remove(first);
    expect(toasts.value.map((t) => t.message)).toEqual(['two']);
  });
});
