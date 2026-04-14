<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useGraphStore } from '@/stores/graph';
import { useToolbarStore } from '@/stores/toolbar';
import { useClusterStore } from '@/stores/cluster';
import { useCommunityStore } from '@/stores/community';
import { useSimilarityStore } from '@/stores/similarity';
import GraphCanvas3D from '@/components/GraphCanvas3D.vue';
import SidePanel from '@/components/SidePanel.vue';
import FilterPanel from '@/components/FilterPanel.vue';
import LayoutPanel from '@/components/LayoutPanel.vue';
import BehaviorPanel from '@/components/BehaviorPanel.vue';
import GraphQueryPanel from '@/components/GraphQueryPanel.vue';
import ContextInfoPanel from '@/components/ContextInfoPanel.vue';
import MetricsPanel from '@/components/MetricsPanel.vue';
import ResourceMonitorModal from '@/components/ResourceMonitorModal.vue';
import AestheticsPanel from '@/components/AestheticsPanel.vue';
import TextFormatPanel from '@/components/TextFormatPanel.vue';
import QueryErrorModal from '@/components/QueryErrorModal.vue';
import ClusterProgramPanel from '@/components/ClusterProgramPanel.vue';
import ClusterListPanel from '@/components/ClusterListPanel.vue';
import ClusterNodeModal from '@/components/ClusterNodeModal.vue';
import DetailModal from '@/components/DetailModal.vue';
import DataTablePanel from '@/components/DataTablePanel.vue';
import QueryTemplatesPanel from '@/components/QueryTemplatesPanel.vue';
import { Info, Settings2, Hexagon, Maximize2, Minimize2, Table2, AlertCircle, Network } from 'lucide-vue-next';

const props = defineProps<{
  contextId: string;
}>();

const route = useRoute();
const graphStore = useGraphStore();
const toolbarStore = useToolbarStore();
const clusterStore = useClusterStore();
const communityStore = useCommunityStore();
const similarityStore = useSimilarityStore();

const showFilters = ref(false);
const showLayoutPanel = ref(false);
const showBehaviorPanel = ref(false);
const showQueryPanel = ref(false);
const showContextInfo = ref(false);
const showMetricsPanel = ref(false);
const showResourceMonitor = ref(false);
const showAestheticsPanel = ref(false);
const showTextFormatPanel = ref(false);
const showClusterPrograms = ref(false);
const showClusterList = ref(false);
const showTemplatesPanel = ref(false);
const selectedClusterId = ref<string | null>(null);
const showDetailModal = ref(false);
const showDataTable = ref(false);

const detailModalItem = computed(() => {
  if (!showDetailModal.value) return null;
  if (graphStore.selectedNode) {
    return { type: 'node' as const, data: graphStore.selectedNode };
  }
  if (graphStore.selectedEdge) {
    return { type: 'edge' as const, data: graphStore.selectedEdge };
  }
  return null;
});

const isFullscreen = ref(false);
const graphCanvas3DRef = ref<InstanceType<typeof GraphCanvas3D> | null>(null);
const graphContainerRef = ref<HTMLDivElement | null>(null);

function setViewMode(mode: '3d' | '2d-proj') {
  graphStore.updateBehaviors({ viewMode: mode });
}

// Fullscreen toggle
function toggleFullscreen() {
  if (!graphContainerRef.value) return;

  if (!document.fullscreenElement) {
    graphContainerRef.value.requestFullscreen().then(() => {
      isFullscreen.value = true;
    }).catch(() => {
      // Fullscreen not supported or denied
    });
  } else {
    document.exitFullscreen().then(() => {
      isFullscreen.value = false;
    });
  }
}

// Listen for fullscreen changes (e.g., user presses Esc)
function onFullscreenChange() {
  isFullscreen.value = !!document.fullscreenElement;
}

function handleFocusNode(nodeId: string) {
  graphCanvas3DRef.value?.focusOnNode(nodeId);
}

function handleExportPNG(options: { scale: number; background: 'white' | 'transparent' }) {
  const filename = `${graphStore.currentContext?.title || 'graph'}.png`;
  graphCanvas3DRef.value?.exportPNG(filename, options.scale, options.background);
}

