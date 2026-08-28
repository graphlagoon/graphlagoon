/**
 * Export / import of context-menu actions as a portable JSON envelope, and the
 * robot button switching to "adapt" mode when the Import box holds actions
 * from another graph. The modal teleports to body.
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
  api: { updateGraphContext: vi.fn().mockResolvedValue({}) },
}));

function el(testid: string) {
  return document.body.querySelector(`[data-testid="${testid}"]`);
}

async function flush() {
  for (let i = 0; i < 4; i++) await Promise.resolve();
  await nextTick();
}

const ACTION = {
  id: 'a1',
  label: 'Search',
  enabled: true,
  kind: 'open-url' as const,
  openIn: 'new-tab' as const,
  match: { target: 'node' as const, nodeTypes: ['Person'] },
  urlTemplate: 'https://x.com/?q={prop:email}',
};

async function renderModal(hasWrite = true) {
  const graphStore = useGraphStore();
  graphStore.currentContext = {
    id: 'ctx-1',
    title: 'Fraud ring',
    has_write_access: hasWrite,
    node_types: ['Customer'],
    relationship_types: ['PAID'],
    node_properties: [{ name: 'full_name', data_type: 'string' }],
    edge_properties: [],
  } as any;
  useQueryTemplatesStore().templates = [
    { id: 't-new', name: 'Neighbors', parameters: [{ id: 'p', label: 'P', required: true }] } as any,
  ];
  const utils = render(ContextMenuActionsModal, { props: { modelValue: true } });
  await flush();
  return { ...utils, graphStore, store: useContextMenuActionsStore() };
}

describe('ContextMenuActionsModal — export / import', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('exports every action inside the portable envelope with the source schema', async () => {
    const { store } = await renderModal();
    store.hydrateFromContext([ACTION]);
    await nextTick();

    await fireEvent.click(el('menu-action-export')!);
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as unknown as Blob;
    const payload = JSON.parse(await blob.text());

    expect(payload.graphlagoon_export).toBe('context-menu-actions');
    expect(payload.actions).toHaveLength(1);
    expect(payload.actions[0].label).toBe('Search');
    expect(payload.source.context_title).toBe('Fraud ring');
    expect(payload.source.node_types).toEqual(['Customer']);
    expect(payload.source.query_templates).toEqual([{ id: 't-new', name: 'Neighbors', parameters: ['p'] }]);
  });

  it('disables export with nothing to export and keeps it for read-only viewers', async () => {
    await renderModal(false);
    expect((el('menu-action-export') as HTMLButtonElement).disabled).toBe(true);
    expect(el('menu-action-import-toggle')).toBeNull();
  });

  it('imports an envelope, warns about foreign names and adapts via the robot', async () => {
    const { store } = await renderModal();
    await fireEvent.click(el('menu-action-import-toggle')!);
    await nextTick();
    await fireEvent.update(
      el('menu-action-import-text')!,
      JSON.stringify({
        graphlagoon_export: 'context-menu-actions',
        source: { context_title: 'Old graph', node_types: ['Person'], relationship_types: [], node_properties: ['email'], edge_properties: [] },
        actions: [
          ACTION,
          { kind: 'run-query-template', label: 'Run', match: { target: 'node' }, templateId: 't-old', paramBindings: {} },
        ],
      }),
    );
    await nextTick();

    const warnings = el('menu-action-import-warnings')!.textContent!;
    expect(warnings).toContain('Person');
    expect(warnings).toContain('email');
    expect(warnings).toContain('t-old');

    await fireEvent.click(el('menu-action-import-adapt')!);
    await nextTick();
    const prompt = el('menu-action-skill-text')!.textContent!;
    expect(prompt).toContain('adapt "context-menu actions"');
    expect(prompt).toContain('"Old graph"');
    expect(prompt).toContain('- Customer');
    expect(prompt).toContain('t-new');

    await fireEvent.click(el('menu-action-import-apply')!);
    await nextTick();
    expect(store.actionConfigs.map((a) => a.label)).toEqual(['Search', 'Run']);
  });

  it('shows a parse error and blocks the import button on junk', async () => {
    await renderModal();
    await fireEvent.click(el('menu-action-import-toggle')!);
    await nextTick();
    await fireEvent.update(el('menu-action-import-text')!, '[oops');
    await nextTick();
    expect(el('menu-action-import-parse-error')!.textContent).toContain('Not valid JSON');
    expect((el('menu-action-import-apply') as HTMLButtonElement).disabled).toBe(true);
  });
});
