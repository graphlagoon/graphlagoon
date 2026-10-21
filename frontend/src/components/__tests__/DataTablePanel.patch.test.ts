import { describe, it, expect, beforeEach } from 'vitest';
import { render } from '@testing-library/vue';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import PrimeVue from 'primevue/config';
import DataTablePanel from '@/components/DataTablePanel.vue';
import { useGraphStore } from '@/stores/graph';

beforeEach(() => {
  setActivePinia(createPinia());
});

// Properties patched in place (late loading, enrichment files, the user's layer) keep the
// arrays; the table follows `nodePatchVersion` so a new column shows without a re-filter.
describe('DataTablePanel — properties patched in place', () => {
  it('shows a column an enrichment adds', async () => {
    const graphStore = useGraphStore();
    graphStore.nodes = [{ node_id: 'n1', node_type: 'Person', properties: { name: 'Ana' } }];
    const { container } = render(DataTablePanel, { global: { plugins: [[PrimeVue, { theme: 'none' }]] } });
    expect(container.textContent).not.toContain('risk');

    graphStore.patchNodeProperties(new Map([['n1', { risk: 'high' }]]), { merge: true });
    await nextTick();
    // The header is the union of property keys (happy-dom renders no body cells here).
    expect(container.textContent).toContain('risk');
  });
});
