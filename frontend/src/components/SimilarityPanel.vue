<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useSimilarityStore } from '@/stores/similarity'
import { useGraphStore } from '@/stores/graph'
import { Loader2 } from 'lucide-vue-next'
import type { SimilarityParamSpec } from '@/types/similarity'

const similarityStore = useSimilarityStore()
const graphStore = useGraphStore()

const showKeyPreview = ref(false)

onMounted(() => {
  similarityStore.fetchEndpoints()
})

const selectedEndpointSpec = computed(() =>
  similarityStore.availableEndpoints.find(ep => ep.name === similarityStore.selectedEndpoint)
)

/** Collect all property keys from nodes matching the selected type. */
const availableProperties = computed(() => {
  const nodes = similarityStore.selectedNodeType
    ? graphStore.filteredNodes.filter(n => n.node_type === similarityStore.selectedNodeType)
    : graphStore.filteredNodes
  const keys = new Set<string>()
  for (const node of nodes) {
    if (node.properties) {
      for (const k of Object.keys(node.properties)) {
        keys.add(k)
      }
    }
  }
  return Array.from(keys).sort()
})

const keyPreview = computed(() => {
  if (!showKeyPreview.value) return null
  return similarityStore.extractKeys()
})

function getParamValue(param: SimilarityParamSpec): unknown {
  return similarityStore.endpointParams[param.name] ?? param.default ?? ''
}

function setParamValue(param: SimilarityParamSpec, value: unknown) {
  similarityStore.endpointParams = {
    ...similarityStore.endpointParams,
    [param.name]: value,
  }
}

function onEndpointChange(name: string) {
  if (similarityStore.hasResults) {
    similarityStore.clearSimilarity()
  }
  similarityStore.selectedEndpoint = name || null
  similarityStore.endpointParams = {}
}
</script>

<template>
  <div class="similarity-panel">
    <!-- No endpoints registered -->
    <div v-if="similarityStore.availableEndpoints.length === 0" class="empty-state">
      <p>No similarity endpoints registered.</p>
      <small>Register endpoints via <code>similarity_endpoints</code> in <code>create_mountable_app()</code>.</small>
    </div>

    <template v-else>
      <!-- Compute Similarity Section -->
      <div class="section">
        <h4 class="section-title">Compute Similarity</h4>

        <!-- Endpoint selector -->
        <div class="form-row">
          <label for="sim-endpoint">Endpoint</label>
          <select
            id="sim-endpoint"
            :value="similarityStore.selectedEndpoint || ''"
            @change="onEndpointChange(($event.target as HTMLSelectElement).value)"
            class="form-select"
          >
            <option value="">Select endpoint...</option>
            <option v-for="ep in similarityStore.availableEndpoints" :key="ep.name" :value="ep.name">
              {{ ep.name }}
            </option>
          </select>
          <small v-if="selectedEndpointSpec" class="help-text">{{ selectedEndpointSpec.description }}</small>
        </div>

        <!-- Node type selector -->
        <div class="form-row">
          <label for="sim-node-type">Node Type</label>
          <select
            id="sim-node-type"
            v-model="similarityStore.selectedNodeType"
            class="form-select"
          >
            <option :value="null">All types</option>
            <option v-for="nt in graphStore.nodeTypes" :key="nt" :value="nt">{{ nt }}</option>
          </select>
        </div>

        <!-- Key property selector -->
        <div class="form-row">
          <label for="sim-key-prop">Key Property</label>
          <select
            id="sim-key-prop"
            v-model="similarityStore.keyProperty"
            class="form-select"
          >
            <option value="node_id">node_id</option>
            <option v-for="prop in availableProperties" :key="prop" :value="prop">{{ prop }}</option>
          </select>
        </div>

        <!-- JSON string option -->
        <div v-if="similarityStore.keyProperty !== 'node_id'" class="form-row">
          <label class="checkbox-label">
            <input type="checkbox" v-model="similarityStore.isJsonString" />
            <span>Value is JSON string</span>
          </label>
          <div v-if="similarityStore.isJsonString" class="json-path-row">
            <input
              v-model="similarityStore.jsonPath"
              type="text"
              class="form-input"
              placeholder="path.to.field"
            />
            <small class="help-text">Dot-separated path inside the parsed JSON</small>
          </div>
        </div>

        <!-- Preview extracted keys -->
        <div class="form-row">
          <button
            class="btn-preview"
            @click="showKeyPreview = !showKeyPreview"
          >
            {{ showKeyPreview ? 'Hide' : 'Preview' }} keys
          </button>
          <div v-if="keyPreview" class="key-preview">
            <div class="key-preview-header">
              <span>{{ keyPreview.keys.length }}/{{ keyPreview.total }} extracted</span>
              <span v-if="keyPreview.skipped > 0" class="skipped-warn">{{ keyPreview.skipped }} skipped</span>
            </div>
            <div class="key-preview-list">
              <span v-for="(k, i) in keyPreview.keys.slice(0, 20)" :key="i" class="key-chip">{{ k }}</span>
              <span v-if="keyPreview.keys.length > 20" class="key-chip key-chip-more">+{{ keyPreview.keys.length - 20 }} more</span>
            </div>
          </div>
        </div>

        <!-- Dynamic params -->
        <template v-if="selectedEndpointSpec && selectedEndpointSpec.params.length > 0">
          <div v-for="param in selectedEndpointSpec.params" :key="param.name" class="form-row">
            <label :for="'sim-param-' + param.name">
              {{ param.name }}
              <span v-if="param.required" class="required">*</span>
            </label>

            <!-- Choices: dropdown -->
            <select
              v-if="param.choices"
              :id="'sim-param-' + param.name"
              :value="getParamValue(param)"
              @change="setParamValue(param, ($event.target as HTMLSelectElement).value)"
              class="form-select"
            >
              <option v-for="c in param.choices" :key="c" :value="c">{{ c }}</option>
            </select>

            <!-- Bool: checkbox -->
            <label v-else-if="param.type === 'bool'" class="checkbox-label">
              <input
                type="checkbox"
                :checked="!!getParamValue(param)"
                @change="setParamValue(param, ($event.target as HTMLInputElement).checked)"
              />
              <span>{{ param.description || param.name }}</span>
            </label>

            <!-- Number: input -->
            <input
              v-else-if="param.type === 'int' || param.type === 'float'"
              :id="'sim-param-' + param.name"
              type="number"
              :step="param.type === 'float' ? '0.01' : '1'"
              :value="getParamValue(param)"
              @input="setParamValue(param, ($event.target as HTMLInputElement).value)"
              class="form-input"
            />

            <!-- String: text input -->
            <input
              v-else
              :id="'sim-param-' + param.name"
              type="text"
              :value="getParamValue(param)"
              @input="setParamValue(param, ($event.target as HTMLInputElement).value)"
              class="form-input"
            />

            <small v-if="param.description && param.type !== 'bool'" class="help-text">{{ param.description }}</small>
          </div>
        </template>

        <!-- Run button -->
        <div class="actions">
          <button
            class="btn-run"
            :disabled="similarityStore.computing || !similarityStore.selectedEndpoint"
            @click="similarityStore.runComputation()"
          >
            <Loader2 v-if="similarityStore.computing" :size="12" class="spin" />
            {{ similarityStore.computing ? 'Computing...' : 'Run' }}
          </button>
          <button
            v-if="similarityStore.hasResults"
            class="btn-clear"
            @click="similarityStore.clearSimilarity()"
          >
            Clear
          </button>
        </div>

        <!-- Error -->
        <div v-if="similarityStore.error" class="error-msg">
          {{ similarityStore.error }}
        </div>

        <!-- Results -->
        <div v-if="similarityStore.resultStats" class="result-stats">
          <span>{{ similarityStore.resultStats.edgeCount }} edges</span>
          <span>{{ similarityStore.resultStats.nodeCount }} nodes</span>
        </div>
      </div>

      <!-- Display Mode Section -->
      <div v-if="similarityStore.hasResults" class="section">
        <h4 class="section-title">Similarity Display</h4>
        <div class="radio-group">
          <label class="radio-label">
            <input type="radio" value="overlay" v-model="similarityStore.displayMode" />
            <span>Overlay</span>
          </label>
          <label class="radio-label">
            <input type="radio" value="exclusive" v-model="similarityStore.displayMode" />
            <span>Exclusive</span>
          </label>
          <label class="radio-label">
            <input type="radio" value="hidden" v-model="similarityStore.displayMode" />
            <span>Hidden</span>
          </label>
        </div>
      </div>

    </template>
  </div>
