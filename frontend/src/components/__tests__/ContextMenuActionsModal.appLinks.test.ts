/**
 * Open-URL actions pointing at an app scheme (vscode://, claude-cli://, …):
 * the editor accepts them, swaps the meaningless new-tab/current-tab choice
 * for a hint, and still blocks in-browser schemes. The modal teleports to body.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/vue';
import { setActivePinia, createPinia } from 'pinia';
import { nextTick } from 'vue';
import ContextMenuActionsModal from '@/components/ContextMenuActionsModal.vue';
import { useGraphStore } from '@/stores/graph';

vi.mock('@/services/api', () => ({
  api: { updateGraphContext: vi.fn().mockResolvedValue({}) },
}));

function el(testid: string) {
  return document.body.querySelector(`[data-testid="${testid}"]`);
}

async function openUrlForm() {
  useGraphStore().currentContext = {
    id: 'ctx-1',
    title: 'Code graph',
    has_write_access: true,
    node_types: ['File'],
    relationship_types: [],
    node_properties: [{ name: 'path', data_type: 'string' }],
    edge_properties: [],
  } as any;
  render(ContextMenuActionsModal, { props: { modelValue: true } });
  await nextTick();
  await fireEvent.click(el('menu-action-add')!);
  await fireEvent.update(el('menu-action-label')!, 'Open in VS Code');
  await fireEvent.update(el('menu-action-kind')!, 'open-url');
}

async function typeUrl(value: string) {
  await fireEvent.update(el('menu-action-url-template')!, value);
}

describe('ContextMenuActionsModal — app links', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('shows the tab choice for web links', async () => {
    await openUrlForm();
    await typeUrl('https://x.com/{prop:path}');
    expect(el('menu-action-open-in')).not.toBeNull();
    expect(el('menu-action-app-link-hint')).toBeNull();
    expect((el('menu-action-save') as HTMLButtonElement).disabled).toBe(false);
  });

  it('replaces the tab choice with an app hint for app schemes, and saves', async () => {
    await openUrlForm();
    await typeUrl('vscode://file/home/me/repo/{prop:path}');
    expect(el('menu-action-open-in')).toBeNull();
    expect(el('menu-action-app-link-hint')!.textContent).toContain('vscode:');
    expect((el('menu-action-save') as HTMLButtonElement).disabled).toBe(false);
  });

  it('blocks saving an in-browser scheme', async () => {
    await openUrlForm();
    await typeUrl('javascript:alert(1)');
    expect(document.body.querySelector('.field-error')!.textContent).toContain('not allowed');
    expect(el('menu-action-app-link-hint')).toBeNull();
    expect((el('menu-action-save') as HTMLButtonElement).disabled).toBe(true);
  });
});
