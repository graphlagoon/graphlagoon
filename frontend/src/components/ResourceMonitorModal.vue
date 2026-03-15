<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue';
import { useMetricsStore } from '@/stores/metrics';
import { getMetricsCalculator } from '@/services/metricsCalculator';
import { X } from 'lucide-vue-next';

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const metricsStore = useMetricsStore();
const calculator = getMetricsCalculator();

// Update config
const maxWorkers = ref(metricsStore.workerPoolConfig.maxWorkers);
const maxMemoryMB = ref(metricsStore.workerPoolConfig.maxMemoryMB);

// Resource metrics
const resourceMetrics = computed(() => metricsStore.resourceMetrics);
const computationHistory = computed(() => metricsStore.computationHistory);

// Hardware info
const availableCores = computed(() => window.navigator?.hardwareConcurrency || 8);

// Format memory
function formatMB(mb: number | null): string {
  if (mb === null) return 'N/A';
  return `${mb.toFixed(0)} MB`;
}

// Format time
function formatTime(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

// Format date
function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString();
}

// Apply config changes
function applyConfig() {
  calculator.updateWorkerPoolConfig(maxWorkers.value, maxMemoryMB.value);
}

// Clear history
function clearHistory() {
  metricsStore.clearHistory();
}

// Refresh interval
let refreshInterval: number | null = null;

onMounted(() => {
  refreshInterval = window.setInterval(() => {
    calculator.refreshResourceMetrics();
  }, 500);
});

