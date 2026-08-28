import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/vue';
import { setActivePinia, createPinia } from 'pinia';
import CustomMetricSkillModal from '@/components/CustomMetricSkillModal.vue';
import { useGraphStore } from '@/stores/graph';
import { useCustomMetricsStore } from '@/stores/customMetrics';
import { useMetricsStore } from '@/stores/metrics';
import { createComputedMetric } from '@/__tests__/fixtures/metrics';

vi.mock('@/services/api', () => ({ api: { updateGraphContext: vi.fn() } }));
vi.mock('@/services/customMetricRunner', () => ({
  runDefinitions: vi.fn(() => ({ cancel: vi.fn(), done: new Promise(() => {}) })),
  serializeGraphForCustomMetrics: vi.fn(() => ({})),
  testDefinition: vi.fn(),
}));

const mockClipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
Object.defineProperty(navigator, 'clipboard', { value: mockClipboard, writable: true });

function seed() {
  const g = useGraphStore();
  g.nodes = [{ node_id: 'n1', node_type: 'Person' }, { node_id: 'n2', node_type: 'Company' }];
  g.edges = [{ edge_id: 'e1', src: 'n1', dst: 'n2', relationship_type: 'WORKS_AT' }];
  const m = useMetricsStore();
  m.completeComputation(createComputedMetric({ id: 'run-1', name: 'PageRank (1)', algorithmId: 'pagerank' }));
  m.upsertMetric(createComputedMetric({ id: 'custom:x', name: 'Mine', algorithmId: 'custom' }));
  useCustomMetricsStore().hydrateFromContext([
    { id: 'x', name: 'Mine', target: 'node', value_type: 'number', code: 'return 1;' },
  ]);
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

afterEach(() => {
  document.body.querySelectorAll('.modal-overlay').forEach((el) => el.remove());
});

describe('CustomMetricSkillModal', () => {
  it('is hidden when modelValue is false', () => {
    seed();
    render(CustomMetricSkillModal, { props: { modelValue: false } });
    expect(document.body.querySelector('[data-testid="custom-metric-skill-modal"]')).toBeNull();
  });

  it('renders the prompt with graph types, non-custom metrics and taken custom names', () => {
    seed();
    render(CustomMetricSkillModal, { props: { modelValue: true } });
    const text = document.body.querySelector('[data-testid="custom-metric-skill-text"]')?.textContent ?? '';
    expect(text).toContain('Person');
    expect(text).toContain('WORKS_AT');
    expect(text).toContain('- Degree (node)');
    expect(text).toContain('- PageRank (1) (node)');
    expect(text).toContain('- Mine'); // as a taken custom name…
    expect(text).not.toContain('- Mine (node)'); // …never as an available ctx metric
  });

  it('copies the prompt and emits close', async () => {
    seed();
    const { emitted } = render(CustomMetricSkillModal, { props: { modelValue: true } });
    await fireEvent.click(document.body.querySelector('[data-testid="custom-metric-skill-copy"]') as HTMLButtonElement);
    expect(mockClipboard.writeText).toHaveBeenCalledTimes(1);
    expect(mockClipboard.writeText.mock.calls[0][0]).toContain('custom metric');
    await fireEvent.click(document.body.querySelector('[data-testid="custom-metric-skill-modal"] .close-btn') as HTMLButtonElement);
    expect(emitted()['update:modelValue']).toEqual([[false]]);
  });
});
