/**
 * Style presets, all in one modal opened from the Style panel.
 *
 * It is not a second toolbar panel and not inline in the sidebar: a preset is
 * the Style panel's contents saved under a name — an occasional, deliberate act
 * — so it gets a button there and a modal of its own, leaving the sliders
 * uncluttered.
 *
 * The modal teleports to body, so assertions query document.body rather than the
 * render container.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/vue';
import { setActivePinia, createPinia } from 'pinia';
import { nextTick } from 'vue';
import StylePresetModal from '@/components/StylePresetModal.vue';
import { useGraphStore } from '@/stores/graph';

vi.mock('@/services/api', () => ({
  api: {
    getGraphContext: vi.fn(),
    listStylePresets: vi.fn(),
    getStylePreset: vi.fn(),
    putStylePreset: vi.fn(),
    deleteStylePreset: vi.fn(),
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
      href: `/graph/${to.params.contextId}?style=${to.query.style}`,
    }),
  }),
  useRoute: () => ({ query: routeQuery }),
}));

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await nextTick();
}

function el(testid: string) {
  return document.body.querySelector(`[data-testid="${testid}"]`);
}

function entry(name: string) {
  return { name, size_bytes: 512, modified_at: '2026-08-20T12:00:00Z' };
}

async function renderModal() {
  const graphStore = useGraphStore();
  graphStore.currentContext = { id: CONTEXT_ID, title: 'ctx' } as any;
  const utils = render(StylePresetModal);
  await flush();
  return { ...utils, graphStore };
}

describe('StylePresetModal', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    replace.mockClear();
    for (const key of Object.keys(routeQuery)) delete routeQuery[key];
    vi.mocked(api.listStylePresets).mockResolvedValue([]);
    vi.mocked(api.putStylePreset).mockResolvedValue({
      preset_version: 1,
      name: 'investigacao',
      context_id: CONTEXT_ID,
      created_at: '2026-08-20T12:00:00Z',
      created_by: 'me@example.com',
      settings: {},
    } as any);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders into the body', async () => {
    await renderModal();
    expect(el('style-preset-modal')).not.toBeNull();
  });

  describe('listing', () => {
    it('loads presets on open', async () => {
      await renderModal();
      expect(api.listStylePresets).toHaveBeenCalledWith(CONTEXT_ID);
    });

    it('shows an empty state', async () => {
      await renderModal();
      expect(el('style-preset-empty')).not.toBeNull();
    });

    it('renders each preset', async () => {
      vi.mocked(api.listStylePresets).mockResolvedValue([
        entry('investigacao'),
        entry('apresentacao'),
      ] as any);

      await renderModal();

      expect(el('style-preset-item-investigacao')).not.toBeNull();
      expect(el('style-preset-item-apresentacao')).not.toBeNull();
    });

    it('marks the one the URL is using', async () => {
      routeQuery.style = 'investigacao';
      vi.mocked(api.listStylePresets).mockResolvedValue([entry('investigacao')] as any);

      await renderModal();

      expect(el('style-preset-item-investigacao')!.classList.contains('active')).toBe(true);
    });

    it('reports a listing failure', async () => {
      vi.mocked(api.listStylePresets).mockRejectedValue({
        response: { data: { detail: { error: { message: 'volume unreachable' } } } },
      });

      await renderModal();

      expect(el('style-preset-error')!.textContent).toContain('volume unreachable');
    });

    it('surfaces a preset the URL asked for but could not apply', async () => {
      const { graphStore } = await renderModal();
      graphStore.stylePresetError = 'No style preset named “gone”';
      await nextTick();

      expect(el('style-preset-url-error')!.textContent).toContain('gone');
    });
  });

  describe('saving', () => {
    it('cannot save without a name', async () => {
      await renderModal();
      expect((el('style-preset-save-button') as HTMLButtonElement).disabled).toBe(true);
    });

    it('rejects a name the backend would reject', async () => {
      await renderModal();
      await fireEvent.update(el('style-preset-name-input')!, 'has spaces');
      await nextTick();

      expect((el('style-preset-save-button') as HTMLButtonElement).disabled).toBe(true);
      expect(document.body.textContent).toContain('Letters, digits');
    });

    it('saves the look, not the data', async () => {
      await renderModal();
      await fireEvent.update(el('style-preset-name-input')!, 'investigacao');
      await fireEvent.update(el('style-preset-description-input')!, 'Fraud review look');
      await nextTick();
      await fireEvent.click(el('style-preset-save-button')!);
      await flush();

      const [, name, body] = vi.mocked(api.putStylePreset).mock.calls[0];
      expect(name).toBe('investigacao');
      expect(body.description).toBe('Fraud review look');
      expect(body.settings.layout_algorithm).toBeDefined();
      expect(body.settings).not.toHaveProperty('nodes');
      expect(body.settings).not.toHaveProperty('filters');
    });

    it('re-lists and applies what it saved', async () => {
      await renderModal();
      await fireEvent.update(el('style-preset-name-input')!, 'novo');
      await nextTick();
      vi.mocked(api.listStylePresets).mockResolvedValue([entry('novo')] as any);
      await fireEvent.click(el('style-preset-save-button')!);
      await flush();

      expect(api.listStylePresets).toHaveBeenCalledTimes(2);
      expect(replace.mock.calls[0][0].query.style).toBe('novo');
      expect(el('style-preset-item-novo')).not.toBeNull();
    });

    it('warns that reusing a name overwrites and keeps its author', async () => {
      vi.mocked(api.listStylePresets).mockResolvedValue([entry('investigacao')] as any);
      await renderModal();

      await fireEvent.update(el('style-preset-name-input')!, 'investigacao');
      await nextTick();

      expect(el('style-preset-overwrite')!.textContent).toContain('original author');
    });

    it('reports a write failure and stays open', async () => {
      vi.mocked(api.putStylePreset).mockRejectedValue({
        response: {
          data: {
            detail: { error: { message: 'You need write access to this context' } },
          },
        },
      });

      await renderModal();
      await fireEvent.update(el('style-preset-name-input')!, 'p1');
      await nextTick();
      await fireEvent.click(el('style-preset-save-button')!);
      await flush();

      expect(el('style-preset-error')!.textContent).toContain('write access');
      expect(el('style-preset-modal')).not.toBeNull();
    });
  });

  describe('applying', () => {
    it('goes through the URL, so the look stays shareable', async () => {
      vi.mocked(api.listStylePresets).mockResolvedValue([entry('investigacao')] as any);
      await renderModal();

      await fireEvent.click(el('style-preset-apply-investigacao')!);

      expect(replace).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'graph',
          query: expect.objectContaining({ style: 'investigacao' }),
        }),
      );
    });

    it('keeps other query params, so ?graph= survives', async () => {
      routeQuery.graph = 'fraude-2024';
      vi.mocked(api.listStylePresets).mockResolvedValue([entry('investigacao')] as any);
      await renderModal();

      await fireEvent.click(el('style-preset-apply-investigacao')!);

      expect(replace.mock.calls[0][0].query.graph).toBe('fraude-2024');
    });

    it('does nothing when already applied', async () => {
      routeQuery.style = 'investigacao';
      vi.mocked(api.listStylePresets).mockResolvedValue([entry('investigacao')] as any);
      await renderModal();

      await fireEvent.click(el('style-preset-apply-investigacao')!);

      expect(replace).not.toHaveBeenCalled();
    });

    it('offers to stop using the active one, dropping only that param', async () => {
      routeQuery.style = 'investigacao';
      routeQuery.graph = 'fraude-2024';
      vi.mocked(api.listStylePresets).mockResolvedValue([entry('investigacao')] as any);
      await renderModal();

      await fireEvent.click(el('style-preset-clear')!);

      expect(replace.mock.calls[0][0].query.style).toBeUndefined();
      expect(replace.mock.calls[0][0].query.graph).toBe('fraude-2024');
    });
  });

  describe('deleting', () => {
    it('asks first, then removes the row', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      vi.mocked(api.listStylePresets).mockResolvedValue([entry('p1')] as any);
      vi.mocked(api.deleteStylePreset).mockResolvedValue(undefined as any);

      await renderModal();
      await fireEvent.click(el('style-preset-delete-p1')!);
      await flush();

      expect(api.deleteStylePreset).toHaveBeenCalledWith(CONTEXT_ID, 'p1');
      expect(el('style-preset-item-p1')).toBeNull();
      confirmSpy.mockRestore();
    });

    it('does nothing when declined', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
      vi.mocked(api.listStylePresets).mockResolvedValue([entry('p1')] as any);

      await renderModal();
      await fireEvent.click(el('style-preset-delete-p1')!);
      await flush();

      expect(api.deleteStylePreset).not.toHaveBeenCalled();
      confirmSpy.mockRestore();
    });

    it("shows the server's message when it is not yours to delete", async () => {
      // The listing carries no owner, so this 403 is the only place the author
      // is ever named.
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      vi.mocked(api.listStylePresets).mockResolvedValue([entry('p1')] as any);
      vi.mocked(api.deleteStylePreset).mockRejectedValue({
        response: {
          data: {
            detail: {
              error: {
                message:
                  "Style preset 'p1' was created by alice@example.com. Only its creator can delete it.",
              },
            },
          },
        },
      });

      await renderModal();
      await fireEvent.click(el('style-preset-delete-p1')!);
      await flush();

      expect(el('style-preset-error')!.textContent).toContain('alice@example.com');
      expect(el('style-preset-item-p1')).not.toBeNull();
      confirmSpy.mockRestore();
    });
  });

  it('closes on the close button', async () => {
    const { emitted } = await renderModal();
    await fireEvent.click(document.body.querySelector('.modal-close')!);
    expect(emitted().close).toBeTruthy();
  });
});
