/**
 * The graph cache panel.
 *
 * Two fields, no list: save the current graph under a name, delete a cache by
 * name. There is no listing endpoint behind this on purpose — enumerating
 * entries is O(entries) and stops working as the store grows, while every real
 * use of a cache already knows the name it wants.
 *
 * Both fields are superuser-only, matching the backend, which answers 403 for
 * those two verbs to anyone else — a graph cache is a published, administered
 * artifact, unlike a style preset, which anyone with context write access can
 * save. Reading a cache needs no panel at all: it is a URL.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/vue';
import { setActivePinia, createPinia } from 'pinia';
import { nextTick } from 'vue';
import GraphCachePanel from '@/components/GraphCachePanel.vue';
import { useGraphStore } from '@/stores/graph';

vi.mock('@/services/api', () => ({
  api: {
    getGraphContext: vi.fn(),
    getGraphCache: vi.fn(),
    putGraphCache: vi.fn(),
    deleteGraphCache: vi.fn(),
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
      href: `/graph/${to.params.contextId}?graph=${to.query.graph}`,
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
  const utils = render(GraphCachePanel);
  await flush();
  return { ...utils, graphStore };
}

async function typeAndSave(container: Element, name: string) {
  await fireEvent.update(
    container.querySelector('[data-testid="graph-cache-name-input"]')!,
    name,
  );
  await nextTick();
  await fireEvent.click(
    container.querySelector('[data-testid="graph-cache-save-button"]')!,
  );
  await flush();
}

describe('GraphCachePanel', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    replace.mockClear();
    for (const key of Object.keys(routeQuery)) delete routeQuery[key];
    setSuperuser(true);
    vi.mocked(api.putGraphCache).mockResolvedValue({
      name: 'c1',
      size_bytes: 512,
      modified_at: '2026-08-20T12:00:00Z',
    } as any);
    vi.mocked(api.deleteGraphCache).mockResolvedValue(undefined as any);
  });

  afterEach(() => {
    delete (window as any).__GRAPH_LAGOON_CONFIG__;
  });

  describe('no listing', () => {
    it('never asks the server what caches exist', async () => {
      const { container } = await renderPanel({ nodes: 2 });
      // The panel mounts, saves and deletes without a single enumeration —
      // there is no endpoint to call.
      expect(api).not.toHaveProperty('listGraphCaches');
      expect(container.querySelector('[data-testid="graph-cache-list"]')).toBeNull();
    });

    it('shows nothing saved before the first save', async () => {
      const { container } = await renderPanel({ nodes: 2 });
      expect(
        container.querySelector('[data-testid="graph-cache-last-saved"]'),
      ).toBeNull();
    });
  });

  describe('superuser gating', () => {
    it('offers both fields to a superuser', async () => {
      const { container } = await renderPanel();
      expect(container.querySelector('[data-testid="graph-cache-save"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="graph-cache-delete"]')).not.toBeNull();
    });

    it('hides both fields for anyone else and says how to open one', async () => {
      setSuperuser(false);
      const { container } = await renderPanel();
      expect(container.querySelector('[data-testid="graph-cache-save"]')).toBeNull();
      expect(container.querySelector('[data-testid="graph-cache-delete"]')).toBeNull();
      expect(
        container.querySelector('[data-testid="graph-cache-readonly"]'),
      ).not.toBeNull();
    });
  });

  describe('saving', () => {
    it('is disabled until a name is entered', async () => {
      const { container } = await renderPanel({ nodes: 2 });
      const button = container.querySelector(
        '[data-testid="graph-cache-save-button"]',
      ) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    });

    it('rejects a name the backend would reject', async () => {
      const { container } = await renderPanel({ nodes: 2 });
      await fireEvent.update(
        container.querySelector('[data-testid="graph-cache-name-input"]')!,
        'has spaces',
      );
      await nextTick();

      const button = container.querySelector(
        '[data-testid="graph-cache-save-button"]',
      ) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(container.textContent).toContain('Letters, digits');
    });

    it('writes a valid name', async () => {
      const { container } = await renderPanel({ nodes: 2 });
      await typeAndSave(container, 'fraude-2024');

      expect(api.putGraphCache).toHaveBeenCalled();
      expect(vi.mocked(api.putGraphCache).mock.calls[0][1]).toBe('fraude-2024');
    });

    it('surfaces the link right after saving, since nothing lists it later', async () => {
      const { container } = await renderPanel({ nodes: 2 });
      await typeAndSave(container, 'fraude-2024');

      const saved = container.querySelector('[data-testid="graph-cache-last-saved"]');
      expect(saved).not.toBeNull();
      expect(saved!.textContent).toContain('fraude-2024');
      expect(saved!.textContent).toContain('?graph=fraude-2024');
    });

    it('clears the input so the next save starts clean', async () => {
      const { container } = await renderPanel({ nodes: 2 });
      await typeAndSave(container, 'c1');

      const input = container.querySelector(
        '[data-testid="graph-cache-name-input"]',
      ) as HTMLInputElement;
      expect(input.value).toBe('');
    });

    it('blocks while node properties are still loading', async () => {
      const { container, graphStore } = await renderPanel({ nodes: 2 });
      graphStore.pendingPropertyNodeIds.add('n0');
      await fireEvent.update(
        container.querySelector('[data-testid="graph-cache-name-input"]')!,
        'c1',
      );
      await nextTick();

      const button = container.querySelector(
        '[data-testid="graph-cache-save-button"]',
      ) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(container.textContent).toContain('still loading');
    });

    it('blocks on an empty graph', async () => {
      const { container } = await renderPanel();
      await fireEvent.update(
        container.querySelector('[data-testid="graph-cache-name-input"]')!,
        'c1',
      );
      await nextTick();

      expect(
        (container.querySelector(
          '[data-testid="graph-cache-save-button"]',
        ) as HTMLButtonElement).disabled,
      ).toBe(true);
    });

    it('reports a write failure', async () => {
      vi.mocked(api.putGraphCache).mockRejectedValue({
        response: { data: { detail: { error: { message: 'dev mode only' } } } },
      });

      const { container } = await renderPanel({ nodes: 2 });
      await typeAndSave(container, 'c1');

      expect(container.querySelector('[data-testid="graph-cache-error"]')?.textContent)
        .toContain('dev mode only');
    });
  });

  describe('deleting by name', () => {
    it('is disabled until a name is entered', async () => {
      const { container } = await renderPanel();
      expect(
        (container.querySelector(
          '[data-testid="graph-cache-delete-button"]',
        ) as HTMLButtonElement).disabled,
      ).toBe(true);
    });

    it('rejects an invalid name without calling the API', async () => {
      const { container } = await renderPanel();
      await fireEvent.update(
        container.querySelector('[data-testid="graph-cache-delete-input"]')!,
        'has spaces',
      );
      await nextTick();

      expect(
        (container.querySelector(
          '[data-testid="graph-cache-delete-button"]',
        ) as HTMLButtonElement).disabled,
      ).toBe(true);
      expect(api.deleteGraphCache).not.toHaveBeenCalled();
    });

    it('asks first, then deletes the named entry', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const { container } = await renderPanel();

      await fireEvent.update(
        container.querySelector('[data-testid="graph-cache-delete-input"]')!,
        'descartavel',
      );
      await nextTick();
      await fireEvent.click(
        container.querySelector('[data-testid="graph-cache-delete-button"]')!,
      );
      await flush();

      expect(api.deleteGraphCache).toHaveBeenCalledWith(CONTEXT_ID, 'descartavel');
      confirmSpy.mockRestore();
    });

    it('does nothing when the confirmation is declined', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
      const { container } = await renderPanel();

      await fireEvent.update(
        container.querySelector('[data-testid="graph-cache-delete-input"]')!,
        'c1',
      );
      await nextTick();
      await fireEvent.click(
        container.querySelector('[data-testid="graph-cache-delete-button"]')!,
      );
      await flush();

      expect(api.deleteGraphCache).not.toHaveBeenCalled();
      confirmSpy.mockRestore();
    });

    it('drops the saved link when it names the entry just deleted', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const { container } = await renderPanel({ nodes: 2 });
      await typeAndSave(container, 'c1');
      expect(
        container.querySelector('[data-testid="graph-cache-last-saved"]'),
      ).not.toBeNull();

      await fireEvent.update(
        container.querySelector('[data-testid="graph-cache-delete-input"]')!,
        'c1',
      );
      await nextTick();
      await fireEvent.click(
        container.querySelector('[data-testid="graph-cache-delete-button"]')!,
      );
      await flush();

      expect(container.querySelector('[data-testid="graph-cache-last-saved"]')).toBeNull();
      confirmSpy.mockRestore();
    });

    it('reports a delete failure', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      vi.mocked(api.deleteGraphCache).mockRejectedValue({
        response: { data: { detail: { error: { message: 'only the owner' } } } },
      });

      const { container } = await renderPanel();
      await fireEvent.update(
        container.querySelector('[data-testid="graph-cache-delete-input"]')!,
        'c1',
      );
      await nextTick();
      await fireEvent.click(
        container.querySelector('[data-testid="graph-cache-delete-button"]')!,
      );
      await flush();

      expect(
        container.querySelector('[data-testid="graph-cache-delete-error"]')?.textContent,
      ).toContain('only the owner');
      confirmSpy.mockRestore();
    });
  });

  describe('opening what was just saved', () => {
    it('navigates by query param', async () => {
      const { container } = await renderPanel({ nodes: 2 });
      await typeAndSave(container, 'c1');

      await fireEvent.click(
        container.querySelector('[data-testid="graph-cache-open-last"]')!,
      );

      expect(replace).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'graph',
          params: { contextId: CONTEXT_ID },
          query: expect.objectContaining({ graph: 'c1' }),
        }),
      );
    });

    it('drops any exploration param — the two are mutually exclusive', async () => {
      routeQuery.exploration = 'exp-1';
      const { container } = await renderPanel({ nodes: 2 });
      await typeAndSave(container, 'c1');

      await fireEvent.click(
        container.querySelector('[data-testid="graph-cache-open-last"]')!,
      );

      expect(replace.mock.calls[0][0].query.exploration).toBeUndefined();
    });
  });

  it('names the cache currently on screen', async () => {
    routeQuery.graph = 'fraude-2024';
    const { container } = await renderPanel();
    expect(
      container.querySelector('[data-testid="graph-cache-viewing"]')?.textContent,
    ).toContain('fraude-2024');
  });

  it('closes on the close button', async () => {
    const { emitted, container } = await renderPanel();
    await fireEvent.click(container.querySelector('.close-btn')!);
    expect(emitted().close).toBeTruthy();
  });
});
