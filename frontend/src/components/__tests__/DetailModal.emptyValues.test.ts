/**
 * "Hide empty values" in the Open details modal.
 *
 * The load-bearing assertions here are that 0/false never disappear, that the
 * two hints keep separate arithmetic (allowlist vs. empties), and that Copy All
 * still exports everything — the pruning is a view, never a data loss.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/vue';
import { setActivePinia, createPinia } from 'pinia';
import DetailModal from '@/components/DetailModal.vue';
import { useGraphStore } from '@/stores/graph';
import { useMetricsStore } from '@/stores/metrics';
import type { ComputedMetric } from '@/types/metrics';

const stubs = { JsonValueViewer: true };

const NODE = {
  type: 'node' as const,
  data: {
    node_id: 'n1',
    node_type: 'Person',
    properties: { name: 'Alice', nick: null, tags: [], score: 0, active: false },
  } as any,
};

const OTHER_NODE = {
  type: 'node' as const,
  data: {
    node_id: 'n2',
    node_type: 'Person',
    properties: { name: 'Bob', nick: null },
  } as any,
};

function metric(id: string, name: string, values: [string, any][]): ComputedMetric {
  return {
    id, name, algorithmId: 'custom', target: 'node', valueType: 'number',
    values: new Map(values),
    min: 0, max: 0, mean: 0, stdDev: 0, computedAt: 0, params: {},
    edgeTypeFilter: [], elapsedMs: 0,
  } as ComputedMetric;
}

/** The `.section` whose <h4> starts with the given label. */
function section(label: string): HTMLElement | null {
  return (
    Array.from(document.body.querySelectorAll('.section')).find((el) =>
      el.querySelector('h4')?.textContent?.trim().startsWith(label),
    ) as HTMLElement | undefined
  ) ?? null;
}

function rowCount(label: string): number {
  return section(label)?.querySelectorAll('tbody tr').length ?? 0;
}

function hintIn(label: string): HTMLElement | null {
  return section(label)?.querySelector('[data-testid="empty-values-hint"]') ?? null;
}

function renderModal(item: typeof NODE = NODE) {
  return render(DetailModal, { props: { item }, global: { stubs } });
}

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('DetailModal — hide empty values', () => {
  it('drops empty properties by default, keeping 0 and false', () => {
    renderModal();

    expect(rowCount('Properties')).toBe(3);
    const text = section('Properties')!.textContent!;
    expect(text).toContain('name');
    expect(text).toContain('score');
    expect(text).toContain('active');
    expect(text).not.toContain('nick');
    expect(text).not.toContain('tags');
  });

  it('counts the pruned list in the section header', () => {
    renderModal();
    expect(section('Properties')!.querySelector('h4')!.textContent).toContain('(3)');
  });

  it('says how many it hid, and reveals them on demand', async () => {
    renderModal();

    expect(hintIn('Properties')!.textContent).toContain('2 empty hidden');

    await fireEvent.click(
      section('Properties')!.querySelector('[data-testid="empty-values-toggle"]')!,
    );

    expect(rowCount('Properties')).toBe(5);
    expect(hintIn('Properties')!.textContent).toContain('Hide empty');
  });

  it('shows everything with no hint when the setting is off', () => {
    useGraphStore().updateAesthetics({ hideEmptyValues: false });

    renderModal();

    expect(rowCount('Properties')).toBe(5);
    expect(hintIn('Properties')).toBeNull();
  });

  it('keeps the allowlist hint reporting allowlist arithmetic', () => {
    // 5 properties, allowlist keeps 3 of them, 1 of those 3 is empty.
    useGraphStore().setPropertyVisibility('node', ['name', 'nick', 'score']);

    renderModal();

    expect(rowCount('Properties')).toBe(2);
    expect(
      section('Properties')!.querySelector('[data-testid="property-visibility-hint"]')!
        .textContent,
    ).toContain('Showing 3 of 5');
    expect(hintIn('Properties')!.textContent).toContain('1 empty hidden');
  });

  it('resets the reveal when a different item is shown', async () => {
    const { rerender } = renderModal();

    await fireEvent.click(
      section('Properties')!.querySelector('[data-testid="empty-values-toggle"]')!,
    );
    expect(rowCount('Properties')).toBe(5);

    await rerender({ item: OTHER_NODE });

    expect(rowCount('Properties')).toBe(1);
    expect(hintIn('Properties')!.textContent).toContain('1 empty hidden');
  });
});

describe('DetailModal — hide empty metrics', () => {
  beforeEach(() => {
    const metrics = useMetricsStore();
    metrics.upsertMetric(metric('m1', 'Betweenness', [['n1', 0.5]]));
    metrics.upsertMetric(metric('m2', 'Failed', [['n1', null]]));
    metrics.upsertMetric(metric('m3', 'Zero', [['n1', 0]]));
  });

  it('drops the empty metric and keeps the zero one', () => {
    renderModal();

    expect(rowCount('Computed Metrics')).toBe(2);
    const text = section('Computed Metrics')!.textContent!;
    expect(text).toContain('Betweenness');
    expect(text).toContain('Zero');
    expect(text).not.toContain('Failed');
    expect(hintIn('Computed Metrics')!.textContent).toContain('1 empty hidden');
  });

  it('keeps the section (and the way back) when every metric is empty', () => {
    const metrics = useMetricsStore();
    metrics.deleteMetric('m1');
    metrics.deleteMetric('m3');

    renderModal();

    expect(section('Computed Metrics')).not.toBeNull();
    expect(rowCount('Computed Metrics')).toBe(0);
    expect(hintIn('Computed Metrics')!.textContent).toContain('1 empty hidden');
  });

  it('reveals metrics and properties together', async () => {
    renderModal();

    await fireEvent.click(
      section('Computed Metrics')!.querySelector('[data-testid="empty-values-toggle"]')!,
    );

    expect(rowCount('Computed Metrics')).toBe(3);
    expect(rowCount('Properties')).toBe(5);
  });
});

describe('DetailModal — Copy All is an export, not a view', () => {
  it('exports every property and metric, including the empty ones', async () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    const metrics = useMetricsStore();
    metrics.upsertMetric(metric('m2', 'Failed', [['n1', null]]));
    // Pruned on screen by both rules; must still be exported.
    useGraphStore().setPropertyVisibility('node', ['name']);

    renderModal();
    await fireEvent.click(document.body.querySelector('.copy-all-btn')!);

    const payload = JSON.parse(writeText.mock.calls[0][0]);
    expect(payload.properties).toEqual({
      name: 'Alice', nick: null, tags: [], score: 0, active: false,
    });
    expect(payload.metrics).toEqual({ Failed: null });
  });
});
