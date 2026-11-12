<script setup lang="ts">
/**
 * The canvas chrome shared by the exploration page and the case: the panel
 * toggles and view controls that act on the graph on screen (Layout, 3D/2D,
 * Fullscreen, Fit, Table, Look, …). The host decides which buttons show and
 * where the row sits (over the canvas on the exploration page, in the strip
 * above it in a case); page-specific buttons go in the default slot.
 */
import { computed, type Component } from 'vue';
import { Download, Filter, Info, Layers, Maximize2, Minimize2, Palette, Scan, Settings2, Table2 } from 'lucide-vue-next';

export type CanvasToolbarButton = 'info' | 'filters' | 'layout' | 'look' | 'table' | 'clusters' | 'fit' | 'export';

const props = withDefaults(
  defineProps<{
    /** Buttons to show, in order. */
    buttons: CanvasToolbarButton[];
    /** Which toggle panels are open (keys are button ids). */
    active?: Partial<Record<CanvasToolbarButton, boolean>>;
    viewMode?: '3d' | '2d-proj';
    isFullscreen?: boolean;
    /** Show the 3D/2D segmented control and the Fullscreen button. */
    showViewMode?: boolean;
    showFullscreen?: boolean;
    /** Test ids per button when a host's tests already name them. */
    testIds?: Partial<Record<CanvasToolbarButton, string>>;
    /** Compact buttons for a strip (smaller padding, same labels). */
    compact?: boolean;
  }>(),
  { active: () => ({}), viewMode: '2d-proj', isFullscreen: false, showViewMode: true, showFullscreen: true, testIds: () => ({}), compact: false },
);

const emit = defineEmits<{
  toggle: [button: CanvasToolbarButton];
  fit: [];
  fullscreen: [];
  'view-mode': [mode: '3d' | '2d-proj'];
  export: [];
}>();

const META: Record<CanvasToolbarButton, { label: string; title: string; icon: Component; action: 'toggle' | 'fit' | 'export' }> = {
  info: { label: 'Info', title: 'Context Info', icon: Info, action: 'toggle' },
  filters: { label: 'Filters', title: 'Filters', icon: Filter, action: 'toggle' },
  layout: { label: 'Layout', title: 'Layout Settings', icon: Settings2, action: 'toggle' },
  look: { label: 'Look', title: 'Look: style, labels, behaviors and presets', icon: Palette, action: 'toggle' },
  table: { label: 'Table', title: 'Data Table', icon: Table2, action: 'toggle' },
  clusters: { label: 'Clusters', title: 'Communities and cluster programs: group the nodes, show only a group', icon: Layers, action: 'toggle' },
  fit: { label: 'Fit', title: 'Fit the graph in the view', icon: Scan, action: 'fit' },
  // "PNG", not "Export": in a case, exporting means the case's JSON/CSV/report.
  export: { label: 'PNG', title: 'Save the canvas as a PNG image', icon: Download, action: 'export' },
};

const items = computed(() => props.buttons.map((id) => ({ id, ...META[id], testId: props.testIds[id] ?? `canvas-toolbar-${id}` })));

function press(id: CanvasToolbarButton) {
  const action = META[id].action;
  if (action === 'fit') emit('fit');
  else if (action === 'export') emit('export');
  else emit('toggle', id);
}
</script>

<template>
  <div class="graph-toolbar" :class="{ compact }" data-testid="graph-toolbar">
    <button
      v-for="b in items"
      :key="b.id"
      class="toolbar-btn"
      :class="{ active: !!active[b.id] }"
      :aria-pressed="b.action === 'toggle' ? !!active[b.id] : undefined"
      :title="b.title"
      :aria-label="b.action === 'fit' ? 'Fit to view' : undefined"
      :data-testid="b.testId"
      @click="press(b.id)"
    >
      <component :is="b.icon" :size="14" />
      <span class="btn-label">{{ b.label }}</span>
    </button>

    <div v-if="showViewMode" class="toolbar-segmented" role="group" aria-label="View mode">
      <button
        class="seg-btn"
        :class="{ active: viewMode === '3d' }"
        :aria-pressed="viewMode === '3d'"
        title="3D"
        data-testid="canvas-toolbar-3d"
        @click="emit('view-mode', '3d')"
      >3D</button>
      <button
        class="seg-btn"
        :class="{ active: viewMode === '2d-proj' }"
        :aria-pressed="viewMode === '2d-proj'"
        title="2D Projection (flat layout)"
        data-testid="canvas-toolbar-2d"
        @click="emit('view-mode', '2d-proj')"
      >2D</button>
    </div>

    <button
      v-if="showFullscreen"
      class="toolbar-btn"
      :aria-pressed="isFullscreen"
      :title="isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'"
      data-testid="canvas-toolbar-fullscreen"
      @click="emit('fullscreen')"
    >
      <Minimize2 v-if="isFullscreen" :size="14" />
      <Maximize2 v-else :size="14" />
      <span class="btn-label">{{ isFullscreen ? 'Exit' : 'Fullscreen' }}</span>
    </button>

    <slot />
  </div>
</template>

<style scoped>
.graph-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  max-width: 100%;
}

.graph-toolbar.compact {
  gap: 4px;
}

.toolbar-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  background: var(--card-background, white);
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  color: inherit;
  transition: all 0.15s;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.compact .toolbar-btn {
  padding: 3px 8px;
  font-size: 12px;
  box-shadow: none;
}

.toolbar-btn:hover {
  background: var(--bg-secondary, #f0f0f0);
}

.toolbar-btn.active {
  background: var(--primary-color, #42b883);
  color: white;
  border-color: var(--primary-color, #42b883);
}

.btn-label {
  font-size: 12px;
}

.toolbar-segmented {
  display: flex;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
  overflow: hidden;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.compact .toolbar-segmented {
  box-shadow: none;
}

.seg-btn {
  padding: 8px 10px;
  background: var(--card-background, white);
  border: none;
  border-right: 1px solid var(--border-color, #ddd);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  color: inherit;
  transition: all 0.15s;
}

.compact .seg-btn {
  padding: 3px 8px;
}

.seg-btn:last-child {
  border-right: none;
}

.seg-btn:hover {
  background: var(--bg-secondary, #f0f0f0);
}

.seg-btn.active {
  background: var(--primary-color, #42b883);
  color: white;
}
</style>
