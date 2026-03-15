<script setup lang="ts">
import { computed, ref } from 'vue';
import { useGraphStore } from '@/stores/graph';
import { ChevronDown, ChevronRight, X } from 'lucide-vue-next';

const showAdvanced = ref(false);

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const graphStore = useGraphStore();

const behaviors = computed(() => graphStore.behaviors);
const force3D = computed(() => graphStore.force3DSettings);
const hasSelection = computed(() => graphStore.selectedNodeIds.size > 0);
const maxDegree = computed(() => graphStore.maxDegree);
const hasSelfEdges = computed(() => graphStore.hasSelfEdges);

function setEdgeLensMode(mode: 'off' | 'hide' | 'dim') {
  graphStore.updateBehaviors({ edgeLensMode: mode });
}

function updateFocusDepth(depth: number) {
  graphStore.updateBehaviors({ focusDepth: depth });
}

function setSearchMode(mode: 'hide' | 'highlight') {
  graphStore.updateBehaviors({ searchMode: mode });
}

function toggleCenterOnSearch() {
  graphStore.updateBehaviors({ centerOnSearch: !behaviors.value.centerOnSearch });
}

function toggleHideLabelsOnCameraMove() {
  graphStore.updateBehaviors({ hideLabelsOnCameraMove: !behaviors.value.hideLabelsOnCameraMove });
}

function toggleOrthographicCamera() {
  graphStore.updateBehaviors({ useOrthographicCamera: !behaviors.value.useOrthographicCamera });
}

function toggleSelfEdges() {
  graphStore.updateBehaviors({ showSelfEdges: !behaviors.value.showSelfEdges });
}

function toggleHideSelfEdgesOnCameraMove() {
  graphStore.updateBehaviors({ hideSelfEdgesOnCameraMove: !behaviors.value.hideSelfEdgesOnCameraMove });
}

function toggleDegreeDim() {
  graphStore.updateBehaviors({ degreeDimEnabled: !behaviors.value.degreeDimEnabled });
}

function togglePreserveBridges() {
  graphStore.updateBehaviors({ degreeDimPreserveBridges: !behaviors.value.degreeDimPreserveBridges });
}


function toggleInstancedRendering() {
  graphStore.updateBehaviors({ useInstancedRendering: !behaviors.value.useInstancedRendering });
}

function toggleLabelDensityCulling() {
  graphStore.updateBehaviors({ labelDensityCulling: !behaviors.value.labelDensityCulling });
}

function toggleNodeDrag() {
  graphStore.updateBehaviors({ enableNodeDrag: !behaviors.value.enableNodeDrag });
}

function togglePointerRepulsion() {
  graphStore.updateForce3DSettings({ pointerRepulsionEnabled: !force3D.value.pointerRepulsionEnabled });
}

function toggleSizeInertia() {
  graphStore.updateForce3DSettings({ pointerSizeInertia: !force3D.value.pointerSizeInertia });
}

function toggleClippingPlane() {
  graphStore.updateForce3DSettings({ clippingPlaneEnabled: !force3D.value.clippingPlaneEnabled });
}

function resetBehaviors() {
  graphStore.updateBehaviors({
    edgeLensMode: 'dim',
    edgeLensDimOpacity: 0.08,
    focusDepth: 1,
    degreeDimEnabled: true,
    degreeDimThreshold: 30,
    degreeDimOpacity: 0.08,
    degreeDimPreserveBridges: true,
    searchMode: 'highlight',
    centerOnSearch: true,
    viewMode: '3d',
    hideLabelsOnCameraMove: true,
    useOrthographicCamera: false,
    useInstancedRendering: true,
    labelDensityCulling: true,
    labelDensity: 0.5,
    labelGridCellSize: 150,
    labelSizeThreshold: 6,
    showSelfEdges: true,
    hideSelfEdgesOnCameraMove: true,
    enableNodeDrag: false,
  });
  graphStore.updateForce3DSettings({
    pointerRepulsionEnabled: true,
    pointerVacuumEnabled: false,
    pointerRepulsionStrength: 150,
    pointerRepulsionRange: 200,
    clippingPlaneEnabled: false,
    clippingPlaneDistance: 0,
  });
}
</script>

