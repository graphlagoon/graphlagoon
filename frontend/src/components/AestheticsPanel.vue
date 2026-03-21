<script setup lang="ts">
import { computed } from 'vue';
import { useGraphStore } from '@/stores/graph';
import { X } from 'lucide-vue-next';
import IconPicker from '@/components/IconPicker.vue';

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const graphStore = useGraphStore();

const aesthetics = computed(() => graphStore.aesthetics);

// Get all unique node and edge types from the current graph
const nodeTypes = computed(() => graphStore.nodeTypes);
const edgeTypes = computed(() => graphStore.edgeTypes);
const hasEdgeIcons = computed(() => graphStore.edgeTypeIcons.size > 0);

function updateSetting<K extends keyof typeof aesthetics.value>(
  key: K,
  value: typeof aesthetics.value[K]
) {
  graphStore.updateAesthetics({ [key]: value });
}

function getNodeColor(type: string): string {
  return graphStore.getNodeTypeColor(type);
}

function getEdgeColor(type: string): string {
  return graphStore.getEdgeTypeColor(type);
}

function setNodeColor(type: string, color: string) {
  graphStore.setNodeTypeColor(type, color);
}

function setEdgeColor(type: string, color: string) {
  graphStore.setEdgeTypeColor(type, color);
}

function getNodeIcon(type: string): string | null {
  return graphStore.getNodeTypeIcon(type);
}

function setNodeIcon(type: string, iconName: string | null) {
  graphStore.setNodeTypeIcon(type, iconName);
}

function getEdgeIcon(type: string): string | null {
  return graphStore.getEdgeTypeIcon(type);
}

function setEdgeIcon(type: string, iconName: string | null) {
  graphStore.setEdgeTypeIcon(type, iconName);
}

function resetAesthetics() {
  graphStore.updateAesthetics({
    showArrows: true,
    arrowSize: 1.0,
    nodeOpacity: 1.0,
    edgeOpacity: 0.6,
    nodeSize: 8,
    edgeWidth: 1,
    enableMultiEdgeCurvature: false,
    showNodeLabels3D: true,
    showEdgeLabels3D: true,
    nodeLabelSize3D: 10,
    edgeLabelSize3D: 5,
    edgeIconSize3D: 3,
    nodeLabelOffsetY3D: 2,
  });
  graphStore.resetTypeColors();
  graphStore.resetNodeTypeIcons();
  graphStore.resetEdgeTypeIcons();
}
</script>

