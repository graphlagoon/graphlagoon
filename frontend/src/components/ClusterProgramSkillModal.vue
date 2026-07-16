<template>
  <Teleport to="body">
    <div v-if="modelValue" class="modal-overlay" @click.self="close">
      <div class="modal-container" data-testid="cluster-skill-modal">
        <div class="modal-header">
          <h2>Ask an AI to write a cluster program</h2>
          <button class="close-btn" @click="close" title="Close">
            <X :size="20" />
          </button>
        </div>

        <div class="modal-content">
          <p class="intro">
            Not sure how to write a cluster program? Copy the text below and paste it
            into any AI assistant (ChatGPT, Claude, etc.), then describe the grouping
            you want. It already includes this graph's node/edge types and properties
            plus the exact rules the program must follow.
          </p>

          <div class="skill-toolbar">
            <button class="copy-btn" data-testid="cluster-skill-copy" @click="copy">
              <component :is="copied ? Check : Copy" :size="14" />
              {{ copied ? 'Copied!' : 'Copy to clipboard' }}
            </button>
          </div>

          <pre class="skill-text" data-testid="cluster-skill-text">{{ skillText }}</pre>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { X, Copy, Check } from 'lucide-vue-next'
import { useGraphStore } from '@/stores/graph'
import { buildClusterProgramSkill } from '@/utils/clusterProgramSkill'

const props = defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
}>()

const graphStore = useGraphStore()

const skillText = computed(() =>
  buildClusterProgramSkill({
    nodeTypes: graphStore.nodeTypes,
    edgeTypes: graphStore.edgeTypes,
    nodeProperties: graphStore.currentContext?.node_properties ?? [],
    edgeProperties: graphStore.currentContext?.edge_properties ?? [],
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

// Reset the "Copied!" state whenever the modal is reopened
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
