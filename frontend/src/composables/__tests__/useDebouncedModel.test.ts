import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ref, nextTick } from 'vue';
import { useDebouncedModel } from '@/composables/useDebouncedModel';

describe('useDebouncedModel', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('initializes the input from the current target value', () => {
    const target = ref<string | null>('hello');
    const local = useDebouncedModel(() => target.value, v => { target.value = v; }, 300);
    expect(local.value).toBe('hello');
  });

  it('debounces writes to the target', async () => {
    const target = ref<string | null>(null);
    const local = useDebouncedModel(() => target.value, v => { target.value = v; }, 300);

    local.value = 'a';
    await nextTick();
    expect(target.value).toBeNull(); // not yet written

    vi.advanceTimersByTime(299);
    expect(target.value).toBeNull();

    vi.advanceTimersByTime(1);
    expect(target.value).toBe('a');
  });

  it('collapses rapid keystrokes into a single trailing write', async () => {
    const write = vi.fn();
    const target = ref<string | null>(null);
    const local = useDebouncedModel(() => target.value, v => { write(v); target.value = v; }, 300);

    for (const ch of ['f', 'fo', 'foo']) {
      local.value = ch;
      await nextTick();
      vi.advanceTimersByTime(100); // less than the window between keystrokes
    }
    expect(write).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('foo');
    expect(target.value).toBe('foo');
  });

  it('flows a distinct external target change back to the input and cancels a pending write', async () => {
    const write = vi.fn();
    const target = ref<string | null>('start');
    const local = useDebouncedModel(() => target.value, v => { write(v); target.value = v; }, 300);

    local.value = 'typing';
    await nextTick(); // schedules a debounced write of 'typing'

    // External change to a *different* value before the timer fires
    // (e.g. a tab switch whose filter carries another value).
    target.value = 'external';
    await nextTick();
    expect(local.value).toBe('external'); // input followed the target immediately

    vi.advanceTimersByTime(300);
    expect(write).not.toHaveBeenCalled(); // the pending 'typing' write was cancelled
    expect(target.value).toBe('external');
  });
});
