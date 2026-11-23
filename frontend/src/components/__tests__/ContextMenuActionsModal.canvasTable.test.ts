/**
 * "Table from the canvas" (show-table): the editor builds a neighborhood or a
 * program source, refuses what cannot run, reopens with it, and "Test" shows a
 * preview on the selected node. The modal teleports to body.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/vue';
import { setActivePinia, createPinia } from 'pinia';
import { nextTick } from 'vue';
import ContextMenuActionsModal from '@/components/ContextMenuActionsModal.vue';
import { useGraphStore } from '@/stores/graph';
import { useContextMenuActionsStore } from '@/stores/contextMenuActions';

vi.mock('@/services/api', () => ({
  api: { updateGraphContext: vi.fn().mockResolvedValue({}), listQueryTemplates: vi.fn().mockResolvedValue([]) },
}));
// CodeMirror does not run in jsdom: a textarea stands in.
vi.mock('@/components/JavaScriptEditor.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    default: defineComponent({
      props: { modelValue: { type: String, default: '' } },
      emits: ['update:modelValue'],
      setup(props, { emit }) {
        return () =>
          h('textarea', {
            'data-testid': 'js-editor',
            value: props.modelValue,
            onInput: (e: Event) => emit('update:modelValue', (e.target as HTMLTextAreaElement).value),
          });
      },
    }),
  };
});

const el = (testid: string) => document.body.querySelector(`[data-testid="${testid}"]`);

async function canvasForm() {
  const graph = useGraphStore();
  graph.currentContext = {
    id: 'ctx-1', title: 'Companies', has_write_access: true, node_types: ['Company', 'Account'],
    relationship_types: ['OWNS'], node_properties: [], edge_properties: [],
  } as any;
  graph.nodes = [
    { node_id: 'co', node_type: 'Company' },
    { node_id: 'a1', node_type: 'Account', properties: { branch: '001' } },
  ];
  graph.edges = [{ edge_id: 'e1', src: 'co', dst: 'a1', relationship_type: 'OWNS' }];
  render(ContextMenuActionsModal, { props: { modelValue: true } });
  await nextTick();
  await fireEvent.click(el('menu-action-add')!);
  await fireEvent.update(el('menu-action-label')!, 'Accounts');
  await fireEvent.update(el('menu-action-kind')!, 'show-table');
}

describe('ContextMenuActionsModal — table from the canvas', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('saves a neighborhood and reopens with it', async () => {
    await canvasForm();
    await fireEvent.update(el('menu-action-hops')!, '2');
    await fireEvent.update(el('menu-action-listed-node-types')!, 'Account, ');
    await fireEvent.click(el('menu-action-save')!);
    const store = useContextMenuActionsStore();
    expect(store.actionConfigs[0]).toMatchObject({
      kind: 'show-table',
      source: { type: 'neighborhood', hops: 2, direction: 'any', list: 'nodes', nodeTypes: ['Account'] },
    });
    expect(document.body.querySelector('.action-label')!.getAttribute('title')).toBe('canvas table · nodes of Account within 2 hops');
    const edit = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Edit')!;
    await fireEvent.click(edit);
    expect((el('menu-action-hops') as HTMLSelectElement).value).toBe('2');
    expect((el('menu-action-listed-node-types') as HTMLInputElement).value).toBe('Account');
  });

  it('a program needs code and valid parameters; Test previews on the selected node', async () => {
    await canvasForm();
    await fireEvent.click(el('menu-action-table-source-program')!);
    expect((el('menu-action-save') as HTMLButtonElement).disabled).toBe(true);
    expect(el('menu-action-canvas-error')!.textContent).toContain('code');
    await fireEvent.update(el('menu-action-program-code')!, 'return neighbors(item.node_id).map(n => ({ id: n.node_id }))');
    await fireEvent.update(el('menu-action-program-params')!, '[oops');
    expect(el('menu-action-canvas-error')!.textContent).toContain('JSON');
    await fireEvent.update(el('menu-action-program-params')!, '[{ "id": "min", "default": "1" }]');
    expect(el('menu-action-canvas-error')).toBeNull();

    // Test runs the neighborhood path synchronously; a program goes to the worker.
    useGraphStore().selectNode('co', false);
    await nextTick();
    expect(el('menu-action-test')!.textContent).toContain('node co');
    await fireEvent.click(el('menu-action-table-source-kind')!.querySelector('input[value="neighborhood"]')!);
    await fireEvent.click(el('menu-action-test')!);
    await waitFor(() => expect(el('menu-action-test-preview')!.textContent).toContain('1 rows'));
    expect(el('menu-action-test-preview')!.textContent).toContain('a1');
  });
});
