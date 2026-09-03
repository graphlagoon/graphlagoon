/**
 * "Hide empty values" in the right-hand side panel.
 *
 * Mirrors DetailModal.emptyValues.test.ts — the two surfaces share the
 * predicate (utils/emptyValue.ts) and must behave identically.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/vue';
import { setActivePinia, createPinia } from 'pinia';
import { nextTick } from 'vue';
import SidePanel from '@/components/SidePanel.vue';
import { useGraphStore } from '@/stores/graph';
import { useMetricsStore } from '@/stores/metrics';
import type { ComputedMetric } from '@/types/metrics';

const stubs = { JsonValueViewer: true };

const NODES = [
  {
    node_id: 'n1',
    node_type: 'Person',
    properties: { name: 'Alice', nick: null, tags: [], score: 0, active: false },
  },
  { node_id: 'n2', node_type: 'Person', properties: { name: 'Bob', nick: null } },
] as any[];

function metric(id: string, name: string, values: [string, any][]): ComputedMetric {
  return {
    id, name, algorithmId: 'custom', target: 'node', valueType: 'number',
    values: new Map(values),
    min: 0, max: 0, mean: 0, stdDev: 0, computedAt: 0, params: {},
    edgeTypeFilter: [], elapsedMs: 0,
  } as ComputedMetric;
}

function seed(selected = 'n1') {
  const graphStore = useGraphStore();
  graphStore.nodes = NODES;
  graphStore.selectNode(selected);
  return graphStore;
}

/** The `.detail-section` whose <h4> matches the label. */
function section(root: Element, label: string): HTMLElement | null {
  return (
    Array.from(root.querySelectorAll('.detail-section')).find(
      (el) => el.querySelector('h4')?.textContent?.trim() === label,
    ) as HTMLElement | undefined
  ) ?? null;
}

/** Property rows come in two shapes: a key/value row or a JSON block. */
function rowCount(root: Element, label: string): number {
  const s = section(root, label);
  if (!s) return 0;
  return s.querySelectorAll('.detail-row, .prop-json-block').length;
}

function hintIn(root: Element, label: string): HTMLElement | null {
  return section(root, label)?.querySelector('[data-testid="empty-values-hint"]') ?? null;
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('SidePanel — hide empty values', () => {
  it('drops empty properties by default, keeping 0 and false', () => {
    seed();
    const { container } = render(SidePanel, { global: { stubs } });

    expect(rowCount(container, 'Properties')).toBe(3);
    const text = section(container, 'Properties')!.textContent!;
    expect(text).toContain('name');
    expect(text).toContain('score');
    expect(text).toContain('active');
    expect(text).not.toContain('nick');
    expect(text).not.toContain('tags');
  });

  it('says how many it hid, and reveals them on demand', async () => {
    seed();
    const { container } = render(SidePanel, { global: { stubs } });

    expect(hintIn(container, 'Properties')!.textContent).toContain('2 empty hidden');

    await fireEvent.click(
      section(container, 'Properties')!.querySelector('[data-testid="empty-values-toggle"]')!,
    );

    expect(rowCount(container, 'Properties')).toBe(5);
    expect(hintIn(container, 'Properties')!.textContent).toContain('Hide empty');
  });

  it('shows everything with no hint when the setting is off', () => {
    seed().updateAesthetics({ hideEmptyValues: false });
    const { container } = render(SidePanel, { global: { stubs } });

    expect(rowCount(container, 'Properties')).toBe(5);
    expect(hintIn(container, 'Properties')).toBeNull();
  });

  it('keeps the allowlist hint reporting allowlist arithmetic', () => {
    seed().setPropertyVisibility('node', ['name', 'nick', 'score']);
    const { container } = render(SidePanel, { global: { stubs } });

    expect(rowCount(container, 'Properties')).toBe(2);
    expect(
      section(container, 'Properties')!.querySelector(
        '[data-testid="property-visibility-hint"]',
      )!.textContent,
    ).toContain('Showing 3 of 5');
    expect(hintIn(container, 'Properties')!.textContent).toContain('1 empty hidden');
  });

  it('resets the reveal when the selection changes', async () => {
    const graphStore = seed();
    const { container } = render(SidePanel, { global: { stubs } });

    await fireEvent.click(
      section(container, 'Properties')!.querySelector('[data-testid="empty-values-toggle"]')!,
    );
    expect(rowCount(container, 'Properties')).toBe(5);

    graphStore.selectNode('n2');
    await nextTick();

    expect(rowCount(container, 'Properties')).toBe(1);
    expect(hintIn(container, 'Properties')!.textContent).toContain('1 empty hidden');
  });
});

describe('SidePanel — hide empty metrics', () => {
  beforeEach(() => {
    const metrics = useMetricsStore();
    metrics.upsertMetric(metric('m1', 'Betweenness', [['n1', 0.5]]));
    metrics.upsertMetric(metric('m2', 'Failed', [['n1', null]]));
    metrics.upsertMetric(metric('m3', 'Zero', [['n1', 0]]));
  });

  it('drops the empty metric and keeps the zero one', () => {
    seed();
    const { container } = render(SidePanel, { global: { stubs } });

    expect(rowCount(container, 'Computed Metrics')).toBe(2);
    const text = section(container, 'Computed Metrics')!.textContent!;
    expect(text).toContain('Betweenness');
    expect(text).toContain('Zero');
    expect(text).not.toContain('Failed');
    expect(hintIn(container, 'Computed Metrics')!.textContent).toContain('1 empty hidden');
  });

  it('keeps the section (and the way back) when every metric is empty', () => {
    const metrics = useMetricsStore();
    metrics.deleteMetric('m1');
    metrics.deleteMetric('m3');
    seed();

    const { container } = render(SidePanel, { global: { stubs } });

    expect(section(container, 'Computed Metrics')).not.toBeNull();
    expect(rowCount(container, 'Computed Metrics')).toBe(0);
    expect(hintIn(container, 'Computed Metrics')!.textContent).toContain('1 empty hidden');
  });

  it('reveals metrics and properties together', async () => {
    seed();
    const { container } = render(SidePanel, { global: { stubs } });

    await fireEvent.click(
      section(container, 'Computed Metrics')!.querySelector(
        '[data-testid="empty-values-toggle"]',
      )!,
    );

    expect(rowCount(container, 'Computed Metrics')).toBe(3);
    expect(rowCount(container, 'Properties')).toBe(5);
  });
});