<template>
  <div class="aesthetics-panel">
    <div class="panel-header">
      <h3>Style</h3>
      <div class="header-actions">
        <button class="btn btn-outline btn-sm" @click="resetAesthetics">Reset</button>
        <button class="btn-icon-only close-btn" aria-label="Close" @click="emit('close')"><X :size="16" /></button>
      </div>
    </div>

    <!-- Common Settings -->
    <div class="settings-section">
      <h5>Edges</h5>

      <div class="setting-item">
        <label class="checkbox-label">
          <input
            type="checkbox"
            :checked="aesthetics.showArrows"
            @change="updateSetting('showArrows', ($event.target as HTMLInputElement).checked)"
          />
          Show arrows
        </label>
      </div>

      <div v-if="aesthetics.showArrows" class="setting-item">
        <label>
          <span class="setting-label">Arrow size</span>
          <span class="setting-value">{{ aesthetics.arrowSize.toFixed(1) }}x</span>
        </label>
        <input
          type="range"
          min="0.5"
          max="3"
          step="0.1"
          :value="aesthetics.arrowSize"
          @input="updateSetting('arrowSize', parseFloat(($event.target as HTMLInputElement).value))"
        />
      </div>

      <div class="setting-item">
        <label>
          <span class="setting-label">Edge opacity</span>
          <span class="setting-value">{{ (aesthetics.edgeOpacity * 100).toFixed(0) }}%</span>
        </label>
        <input
          type="range"
          min="0.1"
          max="1"
          step="0.05"
          :value="aesthetics.edgeOpacity"
          @input="updateSetting('edgeOpacity', parseFloat(($event.target as HTMLInputElement).value))"
        />
      </div>

      <div class="setting-item">
        <label>
          <span class="setting-label">Edge width</span>
          <span class="setting-value">{{ aesthetics.edgeWidth.toFixed(1) }}</span>
        </label>
        <input
          type="range"
          min="0.5"
          max="5"
          step="0.5"
          :value="aesthetics.edgeWidth"
          @input="updateSetting('edgeWidth', parseFloat(($event.target as HTMLInputElement).value))"
        />
      </div>

      <div v-if="graphStore.enhancedHasMultiEdges" class="setting-item">
        <label class="checkbox-label">
          <input
            type="checkbox"
            :checked="aesthetics.enableMultiEdgeCurvature"
            @change="updateSetting('enableMultiEdgeCurvature', ($event.target as HTMLInputElement).checked)"
          />
          Curve multi-edges
        </label>
        <span class="setting-hint">Curved lines for multiple edges between same nodes (includes clusters)</span>
      </div>

    </div>

    <div class="settings-section">
      <h5>Nodes</h5>

      <div class="setting-item">
        <label>
          <span class="setting-label">Node opacity</span>
          <span class="setting-value">{{ (aesthetics.nodeOpacity * 100).toFixed(0) }}%</span>
        </label>
        <input
          type="range"
          min="0.1"
          max="1"
          step="0.05"
          :value="aesthetics.nodeOpacity"
          @input="updateSetting('nodeOpacity', parseFloat(($event.target as HTMLInputElement).value))"
        />
      </div>

      <div class="setting-item">
        <label>
          <span class="setting-label">Node size</span>
          <span class="setting-value">{{ aesthetics.nodeSize }}</span>
        </label>
        <input
          type="range"
          min="4"
          max="20"
          step="1"
          :value="aesthetics.nodeSize"
          @input="updateSetting('nodeSize', parseInt(($event.target as HTMLInputElement).value))"
        />
      </div>
    </div>

    <!-- Color Customization -->
    <div v-if="nodeTypes.length > 0" class="settings-section">
      <h5>Node Colors &amp; Icons</h5>
      <div class="color-list">
        <div v-for="type in nodeTypes" :key="type" class="color-item">
          <input
            type="color"
            :value="getNodeColor(type)"
            @input="setNodeColor(type, ($event.target as HTMLInputElement).value)"
            class="color-picker"
          />
          <IconPicker
            :modelValue="getNodeIcon(type)"
            @update:modelValue="setNodeIcon(type, $event)"
          />
          <span class="color-type-label">{{ type }}</span>
        </div>
      </div>
    </div>

    <div v-if="edgeTypes.length > 0" class="settings-section">
      <h5>Edge Colors &amp; Icons</h5>
      <div class="color-list">
        <div v-for="type in edgeTypes" :key="type" class="color-item">
          <input
            type="color"
            :value="getEdgeColor(type)"
            @input="setEdgeColor(type, ($event.target as HTMLInputElement).value)"
            class="color-picker"
          />
          <IconPicker
            :modelValue="getEdgeIcon(type)"
            @update:modelValue="setEdgeIcon(type, $event)"
          />
          <span class="color-type-label">{{ type }}</span>
        </div>
      </div>
    </div>

    <!-- Label Settings -->
    <div class="settings-section">
      <h5>Labels</h5>

        <div class="setting-item">
          <label class="checkbox-label">
            <input
              type="checkbox"
              :checked="aesthetics.showNodeLabels3D"
              @change="updateSetting('showNodeLabels3D', ($event.target as HTMLInputElement).checked)"
            />
            Show node labels
          </label>
        </div>

        <div v-if="aesthetics.showNodeLabels3D" class="setting-item">
          <label>
            <span class="setting-label">Node label size</span>
            <span class="setting-value">{{ aesthetics.nodeLabelSize3D.toFixed(1) }}</span>
          </label>
          <input
            type="range"
            min="1"
            max="20"
            step="1"
            :value="aesthetics.nodeLabelSize3D"
            @input="updateSetting('nodeLabelSize3D', parseFloat(($event.target as HTMLInputElement).value))"
          />
        </div>

        <div v-if="aesthetics.showNodeLabels3D" class="setting-item">
          <label>
            <span class="setting-label">Label position</span>
          </label>
          <select
            :value="aesthetics.nodeLabelPosition3D ?? 'right'"
            @change="updateSetting('nodeLabelPosition3D', ($event.target as HTMLSelectElement).value as 'top' | 'right' | 'left')"
          >
            <option value="top">Top</option>
            <option value="right">Right</option>
            <option value="left">Left</option>
          </select>
        </div>

        <div v-if="aesthetics.showNodeLabels3D" class="setting-item">
          <label>
            <span class="setting-label">Label offset</span>
            <span class="setting-value">{{ (aesthetics.nodeLabelOffsetY3D ?? 2).toFixed(1) }}</span>
          </label>
          <input
            type="range"
            min="-5"
            max="10"
            step="0.5"
            :value="aesthetics.nodeLabelOffsetY3D ?? 2"
            @input="updateSetting('nodeLabelOffsetY3D', parseFloat(($event.target as HTMLInputElement).value))"
          />
        </div>

        <div class="setting-item">
          <label class="checkbox-label">
            <input
              type="checkbox"
              :checked="aesthetics.showEdgeLabels3D"
              @change="updateSetting('showEdgeLabels3D', ($event.target as HTMLInputElement).checked)"
            />
            Show edge labels
          </label>
        </div>

        <div v-if="aesthetics.showEdgeLabels3D" class="setting-item">
          <label>
            <span class="setting-label">Edge label size</span>
            <span class="setting-value">{{ aesthetics.edgeLabelSize3D.toFixed(1) }}</span>
          </label>
          <input
            type="range"
            min="1"
            max="8"
            step="0.5"
            :value="aesthetics.edgeLabelSize3D"
            @input="updateSetting('edgeLabelSize3D', parseFloat(($event.target as HTMLInputElement).value))"
          />
        </div>

        <div v-if="aesthetics.showEdgeLabels3D && hasEdgeIcons" class="setting-item">
          <label>
            <span class="setting-label">Edge icon size</span>
            <span class="setting-value">{{ (aesthetics.edgeIconSize3D ?? 3).toFixed(1) }}</span>
          </label>
          <input
            type="range"
            min="1"
            max="10"
            step="0.5"
            :value="aesthetics.edgeIconSize3D ?? 3"
            @input="updateSetting('edgeIconSize3D', parseFloat(($event.target as HTMLInputElement).value))"
          />
        </div>
    </div>
  </div>
