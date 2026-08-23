/**
 * The precomputed graph panel.
 *
 * Two fields, no list: publish the current graph under a name, delete one by
 * name. There is no listing endpoint behind this on purpose — enumerating
 * entries is O(entries) and stops working as the store grows, while every real
 * use of a link already knows the name it wants.
 *
 * Both fields need superuser status *and* a provider that can be written to.
 * The server folds the two into `can_write`, so these tests drive the panel
 * through the capabilities endpoint rather than through the superuser flag
 * alone — a superuser looking at a Lakebase-backed context has nowhere to
 * publish, and the panel must say so instead of offering a button that 405s.
 *
 * Reading needs no panel at all: it is a URL.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/vue';
import { setActivePinia, createPinia } from 'pinia';
import { nextTick } from 'vue';
import PrecomputedGraphPanel from '@/components/PrecomputedGraphPanel.vue';
import { useGraphStore } from '@/stores/graph';

vi.mock('@/services/api', () => ({
  api: {
    getGraphContext: vi.fn(),
    getPrecomputedGraph: vi.fn(),
    putPrecomputedGraph: vi.fn(),
    deletePrecomputedGraph: vi.fn(),
    getPrecomputedGraphCapabilities: vi.fn(),
  },
}));

import { api } from '@/services/api';

const CONTEXT_ID = 'ctx-1';
const replace = vi.fn();
const routeQuery: Record<string, unknown> = {};

vi.mock('vue-router', () => ({
  useRouter: () => ({
    replace,
    resolve: (to: any) => ({
      href: `/graph/${to.params.contextId}?precomputed=${to.query.precomputed}`,
    }),
  }),
  useRoute: () => ({ query: routeQuery }),
}));

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await nextTick();
}

function setSuperuser(enabled: boolean) {
  window.__GRAPH_LAGOON_CONFIG__ = { is_superuser: enabled } as any;
}

/** What the server would answer for this context. */
function setCapabilities(
  overrides: { can_write?: boolean; can_delete?: boolean } = {},
) {
  vi.mocked(api.getPrecomputedGraphCapabilities).mockResolvedValue({
    enabled: true,
    can_write: overrides.can_write ?? true,
    can_delete: overrides.can_delete ?? overrides.can_write ?? true,
    providers: [],
  } as any);
}

async function renderPanel(options: { nodes?: number } = {}) {
  const graphStore = useGraphStore();
  graphStore.currentContext = { id: CONTEXT_ID, title: 'ctx' } as any;
  if (options.nodes) {
    graphStore.nodes = Array.from({ length: options.nodes }, (_, i) => ({
      node_id: `n${i}`,
      node_type: 'Account',
      properties: {},
    })) as any;
  }
  const utils = render(PrecomputedGraphPanel);
  await flush();
  return { ...utils, graphStore };
}

async function typeAndSave(container: Element, name: string) {
  await fireEvent.update(
    container.querySelector('[data-testid="precomputed-graph-name-input"]')!,
    name,
  );
  await nextTick();
  await fireEvent.click(
    container.querySelector('[data-testid="precomputed-graph-save-button"]')!,
  );
  await flush();
}