// Track canvas dimensions for the export modal
let canvasResizeObserver: ResizeObserver | null = null;

function updateCanvasDimensions() {
  if (graphContainerRef.value) {
    const rect = graphContainerRef.value.querySelector('.graph-container');
    if (rect) {
      toolbarStore.updateCanvasDimensions(rect.clientWidth, rect.clientHeight);
    }
  }
}

onMounted(async () => {
  // Register toolbar handlers for the global Toolbar component
  toolbarStore.registerHandlers({
    onToggleFilters: () => { showFilters.value = !showFilters.value; toolbarStore.setPanelActive('filters', showFilters.value); },
    onToggleBehaviors: () => { showBehaviorPanel.value = !showBehaviorPanel.value; toolbarStore.setPanelActive('behaviors', showBehaviorPanel.value); },
    onToggleQuery: () => { showQueryPanel.value = !showQueryPanel.value; toolbarStore.setPanelActive('query', showQueryPanel.value); },
    onToggleMetrics: () => { showMetricsPanel.value = !showMetricsPanel.value; toolbarStore.setPanelActive('metrics', showMetricsPanel.value); },
    onToggleAesthetics: () => { showAestheticsPanel.value = !showAestheticsPanel.value; toolbarStore.setPanelActive('aesthetics', showAestheticsPanel.value); },
    onToggleLabels: () => { showTextFormatPanel.value = !showTextFormatPanel.value; toolbarStore.setPanelActive('labels', showTextFormatPanel.value); },
    onToggleClusterPrograms: () => { showClusterPrograms.value = !showClusterPrograms.value; toolbarStore.setPanelActive('clusters', showClusterPrograms.value); },
    onToggleTemplates: () => { showTemplatesPanel.value = !showTemplatesPanel.value; toolbarStore.setPanelActive('templates', showTemplatesPanel.value); },
    onExportPNG: handleExportPNG,
  });

  document.addEventListener('fullscreenchange', onFullscreenChange);

  // Track canvas dimensions for the export modal
  const graphContainer = graphContainerRef.value?.querySelector('.graph-container');
  if (graphContainer) {
    canvasResizeObserver = new ResizeObserver(updateCanvasDimensions);
    canvasResizeObserver.observe(graphContainer);
    updateCanvasDimensions();
  }

  await graphStore.loadContext(props.contextId);

  // Load exploration if specified
  const explorationId = route.query.exploration as string;
  if (explorationId) {
    // Load exploration with its saved clusters and programs
    // This will re-execute the saved graph_query, so we DON'T call loadSubgraph first
    // (otherwise we'd load all nodes, but clusters were created for the query result only)
    await graphStore.loadExploration(explorationId);
  } else {
    // Starting a new context (not loading an exploration)
    // Load initial subgraph with all nodes
    await graphStore.loadSubgraph({});
    // Clear clusters and reset to default programs in memory
    clusterStore.clearAll(); // This also recreates default programs
    communityStore.clearCommunities();
    // Clear graph query - user must execute a query to save exploration
    graphStore.graphQuery = '';
  }
});

onUnmounted(() => {
  toolbarStore.unregisterHandlers();
  document.removeEventListener('fullscreenchange', onFullscreenChange);
  canvasResizeObserver?.disconnect();
  canvasResizeObserver = null;
  graphStore.clear();
});

watch(
  () => props.contextId,
  async (newId) => {
    graphStore.clear();
    clusterStore.clearAll(); // Clear clusters and reset to default programs
    communityStore.clearCommunities();
    await graphStore.loadContext(newId);
    await graphStore.loadSubgraph({});
  }
);
</script>

