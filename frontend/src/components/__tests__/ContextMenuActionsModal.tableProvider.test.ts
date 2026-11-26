/**
 * A "Table from a provider" action: the editor lists every table provider the
 * server registered with what it returns, and each declared parameter is left to
 * the table window, bound to the clicked item, or fixed. The modal teleports to body.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/vue';
import { setActivePinia, createPinia } from 'pinia';
import { nextTick } from 'vue';
import ContextMenuActionsModal from '@/components/ContextMenuActionsModal.vue';
import { useGraphStore } from '@/stores/graph';
import { useContextMenuActionsStore } from '@/stores/contextMenuActions';

vi.mock('@/services/api', () => ({
  api: { updateGraphContext: vi.fn().mockResolvedValue({}), listQueryTemplates: vi.fn().mockResolvedValue([]) },
}));

const el = (testid: string) => document.body.querySelector(`[data-testid="${testid}"]`);

const PROVIDERS = [{
  name: 'tx-history', label: 'Transactions (API)', description: 'Transactions of one account from the ledger service.',
  targets: ['node'],
  params: [
    { name: 'account', type: 'str', required: true, default: null, description: 'Account id', choices: null, min: null, max: null },
    { name: 'days', type: 'int', required: false, default: 90, description: 'Window', choices: null, min: 1, max: 365 },
    { name: 'kind', type: 'str', required: false, default: 'pix', description: '', choices: ['pix', 'ted'], min: null, max: null },
  ],
}];

async function open() {
  useGraphStore().currentContext = {
    id: 'ctx-1', title: 'Accounts', has_write_access: true, node_types: ['Account'],
    relationship_types: [], node_properties: [], edge_properties: [],
  } as any;
  render(ContextMenuActionsModal, { props: { modelValue: true } });
  await nextTick();
  await fireEvent.click(el('menu-action-add')!);
  await fireEvent.update(el('menu-action-label')!, 'Transactions');
}

describe('ContextMenuActionsModal — table from a provider', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });
  afterEach(() => {
    document.body.innerHTML = '';
    delete window.__GRAPH_LAGOON_CONFIG__;
  });

  it('is offered only when the server has a provider', async () => {
    await open();
    const option = el('menu-action-kind')!.querySelector('option[value="run-table-provider"]') as HTMLOptionElement;
    expect(option.disabled).toBe(true);
    expect(option.textContent).toContain('none registered on this server');
  });

  it('shows what the provider returns and saves bindings and fixed values', async () => {
    window.__GRAPH_LAGOON_CONFIG__ = { table_providers: PROVIDERS as never };
    await open();
    await fireEvent.update(el('menu-action-kind')!, 'run-table-provider');
    const save = el('menu-action-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await fireEvent.update(el('menu-action-provider-select')!, 'tx-history');
    expect(el('menu-action-provider-description')!.textContent).toContain('Transactions of one account from the ledger service.');
    const rows = [...document.body.querySelectorAll('[data-testid="menu-action-provider-param"]')];
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Account id'),
      expect.stringContaining('Window (int, 1 to 365)'),
      expect.stringContaining('one of pix, ted'),
    ]);
    expect(save.disabled).toBe(false);

    await fireEvent.update(el('menu-action-provider-how-account')!, 'bind');
    expect(el('menu-action-provider-param-error')!.textContent).toContain('account needs a template');
    expect(save.disabled).toBe(true);
    await fireEvent.update(el('menu-action-provider-value-account')!, '{node_id}');
    await fireEvent.update(el('menu-action-provider-how-days')!, 'fixed');
    await fireEvent.update(el('menu-action-provider-value-days')!, '9999');
    expect(el('menu-action-provider-param-error')!.textContent).toContain('days must be at most 365');
    await fireEvent.update(el('menu-action-provider-value-days')!, '30');
    expect(save.disabled).toBe(false);
    await fireEvent.click(save);
    const store = useContextMenuActionsStore();
    expect(store.actionConfigs[0]).toMatchObject({
      kind: 'run-table-provider', provider: 'tx-history', paramBindings: { account: '{node_id}' }, params: { days: 30 },
    });

    // Reopens as saved.
    const edit = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Edit')!;
    await fireEvent.click(edit);
    await nextTick();
    expect((el('menu-action-provider-how-days') as HTMLSelectElement).value).toBe('fixed');
    expect((el('menu-action-provider-value-account') as HTMLInputElement).value).toBe('{node_id}');
    expect((el('menu-action-provider-how-kind') as HTMLSelectElement).value).toBe('run');
  });

  it('says when the provider has no table for what the action applies to', async () => {
    window.__GRAPH_LAGOON_CONFIG__ = { table_providers: PROVIDERS as never };
    await open();
    await fireEvent.update(el('menu-action-kind')!, 'run-table-provider');
    await fireEvent.update(el('menu-action-provider-select')!, 'tx-history');
    const applies = [...document.body.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'both'))!;
    await fireEvent.update(applies, 'edge');
    expect(el('menu-action-provider-target-error')!.textContent).toContain('no table for edges');
    expect((el('menu-action-save') as HTMLButtonElement).disabled).toBe(true);
  });
});
