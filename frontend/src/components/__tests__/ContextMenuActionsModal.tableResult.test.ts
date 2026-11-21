/**
 * A run-query-template action can show its rows in a table instead of
 * replacing the graph: the editor saves `resultMode: 'table'` only when chosen
 * (absent stays graph) and reopens with the choice. The modal teleports to body.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/vue';
import { setActivePinia, createPinia } from 'pinia';
import { nextTick } from 'vue';
import ContextMenuActionsModal from '@/components/ContextMenuActionsModal.vue';
import { useGraphStore } from '@/stores/graph';
import { useContextMenuActionsStore } from '@/stores/contextMenuActions';
import { useQueryTemplatesStore } from '@/stores/queryTemplates';

vi.mock('@/services/api', () => ({
  api: { updateGraphContext: vi.fn().mockResolvedValue({}), listQueryTemplates: vi.fn().mockResolvedValue([]) },
}));

function el(testid: string) {
  return document.body.querySelector(`[data-testid="${testid}"]`);
}

async function templateForm() {
  useGraphStore().currentContext = {
    id: 'ctx-1', title: 'Companies', has_write_access: true, node_types: ['Company'],
    relationship_types: [], node_properties: [], edge_properties: [],
  } as any;
  useQueryTemplatesStore().templates = [{
    id: 'tpl-1', graph_context_id: 'ctx-1', owner_email: 'me', name: 'Company transactions', query_type: 'sql',
    query: "SELECT * FROM tx WHERE company = '$company'", parameters: [{ id: 'company', type: 'input', label: 'Company', required: true }],
    options: {}, visibility: 'shared', created_at: '', updated_at: '',
  }] as any;
  render(ContextMenuActionsModal, { props: { modelValue: true } });
  await nextTick();
  await fireEvent.click(el('menu-action-add')!);
  await fireEvent.update(el('menu-action-label')!, 'Transactions');
  await fireEvent.update(el('menu-action-kind')!, 'run-query-template');
  await fireEvent.update(el('menu-action-template-select')!, 'tpl-1');
}

describe('ContextMenuActionsModal — table result', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('saves resultMode table only when chosen and reopens with it', async () => {
    await templateForm();
    await fireEvent.click(el('menu-action-save')!);
    const store = useContextMenuActionsStore();
    expect(store.actionConfigs[0]).not.toHaveProperty('resultMode');

    await fireEvent.click(document.body.querySelector('[data-testid="menu-action-add"]')!);
    await fireEvent.update(el('menu-action-label')!, 'Transactions (table)');
    await fireEvent.update(el('menu-action-kind')!, 'run-query-template');
    await fireEvent.update(el('menu-action-template-select')!, 'tpl-1');
    await fireEvent.click(el('menu-action-result-table')!);
    await fireEvent.click(el('menu-action-save')!);
    expect(store.actionConfigs[1]).toMatchObject({ kind: 'run-query-template', resultMode: 'table' });

    const edits = [...document.body.querySelectorAll('button')].filter((b) => b.textContent?.trim() === 'Edit');
    await fireEvent.click(edits[1]);
    expect((el('menu-action-result-table') as HTMLInputElement).checked).toBe(true);
    await fireEvent.click(edits[0]);
    expect((el('menu-action-result-table') as HTMLInputElement).checked).toBe(false);
  });
});