</template>

<style scoped>
.similarity-panel {
  padding: 8px 12px;
}

.empty-state {
  text-align: center;
  color: #999;
  padding: 16px 8px;
}

.empty-state code {
  font-size: 11px;
  background: #f0f0f0;
  padding: 1px 4px;
  border-radius: 3px;
}

.section {
  margin-bottom: 16px;
}

.section-title {
  font-size: 13px;
  font-weight: 600;
  margin: 0 0 8px;
  color: #333;
}

.form-row {
  margin-bottom: 8px;
}

.form-row > label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  margin-bottom: 3px;
  color: #555;
}

.form-select,
.form-input {
  width: 100%;
  padding: 5px 8px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 12px;
  background: white;
  box-sizing: border-box;
}

.form-select:focus,
.form-input:focus {
  border-color: #42b883;
  outline: none;
}

.help-text {
  display: block;
  font-size: 11px;
  color: #999;
  margin-top: 2px;
}

.required {
  color: #e74c3c;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  cursor: pointer;
}

.json-path-row {
  margin-top: 6px;
}

/* Key preview */
.btn-preview {
  padding: 4px 10px;
  background: #f5f5f5;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
  color: #555;
}

.btn-preview:hover {
  background: #eee;
}

.key-preview {
  margin-top: 6px;
  padding: 8px;
  background: #f9f9f9;
  border: 1px solid #eee;
  border-radius: 4px;
}

.key-preview-header {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: #666;
  margin-bottom: 6px;
}

.skipped-warn {
  color: #e67e22;
}

.key-preview-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.key-chip {
  padding: 2px 6px;
  background: #e8f5e9;
  border-radius: 3px;
  font-size: 11px;
  font-family: monospace;
  color: #333;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.key-chip-more {
  background: #eee;
  color: #999;
  font-family: inherit;
}

.actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.btn-run {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 14px;
  background: #42b883;
  color: white;
  border: none;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.2s;
}

.btn-run:hover:not(:disabled) {
  background: #38a373;
}

.btn-run:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-clear {
  padding: 6px 14px;
  background: #f5f5f5;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
}

.btn-clear:hover {
  background: #fee;
  border-color: #f44;
}

.error-msg {
  margin-top: 8px;
  padding: 6px 8px;
  background: #fff0f0;
  border: 1px solid #fcc;
  border-radius: 4px;
  font-size: 12px;
  color: #c00;
}

.result-stats {
  display: flex;
  gap: 12px;
  margin-top: 8px;
  font-size: 12px;
  color: #666;
}

.result-stats span {
  padding: 3px 8px;
  background: #f0f9f0;
  border-radius: 3px;
}

.radio-group {
  display: flex;
  gap: 12px;
}

.radio-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  cursor: pointer;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