<template>
  <div ref="graphContainerRef" class="graph-visualization" :class="{ fullscreen: isFullscreen }">
    <div class="main-content">
      <FilterPanel v-if="showFilters" @close="showFilters = false; toolbarStore.setPanelActive('filters', false)" />
      <BehaviorPanel v-if="showBehaviorPanel" @close="showBehaviorPanel = false; toolbarStore.setPanelActive('behaviors', false)" />
      <GraphQueryPanel v-if="showQueryPanel" @close="showQueryPanel = false; toolbarStore.setPanelActive('query', false)" />
      <MetricsPanel
        v-if="showMetricsPanel"
        @close="showMetricsPanel = false; toolbarStore.setPanelActive('metrics', false)"
        @show-resource-monitor="showResourceMonitor = true"
      />
      <AestheticsPanel v-if="showAestheticsPanel" @close="showAestheticsPanel = false; toolbarStore.setPanelActive('aesthetics', false)" />
      <TextFormatPanel v-if="showTextFormatPanel" @close="showTextFormatPanel = false; toolbarStore.setPanelActive('labels', false)" />
      <ClusterProgramPanel v-if="showClusterPrograms" @close="showClusterPrograms = false; toolbarStore.setPanelActive('clusters', false)" />
      <QueryTemplatesPanel v-if="showTemplatesPanel" @close="showTemplatesPanel = false; toolbarStore.setPanelActive('templates', false)" />

      <div class="graph-container" data-testid="graph-container">
        <div v-if="graphStore.loading" class="loading-overlay" data-testid="graph-loading">
          <div class="loading"></div>
        </div>

        <div v-if="graphStore.error" class="error-overlay">
          <div class="error-state">
            <AlertCircle :size="32" class="error-state-icon" />
            <p class="error-state-title">Failed to load graph</p>
            <p class="error-state-message">{{ graphStore.error }}</p>
          </div>
        </div>

        <div v-else-if="!graphStore.loading && graphStore.filteredNodes.length === 0" class="empty-overlay">
          <div class="empty-state">
            <Network :size="48" class="empty-state-icon" />
            <p class="empty-state-title">No nodes to display</p>
            <p class="empty-state-message">Run a query to start visualizing your graph</p>
          </div>
        </div>

        <GraphCanvas3D
          ref="graphCanvas3DRef"
          @cluster-node-click="selectedClusterId = $event"
        />

        <!-- Layout Panel -->
        <div v-if="showLayoutPanel" class="panel-wrapper panel-left">
          <LayoutPanel
            :is-layout-running="graphCanvas3DRef?.isLayoutRunning ?? false"
            @start-layout="graphCanvas3DRef?.startLayout()"
            @stop-layout="graphCanvas3DRef?.stopLayout()"
            @reheat-layout="graphCanvas3DRef?.reheatLayout()"
            @scramble-layout="graphCanvas3DRef?.scrambleLayout()"
            @start-edge-type-layout="(et: string | null, s: string) => graphCanvas3DRef?.startEdgeTypeLayout(et, s as any, similarityStore.useScoreAsWeight)"
          />
        </div>

        <!-- Floating Details Panel (shown in fullscreen mode) -->
        <SidePanel v-if="isFullscreen" variant="floating" @show-details="showDetailModal = true" />

        <!-- Context Info Panel -->
        <ContextInfoPanel v-if="showContextInfo" @close="showContextInfo = false" />

        <!-- Cluster List Panel (right side) -->
        <div v-if="showClusterList" class="panel-wrapper panel-right">
          <ClusterListPanel />
        </div>

        <!-- Bottom toolbar -->
        <div class="graph-toolbar">
          <button
            class="toolbar-btn"
            :class="{ active: showContextInfo }"
            @click="showContextInfo = !showContextInfo"
            title="Context Info"
          >
            <Info :size="14" />
            <span class="btn-label">Info</span>
          </button>

          <button
            class="toolbar-btn"
            :class="{ active: showLayoutPanel }"
            @click="showLayoutPanel = !showLayoutPanel"
            title="Layout Settings"
          >
            <Settings2 :size="14" />
            <span class="btn-label">Layout</span>
          </button>

          <button
            v-if="clusterStore.clusters.length > 0"
            class="toolbar-btn"
            :class="{ active: showClusterList }"
            @click="showClusterList = !showClusterList"
            title="Cluster List"
          >
            <Hexagon :size="14" />
            <span class="btn-label">Clusters ({{ clusterStore.clusters.length }})</span>
          </button>

          <div class="toolbar-segmented">
            <button
              class="seg-btn"
              :class="{ active: graphStore.behaviors.viewMode === '3d' }"
              @click="setViewMode('3d')"
              title="3D"
            >3D</button>
            <button
              class="seg-btn"
              :class="{ active: graphStore.behaviors.viewMode === '2d-proj' }"
              @click="setViewMode('2d-proj')"
              title="2D Projection (flat layout)"
            >2D</button>
          </div>

          <button
            class="toolbar-btn"
            @click="toggleFullscreen"
            :title="isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'"
          >
            <Minimize2 v-if="isFullscreen" :size="14" />
            <Maximize2 v-else :size="14" />
            <span class="btn-label">{{ isFullscreen ? 'Exit' : 'Fullscreen' }}</span>
          </button>

          <button
            class="toolbar-btn"
            :class="{ active: showDataTable }"
            @click="showDataTable = !showDataTable"
            title="Data Table"
          >
            <Table2 :size="14" />
            <span class="btn-label">Table</span>
          </button>
        </div>

        <div class="status-bar" data-testid="graph-status-bar">
          <span>{{ graphStore.filteredNodes.length }} nodes</span>
          <span>{{ graphStore.filteredEdges.length }} edges</span>
        </div>
      </div>

      <SidePanel v-if="!isFullscreen" @show-details="showDetailModal = true" />
    </div>

    <!-- Data Table (bottom drawer) -->
    <DataTablePanel
      v-if="showDataTable"
      @close="showDataTable = false"
      @focus-node="handleFocusNode"
      @focus-edge="handleFocusNode"
    />

    <!-- Resource Monitor Modal -->
    <ResourceMonitorModal
      v-if="showResourceMonitor"
      @close="showResourceMonitor = false"
    />

    <!-- Query Error Modal -->
    <QueryErrorModal
      :error="graphStore.queryError"
      @close="graphStore.clearQueryError()"
    />

    <!-- Cluster Node Modal -->
    <ClusterNodeModal
      :cluster-id="selectedClusterId"
      @close="selectedClusterId = null"
    />

    <!-- Detail Modal (full properties view) -->
    <DetailModal
      :item="detailModalItem"
      @close="showDetailModal = false"
    />
  </div>
