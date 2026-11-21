import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/vue';
import { setActivePinia, createPinia } from 'pinia';
import PrimeVue from 'primevue/config';
import MenuActionTableModal from '@/components/MenuActionTableModal.vue';
import type { MenuActionTableRequest } from '@/composables/useMenuActionTable';
import type { MenuActionTableResponse } from '@/types/graph';

const runMenuActionTable = vi.fn();
const getTableQueryStatus = vi.fn();
const cancelTableQuery = vi.fn();
const createInvestigationItem = vi.fn();
vi.mock('@/services/api', () => ({
  api: {
    runMenuActionTable: (...a: unknown[]) => runMenuActionTable(...a),
    getTableQueryStatus: (...a: unknown[]) => getTableQueryStatus(...a),
    cancelTableQuery: (...a: unknown[]) => cancelTableQuery(...a),
    createInvestigationItem: (...a: unknown[]) => createInvestigationItem(...a),
  },
}));

const REQUEST: MenuActionTableRequest = {
  contextId: 'ctx-1',
  actionId: 'tx',
  label: 'Transactions',
  target: { type: 'node', id: 'co-1', node_type: 'Company' },
  parameters: { company: 'co-1' },
};

function answer(overrides: Partial<MenuActionTableResponse> = {}): MenuActionTableResponse {
  return {
    action_id: 'tx',
    label: 'Transactions',
    template_id: 't1',
    template_name: 'Company transactions',
    query_type: 'sql',
    parameters: [
      { id: 'company', label: 'Company', type: 'input', required: true, binding: '{node_id}', value: 'co-1', source: 'given' },
      { id: 'days', label: 'Days', type: 'input', required: true, value: '30', source: 'default' },
    ],
    problems: {},
    status: 'succeeded',
    columns: ['account', 'amount'],
    rows: [['acc-1', '10'], ['acc-2', '20']],
    row_count: 2,
    row_limit: 10000,
    truncated: false,
    ...overrides,
  };
}

function mount(props: Record<string, unknown> = {}) {
  return render(MenuActionTableModal, {
    props: { request: REQUEST, ...props },
    global: { plugins: [[PrimeVue, { theme: 'none' }]] },
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  [runMenuActionTable, getTableQueryStatus, cancelTableQuery, createInvestigationItem].forEach((f) => f.mockReset());
});
afterEach(() => cleanup());

describe('MenuActionTableModal', () => {
  it('runs on open with the bound values and shows the rows and the parameters', async () => {
    runMenuActionTable.mockResolvedValue(answer());
    const { findByText, getByTestId } = mount();
    expect(await findByText('2 rows')).toBeTruthy();
    expect(runMenuActionTable).toHaveBeenCalledWith('ctx-1', 'tx', {
      target: REQUEST.target, parameters: { company: 'co-1' }, row_limit: 10000,
    });
    expect((getByTestId('menu-action-param-days') as HTMLInputElement).value).toBe('30');
  });

  it('runs again with an edited filter', async () => {
    runMenuActionTable.mockResolvedValue(answer());
    const { findByText, getByTestId } = mount();
    await findByText('2 rows');
    await fireEvent.update(getByTestId('menu-action-param-days'), '90');
    // The rows on screen are still the 30-day ones: say so until Run.
    expect(getByTestId('menu-action-table-changed')).toBeTruthy();
    await fireEvent.click(getByTestId('menu-action-table-run'));
    await waitFor(() => expect(runMenuActionTable).toHaveBeenCalledTimes(2));
    expect(runMenuActionTable.mock.calls[1][2].parameters).toEqual({ company: 'co-1', days: '90' });
  });

  it('polls a running query to its rows', async () => {
    runMenuActionTable.mockResolvedValue(answer({ status: 'running', statement_id: 's1', columns: [], rows: [], row_count: 0 }));
    getTableQueryStatus.mockResolvedValue({
      status: 'succeeded', statement_id: 's1', columns: ['account'], rows: [['acc-9']], row_count: 1, truncated: true,
    });
    const { findByText, getByTestId } = mount();
    expect(await findByText('1 rows', {}, { timeout: 3000 })).toBeTruthy();
    expect(getTableQueryStatus).toHaveBeenCalledWith('ctx-1', 's1', 10000);
    expect(getByTestId('menu-action-table-truncated').textContent).toContain('Load up to 100,000');
  });

  it('closing while the query runs cancels it; a byte-capped poll result says it is cut', async () => {
    runMenuActionTable.mockResolvedValue(answer({ status: 'running', statement_id: 's2', columns: [], rows: [], row_count: 0 }))
    getTableQueryStatus.mockReturnValue(new Promise(() => {}))
    const first = mount()
    await waitFor(() => expect(runMenuActionTable).toHaveBeenCalled())
    first.unmount()
    await waitFor(() => expect(cancelTableQuery).toHaveBeenCalledWith('ctx-1', 's2'))

    getTableQueryStatus.mockResolvedValue({
      status: 'succeeded', statement_id: 's2', columns: ['a'], rows: [['1']], row_count: 1, truncated: false, total_row_count: 50,
    })
    const second = mount()
    expect(await second.findByTestId('menu-action-table-truncated', {}, { timeout: 3000 })).toBeTruthy()
  });

  it('shows what a parameter needs, an empty result and a failure', async () => {
    runMenuActionTable.mockResolvedValueOnce(answer({ status: 'needs_parameters', problems: { days: 'needs a value' }, columns: [], rows: [] }));
    const first = mount();
    expect(await first.findByTestId('menu-action-table-needs')).toBeTruthy();
    expect(await first.findByText('needs a value')).toBeTruthy();
    cleanup();

    runMenuActionTable.mockResolvedValueOnce(answer({ columns: [], rows: [], row_count: 0 }));
    const empty = mount();
    expect(await empty.findByTestId('menu-action-table-empty')).toBeTruthy();
    cleanup();

    runMenuActionTable.mockResolvedValueOnce(answer({ status: 'failed', error: { code: 'SQL_ERROR', message: 'Table not found: tx' }, columns: [], rows: [] }));
    const failed = mount();
    expect((await failed.findByTestId('menu-action-table-error')).textContent).toContain('Table not found: tx');
  });

  it('adds the rows to the case with the action as provenance', async () => {
    runMenuActionTable.mockResolvedValue(answer());
    createInvestigationItem.mockResolvedValue({ id: 'i1', kind: 'table', title: 't' });
    const { findByTestId } = mount({ caseId: 'case-1' });
    const add = await findByTestId('menu-action-table-add-to-case');
    await fireEvent.click(add);
    await waitFor(() => expect(createInvestigationItem).toHaveBeenCalled());
    const [caseId, body] = createInvestigationItem.mock.calls[0];
    expect(caseId).toBe('case-1');
    // Named after what ran (the bound node is in the title already).
    expect(body.title).toBe('Transactions · co-1 · Days 30');
    await waitFor(() => expect(add.textContent).toContain('Added'));
    expect((add as HTMLButtonElement).disabled).toBe(true);
    expect(body.content_json).toEqual({ columns: ['account', 'amount'], rows: [['acc-1', '10'], ['acc-2', '20']], row_count: 2 });
    expect(body.provenance).toMatchObject({ tool: 'menu_action', params: { action: 'tx', values: { company: 'co-1', days: '30' } } });
  });
});
