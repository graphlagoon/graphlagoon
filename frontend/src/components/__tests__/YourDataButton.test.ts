import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import YourDataButton from '@/components/YourDataButton.vue';
import { useGraphStore } from '@/stores/graph';

const mountButton = () => mount(YourDataButton, { global: { stubs: { YourDataModal: true } } });

describe('YourDataButton (BYOD-2)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.__GRAPH_LAGOON_CONFIG__ = {} as never;
  });

  it('shows on a graph the person can write and hides without the permission', () => {
    useGraphStore().currentContext = { id: 'ctx-1', title: 'Ctx' } as never;
    expect(mountButton().find('[data-testid="toolbar-your-data"]').exists()).toBe(true);
    window.__GRAPH_LAGOON_CONFIG__ = { permissions: ['exploration.save'] } as never;
    expect(mountButton().find('[data-testid="toolbar-your-data"]').exists()).toBe(false);
  });

  it('hides on an exploration shared read-only, and on a case canvas', () => {
    const graphStore = useGraphStore();
    graphStore.currentContext = { id: 'ctx-1', title: 'Ctx' } as never;
    graphStore.currentExploration = { id: 'exp-1', title: 'Shared', has_write_access: false, state: {} } as never;
    expect(mountButton().find('[data-testid="toolbar-your-data"]').exists()).toBe(false);
    graphStore.loadInvestigationGraph({ rings: new Map() } as never, [], []);
    expect(mountButton().find('[data-testid="toolbar-your-data"]').exists()).toBe(false);
  });

  it('opens the dialog', async () => {
    useGraphStore().currentContext = { id: 'ctx-1', title: 'Ctx' } as never;
    const wrapper = mountButton();
    await wrapper.get('[data-testid="toolbar-your-data"]').trigger('click');
    expect(wrapper.findComponent({ name: 'YourDataModal' }).exists()).toBe(true);
  });
});
