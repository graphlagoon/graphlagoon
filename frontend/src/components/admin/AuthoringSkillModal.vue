<script setup lang="ts">
/**
 * "Ask an AI" for the admin area (06): shows a prompt built from the server's
 * authoring catalog, to copy into any AI assistant. The answer is pasted back
 * into the editor (Import JSON, or the body of a library doc).
 */
import { ref, watch } from 'vue';
import { Check, Copy, X } from 'lucide-vue-next';

const props = defineProps<{ modelValue: boolean; title: string; text: string; testid: string }>();
const emit = defineEmits<{ 'update:modelValue': [open: boolean] }>();

const copied = ref(false);
let timer: ReturnType<typeof setTimeout> | null = null;
async function copy() {
  try {
    await navigator.clipboard.writeText(props.text);
    copied.value = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => (copied.value = false), 2000);
  } catch {
    /* clipboard blocked (permissions, insecure context): the text can still be selected */
  }
}
watch(
  () => props.modelValue,
  (open) => {
    if (open) copied.value = false;
  },
);
const close = () => emit('update:modelValue', false);
</script>

<template>
  <Teleport to="body">
    <div v-if="modelValue" class="modal-overlay" @click.self="close" @keydown.esc="close">
      <div class="modal-container" role="dialog" :aria-label="title" :data-testid="testid">
        <div class="modal-header">
          <h2>{{ title }}</h2>
          <button type="button" class="close-btn" title="Close" aria-label="Close" @click="close"><X :size="20" /></button>
        </div>
        <div class="modal-content">
          <p class="intro"><slot /></p>
          <div class="toolbar">
            <button type="button" class="copy-btn" :data-testid="`${testid}-copy`" @click="copy">
              <component :is="copied ? Check : Copy" :size="14" />
              {{ copied ? 'Copied!' : 'Copy to clipboard' }}
            </button>
            <span class="muted">{{ text.length.toLocaleString() }} characters</span>
          </div>
          <pre class="skill-text" :data-testid="`${testid}-text`">{{ text }}</pre>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgb(0 0 0 / 60%);
}

.modal-container {
  display: flex;
  flex-direction: column;
  width: 90%;
  max-width: 760px;
  max-height: 85vh;
  overflow: hidden;
  border-radius: 12px;
  background: var(--color-surface, #fff);
  box-shadow: 0 20px 60px rgb(0 0 0 / 40%);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border-color);
}

.modal-header h2 {
  margin: 0;
  font-size: 16px;
}

.close-btn {
  border: 0;
  background: none;
  cursor: pointer;
  color: var(--text-muted);
}

.modal-content {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 18px;
  overflow: hidden;
}

.intro {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
}

.copy-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border: 1px solid var(--color-primary);
  border-radius: 6px;
  background: var(--color-primary);
  color: #fff;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.muted {
  font-size: 12px;
  color: var(--text-muted);
}

.skill-text {
  flex: 1;
  min-height: 200px;
  margin: 0;
  padding: 10px;
  overflow: auto;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--color-surface-sunken, #f8f9fa);
  font-size: 11px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
