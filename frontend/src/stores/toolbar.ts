import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

export interface ExportPNGOptions {
  scale: number;
  background: 'white' | 'transparent';
}

export interface ToolbarHandlers {
  onToggleFilters: () => void;
  onToggleBehaviors: () => void;
  onToggleQuery: () => void;
  onToggleMetrics: () => void;
  onToggleAesthetics: () => void;
  onToggleLabels: () => void;
  onToggleClusterPrograms: () => void;
  onToggleTemplates: () => void;
  onExportPNG: (options: ExportPNGOptions) => void;
}

export type PanelId =
  | 'filters'
  | 'behaviors'
  | 'query'
  | 'metrics'
  | 'aesthetics'
  | 'labels'
  | 'clusters'
  | 'templates';

export const useToolbarStore = defineStore('toolbar', () => {
  const handlers = ref<ToolbarHandlers | null>(null);
  const canvasWidth = ref(0);
  const canvasHeight = ref(0);
  const _activePanels = ref<Set<PanelId>>(new Set());

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
    registerHandlers,
    unregisterHandlers,
    updateCanvasDimensions,
    setPanelActive,
    isPanelActive,
  };
});