onUnmounted(() => {
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }
});
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-header">
        <h3>Resource Monitor</h3>
        <button class="close-btn btn-icon-only" aria-label="Close" @click="emit('close')"><X :size="16" /></button>
      </div>

      <div class="modal-content">
        <!-- Current Resources -->
        <div class="section">
          <h4>Current Resources</h4>
          <div class="resource-grid">
            <div class="resource-item">
              <span class="resource-label">Active Workers</span>
              <span class="resource-value">
                {{ resourceMetrics.activeWorkers }} / {{ resourceMetrics.maxWorkers }}
              </span>
            </div>
            <div class="resource-item">
              <span class="resource-label">Queued Tasks</span>
              <span class="resource-value">{{ resourceMetrics.queuedTasks }}</span>
            </div>
            <div class="resource-item">
              <span class="resource-label">Heap Used</span>
              <span class="resource-value">
                {{ formatMB(resourceMetrics.memory.usedHeapMB) }}
              </span>
            </div>
            <div class="resource-item">
              <span class="resource-label">Heap Total</span>
              <span class="resource-value">
                {{ formatMB(resourceMetrics.memory.totalHeapMB) }}
              </span>
            </div>
            <div class="resource-item">
              <span class="resource-label">Heap Limit</span>
              <span class="resource-value">
                {{ formatMB(resourceMetrics.memory.heapLimitMB) }}
              </span>
            </div>
          </div>

          <!-- Memory Bar -->
          <div v-if="resourceMetrics.memory.usedHeapMB !== null" class="memory-bar-container">
            <div class="memory-bar">
              <div
                class="memory-fill"
                :style="{
                  width: `${(resourceMetrics.memory.usedHeapMB / (resourceMetrics.memory.heapLimitMB || 1)) * 100}%`
                }"
                :class="{
                  warning: (resourceMetrics.memory.usedHeapMB / (resourceMetrics.memory.heapLimitMB || 1)) > 0.7,
                  danger: (resourceMetrics.memory.usedHeapMB / (resourceMetrics.memory.heapLimitMB || 1)) > 0.9
                }"
              ></div>
            </div>
            <span class="memory-percentage">
              {{ Math.round((resourceMetrics.memory.usedHeapMB / (resourceMetrics.memory.heapLimitMB || 1)) * 100) }}%
            </span>
          </div>
          <div v-else class="no-memory-api">
            Memory API not available in this browser
          </div>
        </div>

        <!-- Active Computations -->
        <div v-if="resourceMetrics.computations.length > 0" class="section">
          <h4>Active Computations</h4>
          <div class="computation-list">
            <div
              v-for="comp in resourceMetrics.computations"
              :key="comp.id"
              class="computation-row"
            >
              <div class="comp-info">
                <span class="comp-name">{{ comp.name }}</span>
                <span class="comp-status" :class="comp.status">{{ comp.status }}</span>
              </div>
              <div class="comp-progress">
                <div class="progress-bar">
                  <div
                    class="progress-fill"
                    :style="{ width: `${comp.progress}%` }"
                  ></div>
                </div>
                <span class="progress-text">{{ Math.round(comp.progress) }}%</span>
              </div>
              <div class="comp-stats">
                <span v-if="comp.speed">{{ comp.speed.toFixed(1) }} {{ comp.speedUnit }}</span>
                <span>{{ formatTime(comp.elapsedMs) }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Worker Configuration -->
        <div class="section">
          <h4>Worker Configuration</h4>
          <div class="config-form">
            <div class="form-group">
              <label>Max Workers</label>
              <div class="input-with-hint">
                <input
                  type="number"
                  v-model.number="maxWorkers"
                  min="1"
                  :max="availableCores"
                  class="form-input"
                />
                <span class="hint">Available cores: {{ availableCores }}</span>
              </div>
            </div>
            <div class="form-group">
              <label>Max Memory (MB)</label>
              <div class="input-with-hint">
                <input
                  type="number"
                  v-model.number="maxMemoryMB"
                  min="128"
                  max="4096"
                  step="128"
                  class="form-input"
                />
                <span class="hint">Limit new workers when exceeded</span>
              </div>
            </div>
            <button class="apply-btn" @click="applyConfig">
              Apply Configuration
            </button>
          </div>
        </div>

        <!-- Computation History -->
        <div class="section">
          <div class="section-header">
            <h4>Computation History</h4>
            <button
              v-if="computationHistory.length > 0"
              class="clear-btn"
              @click="clearHistory"
            >
              Clear
            </button>
          </div>
          <div v-if="computationHistory.length > 0" class="history-list">
            <div
              v-for="entry in computationHistory"
              :key="entry.id"
              class="history-row"
            >
              <div class="history-info">
                <span class="history-name">{{ entry.name }}</span>
                <span class="history-status" :class="entry.status">
                  {{ entry.status }}
                </span>
              </div>
              <div class="history-meta">
                <span>{{ formatTime(entry.elapsedMs) }}</span>
                <span>{{ formatDate(entry.completedAt) }}</span>
              </div>
              <div v-if="entry.errorMessage" class="history-error">
                {{ entry.errorMessage }}
              </div>
            </div>
          </div>
          <div v-else class="empty-history">
            No computation history
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal {
  background: var(--card-background, white);
  border-radius: 12px;
  width: 90%;
  max-width: 600px;
  max-height: 80vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color, #ddd);
}

.modal-header h3 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}

