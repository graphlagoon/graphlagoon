import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { api } from '@/services/api';
import { useLiveRevision, type LiveTargets } from '@/composables/useLiveRevision';
import type { LiveResponse } from '@/types/graph';

const answer = (refresh = 5): LiveResponse => ({ refresh_seconds: refresh, explorations: { x1: { revision: 2, last_change: null } }, cases: {} });

function host(targets: () => LiveTargets, onUpdate = vi.fn(), paused?: () => boolean) {
  const Comp = defineComponent({
    setup() {
      useLiveRevision({ targets, onUpdate, paused });
      return () => h('div');
    },
  });
  return { wrapper: mount(Comp), onUpdate };
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

describe('useLiveRevision', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.restoreAllMocks();
    setVisibility('visible');
    window.__GRAPH_LAGOON_CONFIG__ = { live_refresh_seconds: 5 } as never;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks every refresh_seconds for the open targets and hands the answer over', async () => {
    const get = vi.spyOn(api, 'getLive').mockResolvedValue(answer());
    const { onUpdate, wrapper } = host(() => ({ exploration: 'x1' }));
    expect(get).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(get).toHaveBeenCalledWith({ explorations: ['x1'], cases: [] });
    expect(onUpdate).toHaveBeenCalledWith(answer());
    await vi.advanceTimersByTimeAsync(5000);
    expect(get).toHaveBeenCalledTimes(2);
    wrapper.unmount();
    await vi.advanceTimersByTimeAsync(20000);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('skips while the tab is hidden and asks at once when it comes back', async () => {
    const get = vi.spyOn(api, 'getLive').mockResolvedValue(answer());
    host(() => ({ case: 'c1' }));
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(15000);
    expect(get).not.toHaveBeenCalled();
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
    expect(get).toHaveBeenCalledWith({ explorations: [], cases: ['c1'] });
  });

  it('nothing open, or paused, asks nothing; refresh_seconds 0 from the server stops it', async () => {
    const get = vi.spyOn(api, 'getLive').mockResolvedValue(answer(0));
    let paused = true;
    let target: string | null = null;
    host(() => ({ exploration: target }), vi.fn(), () => paused);
    await vi.advanceTimersByTimeAsync(10000);
    expect(get).not.toHaveBeenCalled();
    target = 'x1';
    await vi.advanceTimersByTimeAsync(5000);
    expect(get).not.toHaveBeenCalled();
    paused = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60000);
    expect(get).toHaveBeenCalledTimes(1);
  });
});