</template>

<style scoped>
.aesthetics-panel {
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

.btn-sm {
  padding: 4px 8px;
  font-size: 12px;
}

.close-btn {
  font-size: 16px;
  padding: 2px 8px;
}

.settings-section {
  margin-bottom: 20px;
}

.settings-section:last-child {
  margin-bottom: 0;
}

.settings-section h5 {
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 8px;
  color: var(--text-muted);
}

.setting-item {
  margin-bottom: 10px;
}

.setting-item:last-child {
  margin-bottom: 0;
}

.setting-item label {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
  font-size: 12px;
}

.setting-label {
  color: var(--text-color, #333);
}

.setting-value {
  font-family: monospace;
  color: var(--text-muted, #666);
  font-size: 11px;
}

.setting-item input[type="range"] {
  width: 100%;
  height: 4px;
  border-radius: 2px;
  appearance: none;
  background: var(--border-color, #ddd);
  cursor: pointer;
}

.setting-item input[type="range"]::-webkit-slider-thumb {
  appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--primary-color, #42b883);
  cursor: pointer;
}

.checkbox-label {
  display: flex !important;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  justify-content: flex-start !important;
}

.checkbox-label input {
  cursor: pointer;
}

.color-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.color-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.color-picker {
  width: 28px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 4px;
  cursor: pointer;
  background: none;
}

.color-picker::-webkit-color-swatch-wrapper {
  padding: 2px;
}

.color-picker::-webkit-color-swatch {
  border-radius: 2px;
  border: none;
}

.color-type-label {
  font-size: 12px;
  color: var(--text-color, #333);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.setting-item select {
  width: 100%;
  padding: 4px 8px;
  font-size: 12px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: var(--radius-sm, 4px);
  background: var(--bg-color, #fff);
  color: var(--text-color, #333);
  cursor: pointer;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23666' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 8px center;
  padding-right: 28px;
}

.setting-item select:focus {
  outline: none;
  border-color: var(--color-primary, #42b883);
  box-shadow: var(--focus-ring);
}

.setting-hint {
  display: block;
  font-size: 10px;
  color: var(--text-muted, #888);
  margin-top: 2px;
  margin-left: 22px;
}
</style>
