/**
 * The toolbar's context and exploration names are truncated by CSS, which puts
 * two invariants in the markup rather than in the stylesheet:
 *
 *  - the full name has to survive somewhere (the `title` attribute), otherwise
 *    a truncated name is unrecoverable;
 *  - the name has to sit in its own element, so the ellipsis eats the name and
 *    not the dirty dot next to it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { nextTick } from 'vue';
import Toolbar from '@/components/Toolbar.vue';
import { useGraphStore } from '@/stores/graph';

vi.mock('vue-router', () => ({
  useRoute: () => ({ name: 'graph', params: { contextId: 'ctx-1' } }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  RouterLink: { template: '<a><slot /></a>' },
}));

const LONG_CONTEXT = 'Banking Production Context — customers, accounts and transfers, 2026';
const LONG_EXPLORATION = 'Centrality analysis over the payments subgraph — final revision v4';

function mountToolbar() {
  return mount(Toolbar, {
    global: {
      stubs: {
        RouterLink: { template: '<a><slot /></a>' },
        ExportModal: true,
      },
    },
  });
}

describe('Toolbar — long context / exploration names', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('keeps the full context name in the title attribute', () => {
    const graphStore = useGraphStore();
    graphStore.currentContext = { id: 'ctx-1', title: LONG_CONTEXT } as never;

    const wrapper = mountToolbar();
    const title = wrapper.get('[data-testid="toolbar-context-title"]');

    expect(title.text()).toBe(LONG_CONTEXT);
    expect(title.attributes('title')).toBe(LONG_CONTEXT);
  });

  it('renders the exploration name in its own element so it can ellipsise', () => {
    const graphStore = useGraphStore();
    graphStore.currentContext = { id: 'ctx-1', title: 'Ctx' } as never;
    graphStore.currentExploration = { id: 'exp-1', title: LONG_EXPLORATION } as never;

    const wrapper = mountToolbar();
    const button = wrapper.get('[data-testid="toolbar-exploration-name"]');

    expect(button.get('.exploration-label').text()).toBe(LONG_EXPLORATION);
    expect(button.attributes('title')).toContain(LONG_EXPLORATION);
  });

  it('keeps the dirty dot outside the truncated label', async () => {
    const graphStore = useGraphStore();
    graphStore.currentContext = { id: 'ctx-1', title: 'Ctx' } as never;
    graphStore.currentExploration = { id: 'exp-1', title: LONG_EXPLORATION } as never;
    graphStore.markExplorationSaved();
    // Any change the fingerprint covers makes the open exploration dirty.
    graphStore.graphQuery = 'MATCH (n) RETURN n';
    expect(graphStore.isExplorationDirty).toBe(true);

    const wrapper = mountToolbar();
    await nextTick();

    const dot = wrapper.get('[data-testid="toolbar-exploration-dirty"]');
    // A dot inside the label would be clipped away by the ellipsis on exactly
    // the long names that need the indicator most.
    expect(dot.element.closest('.exploration-label')).toBeNull();
    expect(dot.element.parentElement?.classList.contains('exploration-state')).toBe(true);
  });
});
