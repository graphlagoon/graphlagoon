import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent } from '@testing-library/vue';
import { nextTick } from 'vue';
import QueryRunningState from '@/components/QueryRunningState.vue';

describe('QueryRunningState', () => {
  it('shows only the spinner + label when there is no chunk progress', () => {
    const { getByTestId, queryByTestId } = render(QueryRunningState, {
      props: { label: 'Running query…' },
    });
    expect(getByTestId('query-running')).toBeTruthy();
    // No chunk bar, no cancel button by default.
    expect(queryByTestId('query-running-chunks')).toBeNull();
    expect(queryByTestId('query-running-cancel')).toBeNull();
  });

  it('does not show the chunk bar for a single chunk (total <= 1)', () => {
    const { queryByTestId } = render(QueryRunningState, {
      props: { chunkProgress: { done: 1, total: 1 } },
    });
    expect(queryByTestId('query-running-chunks')).toBeNull();
  });

  it('renders a float-safe percentage + loaded/total for multi-chunk progress', () => {
    const { getByTestId } = render(QueryRunningState, {
      props: { chunkProgress: { done: 12, total: 27 } },
    });
    // 12/27 = 44.444…% → formatted with toFixed(1), never string-truncated.
    expect(getByTestId('query-running-pct').textContent).toBe('44.4%');
    expect(getByTestId('query-running-count').textContent?.trim()).toBe(
      '12/27 chunks',
    );
  });

  it('formats a whole-number percentage without mangling it', () => {
    const { getByTestId } = render(QueryRunningState, {
      props: { chunkProgress: { done: 4, total: 4 } },
    });
    // total>1 so the bar shows; 4/4 = 100.0%, not "100." or "100".
    expect(getByTestId('query-running-pct').textContent).toBe('100.0%');
  });

  it('shows the Cancel button and emits cancel when clicked', async () => {
    const { getByTestId, emitted } = render(QueryRunningState, {
      props: { canCancel: true, chunkProgress: { done: 2, total: 5 } },
    });
    const btn = getByTestId('query-running-cancel');
    await fireEvent.click(btn);
    expect(emitted().cancel).toBeTruthy();
  });

  describe('elapsed timer', () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    /** Drive the interval and let Vue flush the reactive update. */
    async function advance(ms: number, base: number) {
      // performance.now() is read on each tick; keep it in step with the clock.
      vi.spyOn(performance, 'now').mockReturnValue(base + ms);
      vi.advanceTimersByTime(ms);
      await nextTick();
    }

    it('starts at 0s and counts whole seconds', async () => {
      vi.useFakeTimers();
      vi.spyOn(performance, 'now').mockReturnValue(1000);
      const { getByTestId } = render(QueryRunningState, {});
      expect(getByTestId('query-running-elapsed').textContent?.trim()).toBe('0s');

      await advance(5000, 1000);
      expect(getByTestId('query-running-elapsed').textContent?.trim()).toBe('5s');
    });

    it('floors sub-second progress — never shows a float', async () => {
      vi.useFakeTimers();
      vi.spyOn(performance, 'now').mockReturnValue(0);
      const { getByTestId } = render(QueryRunningState, {});

      // 3.999s of wall-clock must read as "3s", not "3.999s" or "4s".
      await advance(3999, 0);
      expect(getByTestId('query-running-elapsed').textContent?.trim()).toBe('3s');
    });

    it('switches to minutes with zero-padded seconds past 60s', async () => {
      vi.useFakeTimers();
      vi.spyOn(performance, 'now').mockReturnValue(0);
      const { getByTestId } = render(QueryRunningState, {});

      await advance(65_000, 0);
      expect(getByTestId('query-running-elapsed').textContent?.trim()).toBe(
        '1m 05s',
      );

      await advance(125_000, 0);
      expect(getByTestId('query-running-elapsed').textContent?.trim()).toBe(
        '2m 05s',
      );
    });

    it('can be hidden via showElapsed=false', () => {
      const { queryByTestId } = render(QueryRunningState, {
        props: { showElapsed: false },
      });
      expect(queryByTestId('query-running-elapsed')).toBeNull();
    });
  });
});
