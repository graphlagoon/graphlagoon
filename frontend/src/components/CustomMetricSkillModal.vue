<template>
  <Teleport to="body">
    <div v-if="modelValue" class="modal-overlay" @click.self="close">
      <div class="modal-container" data-testid="custom-metric-skill-modal">
        <div class="modal-header">
          <h2>{{ importedJson?.trim() ? 'Ask an AI to adapt these metrics to this graph' : 'Ask an AI to write a custom metric' }}</h2>
          <button class="close-btn" @click="close" title="Close">
            <X :size="20" />
          </button>
        </div>

        <div class="modal-content">
          <p v-if="importedJson?.trim()" class="intro">
            The pasted metrics come from a different graph. Copy the text below
            into any AI assistant: it lists the old and the new schema and asks
            the AI to rewrite the property and metric references for this
            graph, answering with JSON you paste back into the Import box.
          </p>
          <p v-else class="intro">
            Not sure how to write a custom metric? Copy the text below and paste it
            into any AI assistant (ChatGPT, Claude, etc.), then describe the value
            you want per node or edge. It already includes this graph's types,
            properties and available metrics, the exact <code>item</code> /
            <code>ctx</code> contract, the sandbox rules and worked examples. The
            AI answers with a JSON block whose fields map onto the editor.
          </p>

          <div class="skill-toolbar">
            <button class="copy-btn" data-testid="custom-metric-skill-copy" @click="copy">
              <component :is="copied ? Check : Copy" :size="14" />
              {{ copied ? 'Copied!' : 'Copy to clipboard' }}
            </button>
          </div>

          <pre class="skill-text" data-testid="custom-metric-skill-text">{{ skillText }}</pre>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { X, Copy, Check } from 'lucide-vue-next'
import { useGraphStore } from '@/stores/graph'
import { useMetricsStore } from '@/stores/metrics'
import { useCommunityStore } from '@/stores/community'
import { useCustomMetricsStore } from '@/stores/customMetrics'
import { buildSourceSchema } from '@/utils/portableExport'
import { buildCustomMetricSkill } from '@/utils/customMetricSkill'
import { isCustomMetricId } from '@/types/customMetrics'
import type { PortableSourceSchema } from '@/types/portable'

const props = defineProps<{
  modelValue: boolean
  /** Metric JSON pasted in an Import box — switches the prompt to "adapt" mode. */
  importedJson?: string
  importedSource?: PortableSourceSchema
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
}>()

const graphStore = useGraphStore()
const metricsStore = useMetricsStore()
const communityStore = useCommunityStore()
const customMetricsStore = useCustomMetricsStore()

// Declared (context) types unioned with whatever is on the canvas, like the
// other skill modals.
const currentSchema = computed(() =>
  buildSourceSchema({
    context: graphStore.currentContext,
    loadedNodeTypes: graphStore.nodeTypes,
    loadedEdgeTypes: graphStore.edgeTypes,
  })
)

const skillText = computed(() =>
  buildCustomMetricSkill({
    nodeTypes: currentSchema.value.node_types,
    edgeTypes: currentSchema.value.relationship_types,
    nodeProperties: graphStore.currentContext?.node_properties ?? [],
    edgeProperties: graphStore.currentContext?.edge_properties ?? [],
    availableMetricNames: [...metricsStore.nodeMetrics, ...metricsStore.edgeMetrics]
      .filter((m) => !isCustomMetricId(m.id))
      .map((m) => `${m.name} (${m.target})`),
    existingCustomMetricNames: customMetricsStore.definitions.map((d) => d.name),
    hasCommunities: communityStore.hasResults,
    importedJson: props.importedJson,
    importedSource: props.importedSource,
  })
)

const copied = ref(false)
let copyTimer: ReturnType<typeof setTimeout> | null = null

async function copy() {
  try {
    await navigator.clipboard.writeText(skillText.value)
    copied.value = true
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => {
      copied.value = false
    }, 2000)
  } catch {
    // Clipboard can fail (permissions / insecure context) — leave the button as-is
  }
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) copied.value = false
  }
)

function close() {
  emit('update:modelValue', false)
}
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
}

.modal-container {
  background: var(--vt-c-bg, #ffffff);
  border-radius: 12px;
  width: 90%;
  max-width: 720px;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--vt-c-divider, #e0e0e0);
}

.modal-header h2 {
  margin: 0;
  font-size: 1.15rem;
  font-weight: 600;
  color: var(--vt-c-text-1, #222);
}

.close-btn {
  background: none;
  border: none;
  color: var(--vt-c-text-2, #888);
  cursor: pointer;
  padding: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  transition: all 0.2s;
}

.close-btn:hover {
  background: var(--vt-c-bg-soft, #f0f0f0);
  color: var(--vt-c-text-1, #222);
}

.modal-content {
  padding: 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.intro {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.5;
  color: var(--vt-c-text-2, #555);
}

.intro code {
  font-family: 'Fira Code', 'Consolas', 'Monaco', monospace;
  font-size: 0.85em;
}

.skill-toolbar {
  display: flex;
  justify-content: flex-end;
}

.copy-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--color-primary, #42b883);
  color: #fff;
  border: none;
  padding: 7px 14px;
  border-radius: 6px;
  font-size: 0.85rem;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s;
}

.copy-btn:hover {
  background: var(--color-primary-dark, #35a372);
}

.skill-text {
  margin: 0;
  padding: 14px;
  background: var(--vt-c-bg-soft, #f6f6f6);
  border: 1px solid var(--vt-c-divider, #e0e0e0);
  border-radius: 8px;
  font-family: 'Fira Code', 'Consolas', 'Monaco', monospace;
  font-size: 0.78rem;
  line-height: 1.5;
  color: var(--vt-c-text-1, #222);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-y: auto;
  max-height: 55vh;
}
</style>
