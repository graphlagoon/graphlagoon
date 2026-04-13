<script setup lang="ts">
import { ref } from 'vue';
import { useGraphStore } from '@/stores/graph';
import { useSimilarityStore } from '@/stores/similarity';
import { Play, Square, Flame, Shuffle, ChevronDown, ChevronRight, HelpCircle, X } from 'lucide-vue-next';

const graphStore = useGraphStore();
const similarityStore = useSimilarityStore();

// Help modal state
const showHelpModal = ref(false);
// Advanced mode toggle for 3D settings
const showAdvanced = ref(false);

const emit = defineEmits<{
  (e: 'start-layout'): void;
  (e: 'stop-layout'): void;
  (e: 'reheat-layout'): void;
  (e: 'scramble-layout'): void;
  (e: 'start-edge-type-layout', edgeType: string | null, strategy: string): void;
}>();

const props = defineProps<{
  isLayoutRunning: boolean;
}>();

function toggleLayout() {
  if (props.isLayoutRunning) {
    emit('stop-layout');
  } else {
    emit('start-layout');
  }
}
</script>

<template>
  <div class="layout-panel">
    <div class="panel-header">
      <h4>Layout</h4>
      <button
        class="help-btn"
        title="Help - Parameter explanations"
        @click="showHelpModal = true"
      ><HelpCircle :size="14" /></button>
    </div>

    <div class="fa2-controls">
        <button
          class="run-btn"
          :class="{ running: isLayoutRunning }"
          @click="toggleLayout"
        >
          <Square v-if="isLayoutRunning" :size="13" /> <Play v-else :size="13" />
          {{ isLayoutRunning ? 'Stop' : 'Run' }}
        </button>
        <button
          class="apply-btn"
          @click="$emit('reheat-layout')"
          title="Reheat simulation"
        >
          <Flame :size="13" /> Reheat
        </button>
        <button
          class="apply-btn"
          @click="$emit('scramble-layout')"
          title="Scramble node positions"
        >
          <Shuffle :size="13" /> Scramble
        </button>
      </div>

      <div class="settings-divider"></div>

      <!-- Basic controls with friendly names -->
      <div class="settings-group">
        <div class="setting-item">
          <label>
            <span class="setting-label">Repulsion</span>
            <span class="setting-value">{{ graphStore.force3DSettings.d3ChargeStrength }}</span>
          </label>
          <input
            type="range"
            min="-500"
            max="-1"
            step="1"
            :value="graphStore.force3DSettings.d3ChargeStrength"
            @input="graphStore.updateForce3DSettings({ d3ChargeStrength: parseFloat(($event.target as HTMLInputElement).value) })"
          />
        </div>

        <div class="setting-item">
          <label>
            <span class="setting-label">Link Distance</span>
            <span class="setting-value">{{ graphStore.force3DSettings.d3LinkDistance }}</span>
          </label>
          <input
            type="range"
            min="5"
            max="200"
            step="1"
            :value="graphStore.force3DSettings.d3LinkDistance"
            @input="graphStore.updateForce3DSettings({ d3LinkDistance: parseFloat(($event.target as HTMLInputElement).value) })"
          />
        </div>

        <div class="setting-item">
          <label>
            <span class="setting-label">Gravity</span>
            <span class="setting-value">{{ graphStore.force3DSettings.d3GravityStrength.toFixed(2) }}</span>
          </label>
          <input
            type="range"
            min="0"
            max="0.3"
            step="0.01"
            :value="graphStore.force3DSettings.d3GravityStrength"
            @input="graphStore.updateForce3DSettings({ d3GravityStrength: parseFloat(($event.target as HTMLInputElement).value) })"
          />
        </div>

        <label class="checkbox-item">
          <input
            type="checkbox"
            :checked="graphStore.force3DSettings.d3CollideEnabled"
            @change="graphStore.updateForce3DSettings({ d3CollideEnabled: ($event.target as HTMLInputElement).checked })"
          />
          <span>Avoid Overlap</span>
        </label>

        <template v-if="graphStore.force3DSettings.d3CollideEnabled">
          <div class="setting-item">
            <label>
              <span class="setting-label">Min. Collision Radius</span>
              <span class="setting-value">{{ graphStore.force3DSettings.d3CollideRadius }}</span>
            </label>
            <input
              type="range"
              min="1"
              max="50"
              step="1"
              :value="graphStore.force3DSettings.d3CollideRadius"
              @input="graphStore.updateForce3DSettings({ d3CollideRadius: parseFloat(($event.target as HTMLInputElement).value) })"
            />
          </div>
        </template>

        <!-- Blower + Clipping Plane moved to BehaviorPanel (they are behaviors, not layout) -->
      </div>

      <div class="settings-divider"></div>

      <!-- Execution controls with friendly names -->
      <div class="settings-group">
        <div class="setting-item">
          <label>
            <span class="setting-label">Layout Iterations</span>
            <span class="setting-value">{{ graphStore.layoutExecution.cooldownTicks }}</span>
          </label>
          <span class="setting-hint">How many iterations the simulation runs before stopping</span>
          <input
            type="range"
            min="50"
            max="2000"
            step="50"
            :value="graphStore.layoutExecution.cooldownTicks"
            @input="graphStore.updateLayoutExecution({ cooldownTicks: parseInt(($event.target as HTMLInputElement).value) })"
          />
        </div>

        <div class="setting-item">
          <label>
            <span class="setting-label">Simulation Speed</span>
            <span class="setting-value">{{ graphStore.layoutExecution.ticksPerFrame }}</span>
          </label>
          <span class="setting-hint">Calculations per frame — higher = converges faster</span>
          <input
            type="range"
            min="1"
            max="100"
            step="5"
            :value="graphStore.layoutExecution.ticksPerFrame"
            @input="graphStore.updateLayoutExecution({ ticksPerFrame: parseInt(($event.target as HTMLInputElement).value) })"
          />
        </div>

        <div class="setting-item">
          <label>
            <span class="setting-label">Pre-computation</span>
            <span class="setting-value">{{ graphStore.layoutExecution.warmupTicks }}</span>
          </label>
          <span class="setting-hint">Iterations before display — organizes the graph without rendering</span>
          <input
            type="range"
            min="0"
            max="500"
            step="10"
            :value="graphStore.layoutExecution.warmupTicks"
            @input="graphStore.updateLayoutExecution({ warmupTicks: parseInt(($event.target as HTMLInputElement).value) })"
          />
        </div>
      </div>

      <div class="settings-divider"></div>

      <!-- Layout by Edge Type -->
      <div class="settings-group">
        <p class="settings-group-title">Layout by Edge Type</p>

        <div class="setting-item">
          <label>
            <span class="setting-label">Edge Type</span>
          </label>
          <select
            v-model="similarityStore.layoutEdgeType"
            class="setting-select"
          >
            <option :value="null">All edges (default)</option>
            <option v-for="et in graphStore.edgeTypes" :key="et" :value="et">{{ et }}</option>
          </select>
        </div>

        <div class="setting-item">
          <label>
            <span class="setting-label">Strategy</span>
          </label>
          <select
            v-model="similarityStore.layoutStrategy"
            class="setting-select"
          >
            <option value="fix-then-recompute">Fix then recompute</option>
            <option value="unified">Full simulation, selected links only</option>
            <option value="selected-only">Selected only layout</option>
          </select>
        </div>

        <button
          class="apply-btn"
          :disabled="!similarityStore.layoutEdgeType"
          @click="emit('start-edge-type-layout', similarityStore.layoutEdgeType, similarityStore.layoutStrategy)"
        >
          <Play :size="13" /> Apply Edge Layout
        </button>
      </div>

      <div class="settings-divider"></div>

      <!-- Advanced toggle -->
      <div class="advanced-toggle" @click="showAdvanced = !showAdvanced">
        <ChevronDown v-if="showAdvanced" :size="12" class="toggle-icon" />
        <ChevronRight v-else :size="12" class="toggle-icon" />
        <span class="advanced-label">Advanced</span>
      </div>

      <!-- Advanced settings -->
      <template v-if="showAdvanced">
        <div class="settings-group">
          <p class="settings-group-title">Simulation</p>

          <div class="setting-item">
            <label>
              <span class="setting-label">Alpha Decay</span>
              <span class="setting-value">{{ graphStore.force3DSettings.d3AlphaDecay.toFixed(4) }}</span>
            </label>
            <input
              type="range"
              min="0.001"
              max="0.1"
              step="0.001"
              :value="graphStore.force3DSettings.d3AlphaDecay"
              @input="graphStore.updateForce3DSettings({ d3AlphaDecay: parseFloat(($event.target as HTMLInputElement).value) })"
            />
          </div>

          <div class="setting-item">
            <label>
              <span class="setting-label">Velocity Decay</span>
              <span class="setting-value">{{ graphStore.force3DSettings.d3VelocityDecay.toFixed(2) }}</span>
            </label>
            <input
              type="range"
              min="0.1"
              max="0.9"
              step="0.05"
              :value="graphStore.force3DSettings.d3VelocityDecay"
              @input="graphStore.updateForce3DSettings({ d3VelocityDecay: parseFloat(($event.target as HTMLInputElement).value) })"
            />
          </div>

          <div class="setting-item">
            <label>
              <span class="setting-label">Alpha Min</span>
              <span class="setting-value">{{ graphStore.force3DSettings.d3AlphaMin.toFixed(4) }}</span>
            </label>
            <input
              type="range"
              min="0.0001"
              max="0.01"
              step="0.0001"
              :value="graphStore.force3DSettings.d3AlphaMin"
              @input="graphStore.updateForce3DSettings({ d3AlphaMin: parseFloat(($event.target as HTMLInputElement).value) })"
            />
          </div>

          <div class="setting-item">
            <label>
              <span class="setting-label">Alpha Target</span>
              <span class="setting-value">{{ graphStore.force3DSettings.d3AlphaTarget.toFixed(2) }}</span>
            </label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              :value="graphStore.force3DSettings.d3AlphaTarget"
              @input="graphStore.updateForce3DSettings({ d3AlphaTarget: parseFloat(($event.target as HTMLInputElement).value) })"
            />
          </div>
        </div>

        <div class="settings-divider"></div>

        <div class="settings-group">
          <p class="settings-group-title">Charge Force (manyBody)</p>

          <div class="setting-item">
            <label>
              <span class="setting-label">Theta (Barnes-Hut)</span>
              <span class="setting-value">{{ graphStore.force3DSettings.d3Theta.toFixed(2) }}</span>
            </label>
            <input
              type="range"
              min="0.1"
              max="2"
              step="0.05"
              :value="graphStore.force3DSettings.d3Theta"
              @input="graphStore.updateForce3DSettings({ d3Theta: parseFloat(($event.target as HTMLInputElement).value) })"
            />
          </div>

          <div class="setting-item">
            <label>
              <span class="setting-label">Distance Min</span>
              <span class="setting-value">{{ graphStore.force3DSettings.d3DistanceMin }}</span>
            </label>
            <input
              type="range"
              min="1"
              max="50"
              step="1"
              :value="graphStore.force3DSettings.d3DistanceMin"
              @input="graphStore.updateForce3DSettings({ d3DistanceMin: parseFloat(($event.target as HTMLInputElement).value) })"
            />
          </div>

          <div class="setting-item">
            <label>
              <span class="setting-label">Distance Max</span>
              <span class="setting-value">{{ graphStore.force3DSettings.d3DistanceMax === Infinity ? '∞' : graphStore.force3DSettings.d3DistanceMax }}</span>
            </label>
            <input
              type="range"
              min="100"
              max="2000"
              step="50"
              :value="graphStore.force3DSettings.d3DistanceMax === Infinity ? 2000 : graphStore.force3DSettings.d3DistanceMax"
              @input="graphStore.updateForce3DSettings({ d3DistanceMax: parseFloat(($event.target as HTMLInputElement).value) >= 2000 ? Infinity : parseFloat(($event.target as HTMLInputElement).value) })"
            />
          </div>
        </div>

        <div class="settings-divider"></div>

        <div class="settings-group">
          <p class="settings-group-title">Collide Force</p>

          <div class="setting-item">
            <label>
              <span class="setting-label">Strength</span>
              <span class="setting-value">{{ graphStore.force3DSettings.d3CollideStrength.toFixed(2) }}</span>
            </label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              :value="graphStore.force3DSettings.d3CollideStrength"
              @input="graphStore.updateForce3DSettings({ d3CollideStrength: parseFloat(($event.target as HTMLInputElement).value) })"
            />
          </div>

          <div class="setting-item">
            <label>
              <span class="setting-label">Iterations</span>
              <span class="setting-value">{{ graphStore.force3DSettings.d3CollideIterations }}</span>
            </label>
            <input
              type="range"
              min="1"
              max="10"
              step="1"
              :value="graphStore.force3DSettings.d3CollideIterations"
              @input="graphStore.updateForce3DSettings({ d3CollideIterations: parseFloat(($event.target as HTMLInputElement).value) })"
            />
          </div>
        </div>
      </template>

    <!-- Help Modal for 3D Layout Parameters -->
    <Teleport to="body">
      <div v-if="showHelpModal" class="modal-overlay" @click.self="showHelpModal = false">
        <div class="modal-content">
          <div class="modal-header">
            <h3>D3-Force 3D Layout Parameters</h3>
            <button class="modal-close" aria-label="Close" @click="showHelpModal = false"><X :size="16" /></button>
          </div>
          <div class="modal-body">
            <p class="modal-intro">
              The force-directed layout simulates physical forces between nodes to create organic visualizations.
              In <strong>fraud and credit</strong> graphs, this helps identify clusters of related entities,
              structural anomalies, and suspicious connection patterns.
            </p>

            <div class="param-section">
              <h4>Simulation Parameters</h4>

              <div class="param-item">
                <span class="param-name">Charge Strength</span>
                <p>Repulsion force between nodes. More negative values = stronger repulsion.</p>
                <p class="param-use"><strong>Fraud/Credit:</strong> High values (-200 to -500) better separate distinct clusters, making it easier to identify groups of related accounts or isolated fraud networks.</p>
              </div>

              <div class="param-item">
                <span class="param-name">Link Distance</span>
                <p>Target distance between connected nodes.</p>
                <p class="param-use"><strong>Fraud/Credit:</strong> Shorter distances group strongly connected entities (e.g., account-holder-address), while longer distances reveal the overall network structure.</p>
              </div>

              <div class="param-item">
                <span class="param-name">Alpha Decay</span>
                <p>Simulation cooling rate. Lower = converges slower but with better quality.</p>
                <p class="param-use"><strong>Fraud/Credit:</strong> For complex graphs with many cross-connections, low values (0.01-0.02) allow better community separation.</p>
              </div>

              <div class="param-item">
                <span class="param-name">Velocity Decay</span>
                <p>Friction applied to nodes. Higher = smoother and more controlled movement.</p>
                <p class="param-use"><strong>Fraud/Credit:</strong> High values (0.4-0.6) stabilize the visualization faster, useful for interactive analysis.</p>
              </div>

              <div class="param-item">
                <span class="param-name">Alpha Min</span>
                <p>Threshold to stop the simulation. Lower = runs longer.</p>
                <p class="param-use"><strong>Fraud/Credit:</strong> For large graphs, higher values (0.005) save time; for detailed analysis, lower values (0.0001) yield a more refined layout.</p>
              </div>

              <div class="param-item">
                <span class="param-name">Alpha Target</span>
                <p>Target alpha. If > 0, the simulation never fully stops.</p>
                <p class="param-use"><strong>Fraud/Credit:</strong> Use 0 for static layouts. Small values (0.01-0.05) keep the graph "alive" for continuous exploration.</p>
              </div>
            </div>

            <div class="param-section">
              <h4>Charge Force (manyBody)</h4>

              <div class="param-item">
                <span class="param-name">Theta (Barnes-Hut)</span>
                <p>Approximation for force calculation. Higher = faster but less accurate.</p>
                <p class="param-use"><strong>Fraud/Credit:</strong> For large graphs (>1000 nodes), high theta (1.0-1.5) improves performance. For accuracy in smaller graphs, use 0.5-0.8.</p>
              </div>

              <div class="param-item">
                <span class="param-name">Distance Min</span>
                <p>Minimum distance to apply repulsion. Prevents extreme forces when nodes are very close.</p>
                <p class="param-use"><strong>Fraud/Credit:</strong> Low values (1-5) allow nodes to stay close in dense clusters; high values (10-20) force more separation.</p>
              </div>

              <div class="param-item">
                <span class="param-name">Distance Max</span>
                <p>Maximum distance to apply repulsion. Beyond this, nodes do not repel each other.</p>
                <p class="param-use"><strong>Fraud/Credit:</strong> Limiting (500-1000) can create more compact clusters. Infinity (∞) maintains global repulsion, better separating distant communities.</p>
              </div>
            </div>

            <div class="param-section">
              <h4>Collide Force</h4>

              <div class="param-item">
                <span class="param-name">Enable Collision</span>
                <p>Enables collision detection to prevent node overlap.</p>
                <p class="param-use"><strong>Fraud/Credit:</strong> Essential when nodes have different sizes (e.g., based on transaction volume). Ensures that large nodes don't hide smaller ones.</p>
              </div>

              <div class="param-item">
                <span class="param-name">Radius</span>
                <p>Base collision radius for each node.</p>
                <p class="param-use"><strong>Fraud/Credit:</strong> Adjust to be slightly larger than the visual node size. If nodes have size 5, use radius 6-8 to prevent overlap.</p>
              </div>

              <div class="param-item">
                <span class="param-name">Strength</span>
                <p>Repulsion force when nodes collide (0-1).</p>
                <p class="param-use"><strong>Fraud/Credit:</strong> High values (0.7-1.0) ensure clear separation; low values (0.3-0.5) allow some overlap for more compact layouts.</p>
              </div>

              <div class="param-item">
                <span class="param-name">Iterations</span>
                <p>Collision resolution iterations per tick. More = more accurate but slower.</p>
                <p class="param-use"><strong>Fraud/Credit:</strong> For dense graphs with heavy overlap, increase to 3-5. For sparse graphs, 1 is sufficient.</p>
              </div>
            </div>

            <div class="param-section tips">
              <h4>Tips for Fraud Analysis</h4>
              <ul>
                <li><strong>Identify clusters:</strong> Use high charge strength (-300) + low link distance (20) to group related entities.</li>
                <li><strong>Find anomalies:</strong> Nodes with many connections (hubs) often indicate central accounts in fraud schemes.</li>
                <li><strong>View overall structure:</strong> Limited distance max groups communities; infinity reveals relationships between distant communities.</li>
                <li><strong>Size analysis:</strong> Enable collision when nodes have sizes based on metrics (e.g., transaction volume) to ensure visibility.</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.layout-panel {
  padding: 12px;
  background: var(--card-background, white);
  border: 1px solid var(--border-color, #ddd);
  border-radius: 8px;
  min-width: 200px;
  max-width: 240px;
  max-height: calc(100vh - 150px);
  overflow-y: auto;
  scrollbar-gutter: stable;
}

.panel-header {
  margin-bottom: 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.panel-header h4 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-color, #333);
}

.help-btn {
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 50%;
  background: var(--card-background, white);
  color: var(--text-muted, #666);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}

.help-btn:hover {
  background: var(--primary-color, #42b883);
  color: white;
  border-color: var(--primary-color, #42b883);
}

.layout-selector {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 12px;
}

.layout-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: transparent;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  text-align: left;
  transition: all 0.15s;
}

.layout-option:hover {
  background: var(--bg-secondary, #f5f5f5);
}

.layout-option.active {
  background: var(--primary-color, #42b883);
  color: white;
  border-color: var(--primary-color, #42b883);
}

.layout-icon {
  font-size: 14px;
}

.layout-label {
  flex: 1;
}

.fa2-controls {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.run-btn,
.apply-btn {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  transition: all 0.15s;
  background: var(--card-background, white);
}

.run-btn:hover,
.apply-btn:hover:not(:disabled) {
  background: var(--bg-secondary, #f0f0f0);
}

.run-btn.running {
  background: var(--danger-color, #ff6b6b);
  color: white;
  border-color: var(--danger-color, #ff6b6b);
}

.apply-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.settings-divider {
  height: 1px;
  background: var(--border-color, #ddd);
  margin: 12px 0;
}

.settings-group {
  margin-bottom: 12px;
}

.settings-group:last-child {
  margin-bottom: 0;
}

.settings-group-title {
  margin: 0 0 8px 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted, #666);
  text-transform: uppercase;
  letter-spacing: 0.5px;
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
  font-size: 11px;
}

.setting-label {
  color: var(--text-muted, #666);
}

.setting-value {
  font-family: monospace;
  color: var(--text-color, #333);
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

.settings-group.checkboxes {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.checkbox-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  cursor: pointer;
  color: var(--text-color, #333);
}

.checkbox-item input {
  cursor: pointer;
}

.setting-select {
  width: 100%;
  padding: 6px 8px;
  font-size: 11px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 4px;
  background: var(--card-background, white);
  cursor: pointer;
}

.setting-select:focus {
  outline: none;
  border-color: var(--primary-color, #42b883);
}

.setting-input {
  width: 100%;
  padding: 6px 8px;
  font-size: 11px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 4px;
  background: var(--card-background, white);
}

.setting-input:focus {
  outline: none;
  border-color: var(--primary-color, #42b883);
}

.setting-hint {
  display: block;
  font-size: 10px;
  color: var(--text-muted, #999);
  margin-top: 4px;
}

.mode-info {
  margin-bottom: 12px;
}

.mode-badge {
  display: inline-block;
  padding: 4px 8px;
  background: var(--primary-color, #42b883);
  color: white;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
}

.layout-help {
  font-size: 11px;
  color: var(--text-muted, #666);
  margin: 12px 0 0 0;
  line-height: 1.4;
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

/* Modal styles */
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 1000;
}

.modal-content {
  background: var(--card-background, white);
  border-radius: 12px;
  max-width: 600px;
  max-height: 80vh;
  width: 90%;
  overflow: hidden;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color, #ddd);
  background: var(--bg-secondary, #f5f5f5);
}

.modal-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-color, #333);
}

.modal-close {
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  background: transparent;
  font-size: 24px;
  color: var(--text-muted, #666);
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.15s;
}

.modal-close:hover {
  background: var(--danger-color, #ff6b6b);
  color: white;
}

.modal-body {
  padding: 20px;
  overflow-y: auto;
  max-height: calc(80vh - 60px);
}

.modal-intro {
  margin: 0 0 20px 0;
  padding: 12px;
  background: var(--bg-secondary, #f5f5f5);
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-color, #333);
}

.param-section {
  margin-bottom: 24px;
}

.param-section:last-child {
  margin-bottom: 0;
}

.param-section h4 {
  margin: 0 0 12px 0;
  padding-bottom: 8px;
  border-bottom: 2px solid var(--primary-color, #42b883);
  font-size: 14px;
  font-weight: 600;
  color: var(--primary-color, #42b883);
}

.param-item {
  margin-bottom: 16px;
  padding: 12px;
  background: var(--bg-secondary, #f9f9f9);
  border-radius: 6px;
  border-left: 3px solid var(--border-color, #ddd);
}

.param-item:last-child {
  margin-bottom: 0;
}

.param-name {
  display: block;
  font-weight: 600;
  font-size: 13px;
  color: var(--text-color, #333);
  margin-bottom: 4px;
}

.param-item p {
  margin: 4px 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--text-muted, #666);
}

.param-use {
  margin-top: 8px !important;
  padding-top: 8px;
  border-top: 1px dashed var(--border-color, #ddd);
  color: var(--text-color, #444) !important;
}

.param-section.tips {
  background: linear-gradient(135deg, rgba(66, 184, 131, 0.1), rgba(66, 184, 131, 0.05));
  padding: 16px;
  border-radius: 8px;
}

.param-section.tips h4 {
  border-bottom-color: var(--primary-color, #42b883);
}

.param-section.tips ul {
  margin: 0;
  padding-left: 20px;
}

.param-section.tips li {
  margin-bottom: 8px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-color, #333);
}

.param-section.tips li:last-child {
  margin-bottom: 0;
}
</style>