<template>
  <div class="behavior-panel">
    <div class="panel-header">
      <h3>Behaviors</h3>
      <div class="header-actions">
        <button class="btn btn-outline btn-sm" @click="resetBehaviors">Reset</button>
        <button class="btn-icon-only close-btn" aria-label="Close" @click="emit('close')"><X :size="16" /></button>
      </div>
    </div>

    <div v-if="hasSelfEdges" class="behavior-section">
      <h4>Self-Edges</h4>

      <div class="checkbox-list">
        <label class="checkbox-item">
          <input type="checkbox" :checked="behaviors.showSelfEdges" @change="toggleSelfEdges" />
          Show self-edges
        </label>
        <label class="checkbox-item">
          <input type="checkbox" :checked="behaviors.hideSelfEdgesOnCameraMove" @change="toggleHideSelfEdgesOnCameraMove" />
          Hide self-edges on camera move
        </label>
      </div>

      <p class="behavior-desc">
        Display edges that connect a node to itself (loops)
      </p>
    </div>

    <div class="behavior-section">
      <h4>Graph Lens</h4>

      <div class="radio-list">
        <label class="radio-item">
          <input type="radio" name="edgeLensMode" value="off" :checked="behaviors.edgeLensMode === 'off'"
            @change="setEdgeLensMode('off')" />
          Off
        </label>
        <label class="radio-item">
          <input type="radio" name="edgeLensMode" value="hide" :checked="behaviors.edgeLensMode === 'hide'"
            @change="setEdgeLensMode('hide')" />
          Hide non-focused
        </label>
        <label class="radio-item">
          <input type="radio" name="edgeLensMode" value="dim" :checked="behaviors.edgeLensMode === 'dim'"
            @change="setEdgeLensMode('dim')" />
          Dim non-focused
        </label>
      </div>

      <p class="behavior-desc">
        <template v-if="behaviors.edgeLensMode === 'off'">
          All nodes and edges visible at full opacity
        </template>
        <template v-else-if="behaviors.edgeLensMode === 'hide'">
          Hide nodes, edges and labels outside the selection neighborhood
        </template>
        <template v-else>
          Dim nodes, edges and labels outside the selection/hover neighborhood
        </template>
      </p>

      <div v-if="behaviors.edgeLensMode !== 'off'" class="sub-options">
        <div class="form-group">
          <label>
            Depth
          </label>
          <select :value="behaviors.focusDepth"
            @change="updateFocusDepth(parseInt(($event.target as HTMLSelectElement).value))" class="form-control">
            <option :value="1">1 (direct neighbors)</option>
            <option :value="2">2 hops</option>
            <option :value="3">3 hops</option>
          </select>
        </div>

        <div v-if="behaviors.edgeLensMode === 'dim'" class="form-group">
          <label>
            Dim opacity
            <span class="value-display">{{ Math.round(behaviors.edgeLensDimOpacity * 100) }}%</span>
          </label>
          <input type="range" class="range-input" :value="behaviors.edgeLensDimOpacity" min="0.01" max="0.5" step="0.01"
            @input="graphStore.updateBehaviors({ edgeLensDimOpacity: parseFloat(($event.target as HTMLInputElement).value) })" />
        </div>

        <div v-if="!hasSelection" class="hint">
          Select or hover a node to see the effect
        </div>
      </div>
    </div>

    <div class="behavior-section">
      <h4>Degree Dimming</h4>

      <div class="checkbox-list">
        <label class="checkbox-item">
          <input type="checkbox" :checked="behaviors.degreeDimEnabled" @change="toggleDegreeDim" />
          Dim Hub
        </label>
      </div>

      <p class="behavior-desc">
        Dim nodes and edges connected to high-degree hubs
      </p>

      <div v-if="behaviors.degreeDimEnabled" class="sub-options">
        <div class="form-group">
          <label>
            Threshold
            <span class="value-display">{{ behaviors.degreeDimThreshold }}</span>
          </label>
          <input type="range" class="range-input" :value="behaviors.degreeDimThreshold" :min="1"
            :max="Math.max(maxDegree, 2)" step="1"
            @input="graphStore.updateBehaviors({ degreeDimThreshold: parseInt(($event.target as HTMLInputElement).value) })" />
          <p class="behavior-desc" style="margin-top: 4px;">
            Max degree in graph: {{ maxDegree }}
          </p>
        </div>

        <div class="form-group">
          <label>
            Dim opacity
            <span class="value-display">{{ Math.round(behaviors.degreeDimOpacity * 100) }}%</span>
          </label>
          <input type="range" class="range-input" :value="behaviors.degreeDimOpacity" min="0.01" max="0.5" step="0.01"
            @input="graphStore.updateBehaviors({ degreeDimOpacity: parseFloat(($event.target as HTMLInputElement).value) })" />
        </div>

        <label class="checkbox-item" style="margin-top: 8px;">
          <input type="checkbox" :checked="behaviors.degreeDimPreserveBridges" @change="togglePreserveBridges" />
          Preserve bridges
        </label>
        <p class="behavior-desc">
          Don't dim nodes that also connect to non-hub neighborhoods
        </p>
      </div>
    </div>

    <!-- Advanced toggle -->
    <div class="advanced-toggle" @click="showAdvanced = !showAdvanced">
      <ChevronDown v-if="showAdvanced" :size="12" class="toggle-icon" />
      <ChevronRight v-else :size="12" class="toggle-icon" />
      <span class="advanced-label">Advanced</span>
    </div>

    <template v-if="showAdvanced">
      <div class="behavior-section">
        <h4>Search Behavior</h4>

        <div class="radio-list">
          <label class="radio-item">
            <input type="radio" name="searchMode" value="hide" :checked="behaviors.searchMode === 'hide'"
              @change="setSearchMode('hide')" />
            Hide non-matching nodes
          </label>
          <label class="radio-item">
            <input type="radio" name="searchMode" value="highlight" :checked="behaviors.searchMode === 'highlight'"
              @change="setSearchMode('highlight')" />
            Highlight matching nodes
          </label>
        </div>

        <p class="behavior-desc">
          <template v-if="behaviors.searchMode === 'hide'">
            Non-matching nodes are hidden from the graph
          </template>
          <template v-else>
            Matching nodes are highlighted (larger + colored)
          </template>
        </p>

        <div class="sub-options">
          <label class="checkbox-item">
            <input type="checkbox" :checked="behaviors.centerOnSearch" @change="toggleCenterOnSearch" />
            Center on best match
          </label>
          <p class="behavior-desc">
            Camera follows best match while typing
          </p>
        </div>
      </div>

      <div class="behavior-section">
        <h4>3D Rendering</h4>

        <div class="checkbox-list">
          <label class="checkbox-item">
            <input type="checkbox" :checked="behaviors.enableNodeDrag" @change="toggleNodeDrag" />
            Node drag
          </label>
          <p class="behavior-desc">
            Click-drag nodes to reposition them. Dragged nodes stay pinned in place.
          </p>
          <label class="checkbox-item">
            <input type="checkbox" :checked="behaviors.hideLabelsOnCameraMove" @change="toggleHideLabelsOnCameraMove" />
            Hide labels on camera move
          </label>
          <p class="behavior-desc">
            Temporarily hide 3D text labels during camera movement for better performance
          </p>
          <label class="checkbox-item">
            <input type="checkbox" :checked="behaviors.useOrthographicCamera" @change="toggleOrthographicCamera" />
            Node size unaffected by distance
          </label>
          <p class="behavior-desc">
            No perspective distortion, parallel projection (graph will re-init)
          </p>
          <label class="checkbox-item">
            <input type="checkbox" :checked="behaviors.useInstancedRendering" @change="toggleInstancedRendering" />
            Instanced rendering (fast)
          </label>
          <p class="behavior-desc">
            Use InstancedMesh for nodes/links (~3 draw calls). Disable for correct transparency (slower, 1 draw call per object). Graph will re-init.
          </p>
          <label class="checkbox-item">
            <input type="checkbox" :checked="behaviors.labelDensityCulling" @change="toggleLabelDensityCulling" />
            Label density culling
          </label>
          <p class="behavior-desc">
            Limit label density per screen region. Larger nodes keep their labels; smaller ones hidden when crowded.
          </p>
        </div>

        <div v-if="behaviors.labelDensityCulling" class="sub-options">
          <div class="form-group">
            <label>
              Size threshold
              <span class="value-display">{{ behaviors.labelSizeThreshold }}px</span>
            </label>
            <input type="range" class="range-input" :value="behaviors.labelSizeThreshold" min="0" max="100" step="1"
              @input="graphStore.updateBehaviors({ labelSizeThreshold: parseInt(($event.target as HTMLInputElement).value) })" />
            <p class="behavior-desc" style="margin-top: 4px;">
              Min node screen radius to show label (0 = show all)
            </p>
          </div>
          <div class="form-group">
            <label>
              Density
              <span class="value-display">{{ behaviors.labelDensity }}</span>
            </label>
            <input type="range" class="range-input" :value="behaviors.labelDensity" min="0.1" max="10" step="0.1"
              @input="graphStore.updateBehaviors({ labelDensity: parseFloat(($event.target as HTMLInputElement).value) })" />
            <p class="behavior-desc" style="margin-top: 4px;">
              Labels per grid cell at default zoom
            </p>
          </div>
          <div class="form-group">
            <label>
              Cell size
              <span class="value-display">{{ behaviors.labelGridCellSize }}px</span>
            </label>
            <input type="range" class="range-input" :value="behaviors.labelGridCellSize" min="10" max="1000" step="10"
              @input="graphStore.updateBehaviors({ labelGridCellSize: parseInt(($event.target as HTMLInputElement).value) })" />
            <p class="behavior-desc" style="margin-top: 4px;">
              Smaller cells = stricter culling
            </p>
          </div>
          <div class="behavior-option">
            <label>
              Overlap tolerance
              <span class="value-display">{{ (behaviors.labelOverlapThreshold * 100).toFixed(0) }}%</span>
            </label>
            <input type="range" class="range-input" :value="behaviors.labelOverlapThreshold" min="0" max="1" step="0.05"
              @input="graphStore.updateBehaviors({ labelOverlapThreshold: parseFloat(($event.target as HTMLInputElement).value) })" />
            <p class="behavior-desc" style="margin-top: 4px;">
              0% = no overlap allowed, 100% = all labels shown
            </p>
          </div>
        </div>
      </div>

      <div class="behavior-section">
        <h4>Pointer Tools</h4>

        <div class="checkbox-list">
          <label class="checkbox-item">
            <input type="checkbox" :checked="force3D.pointerRepulsionEnabled" @change="togglePointerRepulsion" />
            Blower (Shift+mouse)
          </label>
          <p class="behavior-desc">
            Hold Shift + move mouse to push nodes away from cursor ray
          </p>
        </div>

        <div v-if="force3D.pointerRepulsionEnabled" class="sub-options">
          <div class="form-group">
            <label>
              Strength
              <span class="value-display">{{ force3D.pointerRepulsionStrength }}</span>
            </label>
            <input type="range" class="range-input" :value="force3D.pointerRepulsionStrength" min="1" max="500" step="1"
              @input="graphStore.updateForce3DSettings({ pointerRepulsionStrength: parseInt(($event.target as HTMLInputElement).value) })" />
          </div>
          <div class="form-group">
            <label>
              Range
              <span class="value-display">{{ force3D.pointerRepulsionRange }}</span>
            </label>
            <input type="range" class="range-input" :value="force3D.pointerRepulsionRange" min="10" max="500" step="1"
              @input="graphStore.updateForce3DSettings({ pointerRepulsionRange: parseInt(($event.target as HTMLInputElement).value) })" />
          </div>
          <label class="checkbox-item" style="margin-top: 8px;">
            <input type="checkbox" :checked="force3D.pointerSizeInertia" @change="toggleSizeInertia" />
            Size inertia
          </label>
          <p class="behavior-desc">
            Larger nodes resist the blower/vacuum more
          </p>
        </div>
      </div>

      <div class="behavior-section">
        <h4>Clipping Plane (Alt+scroll)</h4>

        <div class="checkbox-list">
          <label class="checkbox-item">
            <input type="checkbox" :checked="force3D.clippingPlaneEnabled" @change="toggleClippingPlane" />
            Enable clipping plane
          </label>
        </div>

        <p class="behavior-desc">
          Slice the graph with a cutting plane. Use Alt+scroll to adjust depth.
        </p>

        <div v-if="force3D.clippingPlaneEnabled" class="sub-options">
          <div class="form-group">
            <label>
              Depth
              <span class="value-display">{{ force3D.clippingPlaneDistance }}</span>
            </label>
            <input type="range" class="range-input" :value="force3D.clippingPlaneDistance" min="-500" max="500" step="1"
              @input="graphStore.updateForce3DSettings({ clippingPlaneDistance: parseInt(($event.target as HTMLInputElement).value) })" />
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.behavior-panel {
  width: 250px;
  background: var(--card-background);
  border-right: 1px solid var(--border-color);
  overflow-y: auto;
  padding: 16px;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.panel-header h3 {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
}

.header-actions {
  display: flex;
  gap: 4px;
}

.close-btn {
  font-size: 16px;
  padding: 2px 8px;
}

.btn-sm {
  padding: 4px 8px;
  font-size: 12px;
}

.behavior-section {
  margin-bottom: 20px;
}

.behavior-section h4 {
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 8px;
  color: var(--text-muted);
}

.checkbox-list,
.radio-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.checkbox-item,
.radio-item {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 14px;
}

.checkbox-item input,
.radio-item input {
  cursor: pointer;
}

.behavior-desc {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.4;
}

.sub-options {
  margin-top: 12px;
  padding: 12px;
  background: var(--bg-secondary, #f5f5f5);
  border-radius: 6px;
}

.form-group {
  margin-bottom: 8px;
}

.form-group:last-child {
  margin-bottom: 0;
}

.form-group label {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 4px;
}

.value-display {
  font-family: monospace;
  color: var(--text-color, #333);
}

.range-input {
  width: 100%;
  height: 4px;
  border-radius: 2px;
  appearance: none;
  background: var(--border-color, #ddd);
  cursor: pointer;
}

.range-input::-webkit-slider-thumb {
  appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--primary-color, #42b883);
  cursor: pointer;
}

.form-control {
  width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  font-size: 13px;
  background: var(--card-background);
}

.hint {
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-muted);
  font-style: italic;
}

.advanced-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 4px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-muted, #666);
  user-select: none;
  transition: color 0.15s;
}

.advanced-toggle:hover {
  color: var(--text-color, #333);
}

.toggle-icon {
  font-size: 10px;
  color: var(--text-muted, #666);
}

.advanced-label {
  letter-spacing: 0.3px;
}
</style>
