<script setup lang="ts">
/**
 * "Ask an AI to write the enrichment tables": the prompt built from the context form
 * (its tables, columns, types and current entries). The answer goes into Import YAML.
 */
import { ref } from 'vue';
import { X, Copy, Check } from 'lucide-vue-next';

const props = defineProps<{ text: string }>();
const emit = defineEmits<{ close: [] }>();
const copied = ref(false);

async function copy() {
  try {
    await navigator.clipboard.writeText(props.text);
    copied.value = true;
    setTimeout(() => (copied.value = false), 2000);
  } catch {
    // Clipboard can fail (permissions / insecure context): the text stays selectable below.
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="modal-overlay" @click.self="emit('close')">
      <div class="modal-container" data-testid="enrichment-skill-modal">
        <div class="modal-header">
          <h2>Ask an AI to write the enrichment tables</h2>
          <button class="close-btn" title="Close" @click="emit('close')"><X :size="20" /></button>
        </div>
        <div class="modal-content">
          <p class="intro">
            Copy this into any AI assistant your organization allows (ChatGPT, Claude…) and describe, at the end, what
            you want on the edges or the nodes. It already holds this context's tables, columns, properties, types and
            current entries, plus the rules the server enforces. Paste the YAML it answers into <strong>Import YAML</strong>.
            It carries table and column names, no data.
          </p>
          <div class="skill-toolbar">
            <button class="copy-btn" data-testid="enrichment-skill-copy" @click="copy">
              <component :is="copied ? Check : Copy" :size="14" />
              {{ copied ? 'Copied!' : 'Copy to clipboard' }}
            </button>
          </div>
          <pre class="skill-text" data-testid="enrichment-skill-text">{{ text }}</pre>
        </div>
      </div>
    </div>
  </Teleport>
</template>

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