describe('PrecomputedGraphPanel', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    replace.mockClear();
    for (const key of Object.keys(routeQuery)) delete routeQuery[key];
    setSuperuser(true);
    setCapabilities();
    vi.mocked(api.putPrecomputedGraph).mockResolvedValue({
      name: 'c1',
      size_bytes: 512,
      modified_at: '2026-08-20T12:00:00Z',
    } as any);
    vi.mocked(api.deletePrecomputedGraph).mockResolvedValue(undefined as any);
  });

  afterEach(() => {
    delete (window as any).__GRAPH_LAGOON_CONFIG__;
  });

  describe('no listing', () => {
    it('never asks the server what graphs exist', async () => {
      const { container } = await renderPanel({ nodes: 2 });
      // The panel mounts, publishes and deletes without a single enumeration —
      // there is no endpoint to call. It does ask what it may *do*, which is a
      // fixed-size answer.
      expect(api).not.toHaveProperty('listPrecomputedGraphs');
      expect(
        container.querySelector('[data-testid="precomputed-graph-list"]'),
      ).toBeNull();
    });

    it('shows nothing saved before the first save', async () => {
      const { container } = await renderPanel({ nodes: 2 });
      expect(
        container.querySelector('[data-testid="precomputed-graph-last-saved"]'),
      ).toBeNull();
    });
  });

  describe('capability gating', () => {
    it('offers both fields when the server says the context is writable', async () => {
      const { container } = await renderPanel();
      expect(container.querySelector('[data-testid="precomputed-graph-save"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="precomputed-graph-delete"]')).not.toBeNull();
    });

    it('hides both fields for a non-superuser and says how to open one', async () => {
      // The server folds superuser status into can_write, so a non-superuser
      // gets the same false the panel would get for a read-only provider.
      setSuperuser(false);
      setCapabilities({ can_write: false });
      const { container } = await renderPanel();
      expect(container.querySelector('[data-testid="precomputed-graph-save"]')).toBeNull();
      expect(container.querySelector('[data-testid="precomputed-graph-delete"]')).toBeNull();
      expect(
        container.querySelector('[data-testid="precomputed-graph-readonly"]'),
      ).not.toBeNull();
    });

    it('hides publishing from a superuser when no provider can be written to', async () => {
      // A Lakebase-backed context: the graph is computed on demand, so there is
      // nowhere to publish to. Offering the button would be a guaranteed 405.
      setSuperuser(true);
      setCapabilities({ can_write: false });
      const { container } = await renderPanel({ nodes: 2 });

      expect(container.querySelector('[data-testid="precomputed-graph-save"]')).toBeNull();
      const hint = container.querySelector(
        '[data-testid="precomputed-graph-readonly"]',
      );
      expect(hint).not.toBeNull();
      expect(hint!.textContent).toContain('produced outside');
    });

    it('offers publishing but not deleting when only save is supported', async () => {
      setCapabilities({ can_write: true, can_delete: false });
      const { container } = await renderPanel({ nodes: 2 });

      expect(container.querySelector('[data-testid="precomputed-graph-save"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="precomputed-graph-delete"]')).toBeNull();
    });

    it('stays read-only when the capabilities call fails', async () => {
      // Unable to confirm it may write, the panel shows the hint rather than a
      // button that would fail on click.
      vi.mocked(api.getPrecomputedGraphCapabilities).mockRejectedValue(
        new Error('network'),
      );
      const { container } = await renderPanel({ nodes: 2 });

      expect(container.querySelector('[data-testid="precomputed-graph-save"]')).toBeNull();
      expect(
        container.querySelector('[data-testid="precomputed-graph-readonly"]'),
      ).not.toBeNull();
    });
  });

  describe('saving', () => {
    it('is disabled until a name is entered', async () => {
      const { container } = await renderPanel({ nodes: 2 });
      const button = container.querySelector(
        '[data-testid="precomputed-graph-save-button"]',
      ) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    });

    it('rejects a name the backend would reject', async () => {
      const { container } = await renderPanel({ nodes: 2 });
      await fireEvent.update(
        container.querySelector('[data-testid="precomputed-graph-name-input"]')!,
        'has spaces',
      );
      await nextTick();

      const button = container.querySelector(
        '[data-testid="precomputed-graph-save-button"]',
      ) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(container.textContent).toContain('Letters, digits');
    });

    it('writes a valid name', async () => {
      const { container } = await renderPanel({ nodes: 2 });
      await typeAndSave(container, 'fraude-2024');

      expect(api.putPrecomputedGraph).toHaveBeenCalled();
      expect(vi.mocked(api.putPrecomputedGraph).mock.calls[0][1]).toBe('fraude-2024');
    });

    it('surfaces the link right after saving, since nothing lists it later', async () => {
      const { container } = await renderPanel({ nodes: 2 });
      await typeAndSave(container, 'fraude-2024');

      const saved = container.querySelector('[data-testid="precomputed-graph-last-saved"]');
      expect(saved).not.toBeNull();
      expect(saved!.textContent).toContain('fraude-2024');
      expect(saved!.textContent).toContain('?precomputed=fraude-2024');
    });

    it('clears the input so the next save starts clean', async () => {
      const { container } = await renderPanel({ nodes: 2 });
      await typeAndSave(container, 'c1');

      const input = container.querySelector(
        '[data-testid="precomputed-graph-name-input"]',
      ) as HTMLInputElement;
      expect(input.value).toBe('');
    });

    it('blocks while node properties are still loading', async () => {
      const { container, graphStore } = await renderPanel({ nodes: 2 });
      graphStore.pendingPropertyNodeIds.add('n0');
      await fireEvent.update(
        container.querySelector('[data-testid="precomputed-graph-name-input"]')!,
        'c1',
      );
      await nextTick();

      const button = container.querySelector(
        '[data-testid="precomputed-graph-save-button"]',
      ) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(container.textContent).toContain('still loading');
    });

    it('blocks on an empty graph', async () => {
      const { container } = await renderPanel();
      await fireEvent.update(
        container.querySelector('[data-testid="precomputed-graph-name-input"]')!,
        'c1',
      );
      await nextTick();

      expect(
        (container.querySelector(
          '[data-testid="precomputed-graph-save-button"]',
        ) as HTMLButtonElement).disabled,
      ).toBe(true);
    });

    it('reports a write failure', async () => {
      vi.mocked(api.putPrecomputedGraph).mockRejectedValue({
        response: { data: { detail: { error: { message: 'dev mode only' } } } },
      });

      const { container } = await renderPanel({ nodes: 2 });
      await typeAndSave(container, 'c1');

      expect(container.querySelector('[data-testid="precomputed-graph-error"]')?.textContent)
        .toContain('dev mode only');
    });
  });

  describe('deleting by name', () => {
    it('is disabled until a name is entered', async () => {
      const { container } = await renderPanel();
      expect(
        (container.querySelector(
          '[data-testid="precomputed-graph-delete-button"]',
        ) as HTMLButtonElement).disabled,
      ).toBe(true);
    });

    it('rejects an invalid name without calling the API', async () => {
      const { container } = await renderPanel();
      await fireEvent.update(
        container.querySelector('[data-testid="precomputed-graph-delete-input"]')!,
        'has spaces',
      );
      await nextTick();

      expect(
        (container.querySelector(
          '[data-testid="precomputed-graph-delete-button"]',
        ) as HTMLButtonElement).disabled,
      ).toBe(true);
      expect(api.deletePrecomputedGraph).not.toHaveBeenCalled();
    });

    it('asks first, then deletes the named entry', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const { container } = await renderPanel();

      await fireEvent.update(
        container.querySelector('[data-testid="precomputed-graph-delete-input"]')!,
        'descartavel',
      );
      await nextTick();
      await fireEvent.click(
        container.querySelector('[data-testid="precomputed-graph-delete-button"]')!,
      );
      await flush();

      expect(api.deletePrecomputedGraph).toHaveBeenCalledWith(CONTEXT_ID, 'descartavel');
      confirmSpy.mockRestore();
    });

    it('does nothing when the confirmation is declined', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
      const { container } = await renderPanel();

      await fireEvent.update(
        container.querySelector('[data-testid="precomputed-graph-delete-input"]')!,
        'c1',
      );
      await nextTick();
      await fireEvent.click(
        container.querySelector('[data-testid="precomputed-graph-delete-button"]')!,
      );
      await flush();

      expect(api.deletePrecomputedGraph).not.toHaveBeenCalled();
      confirmSpy.mockRestore();
    });

    it('drops the saved link when it names the entry just deleted', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const { container } = await renderPanel({ nodes: 2 });
      await typeAndSave(container, 'c1');
      expect(
        container.querySelector('[data-testid="precomputed-graph-last-saved"]'),
      ).not.toBeNull();

      await fireEvent.update(
        container.querySelector('[data-testid="precomputed-graph-delete-input"]')!,
        'c1',
      );
      await nextTick();
      await fireEvent.click(
        container.querySelector('[data-testid="precomputed-graph-delete-button"]')!,
      );
      await flush();

      expect(container.querySelector('[data-testid="precomputed-graph-last-saved"]')).toBeNull();
      confirmSpy.mockRestore();
    });

    it('reports a delete failure', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      vi.mocked(api.deletePrecomputedGraph).mockRejectedValue({
        response: { data: { detail: { error: { message: 'only the owner' } } } },
      });

      const { container } = await renderPanel();
      await fireEvent.update(
        container.querySelector('[data-testid="precomputed-graph-delete-input"]')!,
        'c1',
      );
      await nextTick();
      await fireEvent.click(
        container.querySelector('[data-testid="precomputed-graph-delete-button"]')!,
      );
      await flush();

      expect(
        container.querySelector('[data-testid="precomputed-graph-delete-error"]')?.textContent,
      ).toContain('only the owner');
      confirmSpy.mockRestore();
    });
  });

  describe('opening what was just saved', () => {
    it('navigates by query param', async () => {
      const { container } = await renderPanel({ nodes: 2 });
      await typeAndSave(container, 'c1');

      await fireEvent.click(
        container.querySelector('[data-testid="precomputed-graph-open-last"]')!,
      );

      expect(replace).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'graph',
          params: { contextId: CONTEXT_ID },
          query: expect.objectContaining({ precomputed: 'c1' }),
        }),
      );
    });

    it('drops any exploration param — the two are mutually exclusive', async () => {
      routeQuery.exploration = 'exp-1';
      const { container } = await renderPanel({ nodes: 2 });
      await typeAndSave(container, 'c1');

      await fireEvent.click(
        container.querySelector('[data-testid="precomputed-graph-open-last"]')!,
      );

      expect(replace.mock.calls[0][0].query.exploration).toBeUndefined();
    });

    it("drops the previous graph's provider arguments", async () => {
      // They were declared by whatever provider served the last name, and the
      // new name's provider probably has not heard of them — carrying them over
      // would turn "open what I just published" into an immediate 400.
      routeQuery.seed = '99872';
      routeQuery.hops = '3';
      const { container } = await renderPanel({ nodes: 2 });
      await typeAndSave(container, 'c1');

      await fireEvent.click(
        container.querySelector('[data-testid="precomputed-graph-open-last"]')!,
      );

      const query = replace.mock.calls[0][0].query;
      expect(query.seed).toBeUndefined();
      expect(query.hops).toBeUndefined();
      expect(query.precomputed).toBe('c1');
    });

    it('carries ?style= over, because a style applies to any graph', async () => {
      routeQuery.style = 'investigacao';
      const { container } = await renderPanel({ nodes: 2 });
      await typeAndSave(container, 'c1');

      await fireEvent.click(
        container.querySelector('[data-testid="precomputed-graph-open-last"]')!,
      );

      expect(replace.mock.calls[0][0].query.style).toBe('investigacao');
    });
  });

  it('names the precomputed graph currently on screen', async () => {
    routeQuery.precomputed = 'fraude-2024';
    const { container } = await renderPanel();
    expect(
      container.querySelector('[data-testid="precomputed-graph-viewing"]')?.textContent,
    ).toContain('fraude-2024');
  });

  it('closes on the close button', async () => {
    const { emitted, container } = await renderPanel();
    await fireEvent.click(container.querySelector('.close-btn')!);
    expect(emitted().close).toBeTruthy();
  });
});