.close-btn {
  background: none;
  border: none;
  font-size: 24px;
  cursor: pointer;
  color: var(--text-muted, #666);
  padding: 0;
  line-height: 1;
}

.close-btn:hover {
  color: var(--text-color, #333);
}

.modal-content {
  padding: 20px;
  overflow-y: auto;
}

.section {
  margin-bottom: 24px;
}

.section:last-child {
  margin-bottom: 0;
}

.section h4 {
  margin: 0 0 12px 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-color, #333);
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.section-header h4 {
  margin: 0;
}

/* Resource Grid */
.resource-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 12px;
  margin-bottom: 12px;
}

.resource-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px;
  background: var(--bg-secondary, #f8f8f8);
  border-radius: 6px;
}

.resource-label {
  font-size: 11px;
  color: var(--text-muted, #666);
}

.resource-value {
  font-size: 16px;
  font-weight: 600;
  font-family: monospace;
}

/* Memory Bar */
.memory-bar-container {
  display: flex;
  align-items: center;
  gap: 12px;
}

.memory-bar {
  flex: 1;
  height: 8px;
  background: var(--border-color, #ddd);
  border-radius: 4px;
  overflow: hidden;
}

.memory-fill {
  height: 100%;
  background: var(--primary-color, #42b883);
  transition: width 0.3s;
}

.memory-fill.warning {
  background: var(--warning-color, #ffc107);
}

.memory-fill.danger {
  background: var(--danger-color, #dc3545);
}

.memory-percentage {
  font-size: 12px;
  font-weight: 500;
  min-width: 40px;
  text-align: right;
}

.no-memory-api {
  font-size: 12px;
  color: var(--text-muted, #666);
  font-style: italic;
  padding: 8px;
  background: var(--bg-secondary, #f8f8f8);
  border-radius: 4px;
}

/* Computation List */
.computation-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.computation-row {
  padding: 10px;
  background: var(--bg-secondary, #f8f8f8);
  border-radius: 6px;
}

.comp-info {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.comp-name {
  font-size: 13px;
  font-weight: 500;
}

.comp-status {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 3px;
  text-transform: uppercase;
}

.comp-status.running {
  background: var(--primary-color, #42b883);
  color: white;
}

.comp-status.paused {
  background: var(--warning-color, #ffc107);
  color: #333;
}

.comp-status.queued {
  background: var(--border-color, #ddd);
}

.comp-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.comp-progress .progress-bar {
  flex: 1;
  height: 4px;
  background: var(--border-color, #ddd);
  border-radius: 2px;
  overflow: hidden;
}

.comp-progress .progress-fill {
  height: 100%;
  background: var(--primary-color, #42b883);
}

.progress-text {
  font-size: 11px;
  font-weight: 500;
  min-width: 35px;
  text-align: right;
}

.comp-stats {
  display: flex;
  gap: 16px;
  font-size: 11px;
  color: var(--text-muted, #666);
}

/* Config Form */
.config-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.form-group label {
  font-size: 12px;
  color: var(--text-muted, #666);
}

.input-with-hint {
  display: flex;
  align-items: center;
  gap: 12px;
}

.form-input {
  width: 120px;
  padding: 8px 10px;
  font-size: 13px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
}

.hint {
  font-size: 11px;
  color: var(--text-muted, #999);
}

.apply-btn {
  align-self: flex-start;
  padding: 8px 16px;
  background: var(--primary-color, #42b883);
  color: white;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}

.apply-btn:hover {
  background: var(--primary-dark, #3aa876);
}

/* History */
.clear-btn {
  padding: 4px 10px;
  background: transparent;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
  color: var(--text-muted, #666);
}

.clear-btn:hover {
  background: var(--bg-secondary, #f5f5f5);
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 200px;
  overflow-y: auto;
}

.history-row {
  padding: 8px 10px;
  background: var(--bg-secondary, #f8f8f8);
  border-radius: 4px;
}

.history-info {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}

.history-name {
  font-size: 12px;
  font-weight: 500;
}

.history-status {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 3px;
  text-transform: uppercase;
}

.history-status.completed {
  background: #d4edda;
  color: #155724;
}

.history-status.cancelled {
  background: var(--border-color, #ddd);
  color: var(--text-muted, #666);
}

.history-status.error {
  background: #f8d7da;
  color: #721c24;
}

.history-meta {
  display: flex;
  gap: 16px;
  font-size: 11px;
  color: var(--text-muted, #666);
}

.history-error {
  margin-top: 4px;
  padding: 4px 8px;
  background: #f8d7da;
  color: #721c24;
  border-radius: 3px;
  font-size: 11px;
}

.empty-history {
  font-size: 12px;
  color: var(--text-muted, #666);
  font-style: italic;
  padding: 12px;
  text-align: center;
  background: var(--bg-secondary, #f8f8f8);
  border-radius: 6px;
}
</style>
