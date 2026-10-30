import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { ViewportState } from '@/types/graph';

export interface ExportPNGOptions {
  scale: number;
  background: 'white' | 'transparent';
}

/** The tabs of the Look panel (style, labels, behaviors and presets in one place). */
export type LookTab = 'style' | 'labels' | 'behaviors' | 'presets';

export interface ToolbarHandlers {
  onToggleFilters: () => void;
  onToggleQuery: () => void;
  onToggleMetrics: () => void;
  /** Toggle the Look panel; with a tab, open it on that tab (never close). */
  onToggleLook: (tab?: LookTab) => void;
  onToggleClusterPrograms: () => void;
  onToggleTemplates: () => void;
  onTogglePrecomputed: () => void;
  onExportPNG: (options: ExportPNGOptions) => void;
  /** The camera as it is now, captured into the exploration on save. */
  getViewport?: () => ViewportState | null;
}

export type PanelId =
  | 'filters'
  | 'look'
  | 'query'
  | 'metrics'
  | 'clusters'
  | 'templates'
  | 'precomputed';

export const useToolbarStore = defineStore('toolbar', () => {
  const handlers = ref<ToolbarHandlers | null>(null);
  const canvasWidth = ref(0);
  const canvasHeight = ref(0);
  const _activePanels = ref<Set<PanelId>>(new Set());
  /** The About dialog (with the graph shortcuts), openable from any page's status bar. */
  const aboutOpen = ref(false);

  // Expose as a plain object so components can call .has() reactively
  const activePanels = computed(() => _activePanels.value);

  function registerHandlers(newHandlers: ToolbarHandlers) {
    handlers.value = newHandlers;
  }

  function unregisterHandlers() {
    handlers.value = null;
  }

  function updateCanvasDimensions(w: number, h: number) {
    canvasWidth.value = w;
    canvasHeight.value = h;
  }

  function setPanelActive(panelId: PanelId, active: boolean) {
    if (active) {
      _activePanels.value.add(panelId);
    } else {
      _activePanels.value.delete(panelId);
    }
    // Trigger reactivity
    _activePanels.value = new Set(_activePanels.value);
  }

  function isPanelActive(panelId: PanelId): boolean {
    return _activePanels.value.has(panelId);
  }

  return {
    handlers,
    canvasWidth,
    canvasHeight,
    activePanels,
    aboutOpen,
    registerHandlers,
    unregisterHandlers,
    updateCanvasDimensions,
    setPanelActive,
    isPanelActive,
  };
});
