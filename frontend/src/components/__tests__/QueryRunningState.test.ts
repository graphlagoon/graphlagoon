import { describe, it, expect } from 'vitest';
import { render, fireEvent } from '@testing-library/vue';
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
});
