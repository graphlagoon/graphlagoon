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

    it('keeps other query params, so ?precomputed= survives', async () => {
      routeQuery.precomputed = 'fraude-2024';
      vi.mocked(api.listStylePresets).mockResolvedValue([entry('investigacao')] as any);
      await renderModal();

      await fireEvent.click(el('style-preset-apply-investigacao')!);

      expect(replace.mock.calls[0][0].query.precomputed).toBe('fraude-2024');
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
      routeQuery.precomputed = 'fraude-2024';
      vi.mocked(api.listStylePresets).mockResolvedValue([entry('investigacao')] as any);
      await renderModal();

      await fireEvent.click(el('style-preset-clear')!);

      expect(replace.mock.calls[0][0].query.style).toBeUndefined();
      expect(replace.mock.calls[0][0].query.precomputed).toBe('fraude-2024');
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

describe('StylePresetModal — export / import', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    replace.mockClear();
    for (const key of Object.keys(routeQuery)) delete routeQuery[key];
    vi.mocked(api.listStylePresets).mockResolvedValue([]);
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  async function readDownloaded(): Promise<any> {
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as unknown as Blob;
    return JSON.parse(await blob.text());
  }

  it('opens the AI helper from the robot button', async () => {
    await renderModal();
    await fireEvent.click(el('style-preset-skill-help')!);
    await nextTick();
    expect(el('style-preset-skill-modal')).not.toBeNull();
    expect(el('style-preset-skill-text')!.textContent).toContain('write a "style preset"');
  });

  it('exports a saved preset wrapped in the portable envelope', async () => {
    vi.mocked(api.listStylePresets).mockResolvedValue([entry('p1')] as any);
    vi.mocked(api.getStylePreset).mockResolvedValue({
      name: 'p1',
      description: 'desc',
      settings: { nodeTypeColors: { Person: '#fff' } },
    } as any);
    const { graphStore } = await renderModal();
    graphStore.currentContext = {
      id: CONTEXT_ID,
      title: 'ctx',
      node_types: ['Person'],
      relationship_types: ['KNOWS'],
      node_properties: [{ name: 'name', data_type: 'string' }],
      edge_properties: [],
    } as any;

    await fireEvent.click(el('style-preset-export-p1')!);
    await flush();

    expect(api.getStylePreset).toHaveBeenCalledWith(CONTEXT_ID, 'p1');
    const payload = await readDownloaded();
    expect(payload.graphlagoon_export).toBe('style-preset');
    expect(payload.name).toBe('p1');
    expect(payload.settings.nodeTypeColors.Person).toBe('#fff');
    expect(payload.source.node_types).toEqual(['Person']);
    expect(payload.source.node_properties).toEqual(['name']);
  });

  it('exports the current look without saving', async () => {
    await renderModal();
    await fireEvent.click(el('style-preset-export-current')!);
    const payload = await readDownloaded();
    expect(payload.graphlagoon_export).toBe('style-preset');
    expect(payload.settings.layout_algorithm).toBeDefined();
    expect(api.putStylePreset).not.toHaveBeenCalled();
  });

  it('applies an imported preset in memory without writing', async () => {
    const { graphStore } = await renderModal();
    await fireEvent.click(el('style-preset-import-toggle')!);
    await nextTick();
    await fireEvent.update(
      el('style-preset-import-text')!,
      JSON.stringify({ nodeTypeColors: { Person: '#123456' }, layout_algorithm: 'grid' }),
    );
    await nextTick();
    await fireEvent.click(el('style-preset-import-apply')!);
    await flush();

    expect(graphStore.nodeTypeColors.get('Person')).toBe('#123456');
    expect(graphStore.layoutAlgorithm).toBe('grid');
    expect(api.putStylePreset).not.toHaveBeenCalled();
  });

  it('warns about types the current graph lacks and offers the AI adapter', async () => {
    const { graphStore } = await renderModal();
    graphStore.currentContext = {
      id: CONTEXT_ID,
      title: 'ctx',
      node_types: ['Customer'],
      relationship_types: [],
      node_properties: [{ name: 'full_name', data_type: 'string' }],
      edge_properties: [],
    } as any;
    await fireEvent.click(el('style-preset-import-toggle')!);
    await nextTick();
    await fireEvent.update(
      el('style-preset-import-text')!,
      JSON.stringify({
        graphlagoon_export: 'style-preset',
        source: { context_title: 'Old', node_types: ['Person'], relationship_types: [], node_properties: ['name'], edge_properties: [] },
        settings: { nodeTypeColors: { Person: '#fff' }, textFormat: { defaults: { nodeTemplate: '{prop:name}', edgeTemplate: '' }, rules: [] } },
      }),
    );
    await nextTick();

    const warnings = el('style-preset-import-warnings')!;
    expect(warnings.textContent).toContain('Person');
    expect(warnings.textContent).toContain('name');

    await fireEvent.click(el('style-preset-import-adapt')!);
    await nextTick();
    const prompt = el('style-preset-skill-text')!.textContent!;
    expect(prompt).toContain('adapt a "style preset"');
    expect(prompt).toContain('"Old"');
    expect(prompt).toContain('- Customer');
  });

  it('shows a parse error for junk', async () => {
    await renderModal();
    await fireEvent.click(el('style-preset-import-toggle')!);
    await nextTick();
    await fireEvent.update(el('style-preset-import-text')!, '{not json');
    await nextTick();
    expect(el('style-preset-import-parse-error')!.textContent).toContain('Not valid JSON');
    expect((el('style-preset-import-apply') as HTMLButtonElement).disabled).toBe(true);
  });

  it('saves an imported preset under a name and applies it', async () => {
    const { graphStore } = await renderModal();
    graphStore.currentContext = { id: CONTEXT_ID, title: 'ctx', has_write_access: true } as any;
    await fireEvent.click(el('style-preset-import-toggle')!);
    await nextTick();
    await fireEvent.update(
      el('style-preset-import-text')!,
      JSON.stringify({ graphlagoon_export: 'style-preset', name: 'vindo', description: 'de fora', settings: { aesthetics: { nodeSize: 12 } } }),
    );
    await nextTick();
    // The envelope's name prefilled the field.
    expect((el('style-preset-import-name') as HTMLInputElement).value).toBe('vindo');
    vi.mocked(api.listStylePresets).mockResolvedValue([entry('vindo')] as any);
    await fireEvent.click(el('style-preset-import-save')!);
    await flush();

    const [, name, body] = vi.mocked(api.putStylePreset).mock.calls[0];
    expect(name).toBe('vindo');
    expect(body.description).toBe('de fora');
    expect(body.settings.aesthetics?.nodeSize).toBe(12);
    expect(replace.mock.calls[0][0].query.style).toBe('vindo');
  });

  it('hides the save form for read-only viewers but keeps Apply only', async () => {
    const { graphStore } = await renderModal();
    graphStore.currentContext = { id: CONTEXT_ID, title: 'ctx', has_write_access: false } as any;
    await fireEvent.click(el('style-preset-import-toggle')!);
    await nextTick();
    expect(el('style-preset-import-save')).toBeNull();
    expect(el('style-preset-import-apply')).not.toBeNull();
  });
});