</template>

<style scoped>
.graph-visualization {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 60px);
}

.main-content {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.graph-container {
  flex: 1;
  position: relative;
  display: flex;
  flex-direction: column;
  background: var(--bg-color, #fafafa);
}

.graph-visualization.fullscreen {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 1000;
  height: 100vh;
  background: var(--bg-color, #fafafa);
}

.loading-overlay,
.error-overlay,
.empty-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.85);
  z-index: 10;
  pointer-events: none;
}

.error-state,
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  text-align: center;
  padding: var(--space-6);
}

.error-state-icon {
  color: var(--color-error, #e53e3e);
  opacity: 0.8;
}

.error-state-title {
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--text-color);
  margin: 0;
}

.error-state-message {
  font-size: var(--text-sm);
  color: var(--text-muted);
  margin: 0;
  max-width: 360px;
}

.empty-state-icon {
  color: var(--border-color);
  opacity: 0.6;
}

.empty-state-title {
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--text-muted);
  margin: 0;
}

.empty-state-message {
  font-size: var(--text-sm);
  color: var(--text-muted);
  opacity: 0.7;
  margin: 0;
}

.status-bar {
  display: flex;
  gap: 16px;
  padding: 8px 16px;
  background: var(--card-background);
  border-top: 1px solid var(--border-color);
  font-size: 12px;
  color: var(--text-muted);
}

.panel-wrapper {
  position: absolute;
  bottom: 80px;
  z-index: 20;
}

.panel-wrapper.panel-left {
  left: 16px;
}

.panel-wrapper.panel-right {
  right: 16px;
}

.graph-toolbar {
  position: absolute;
  bottom: 48px;
  left: 16px;
  display: flex;
  gap: 8px;
  z-index: 20;
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
  font-size: 13px;
  transition: all 0.15s;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.toolbar-btn:hover {
  background: var(--bg-secondary, #f0f0f0);
}

.toolbar-btn.active {
  background: var(--primary-color, #42b883);
  color: white;
  border-color: var(--primary-color, #42b883);
}

.btn-icon {
  font-size: 14px;
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

.seg-btn {
  padding: 8px 10px;
  background: var(--card-background, white);
  border: none;
  border-right: 1px solid var(--border-color, #ddd);
  cursor: pointer;
  font-size: 12px;
  transition: all 0.15s;
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
