<script setup lang="ts">
/**
 * A "?" next to a heading: a short explanation in a popover, with an example
 * when it helps. Click or Enter opens it; Esc, a click outside or the ? again
 * closes it.
 */
import { onBeforeUnmount, ref, watch } from 'vue';
import { HelpCircle } from 'lucide-vue-next';

const props = defineProps<{ title: string; testid?: string }>();
const open = ref(false);
const root = ref<HTMLElement | null>(null);

function onDocument(e: MouseEvent) {
  if (root.value && !root.value.contains(e.target as Node)) open.value = false;
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') open.value = false;
}
watch(open, (on) => {
  if (on) {
    document.addEventListener('mousedown', onDocument);
    document.addEventListener('keydown', onKey);
  } else {
    document.removeEventListener('mousedown', onDocument);
    document.removeEventListener('keydown', onKey);
  }
});
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocument);
  document.removeEventListener('keydown', onKey);
});
</script>

<template>
  <span ref="root" class="help-tip">
    <button
      type="button"
      class="help-btn"
      :aria-label="`Help: ${props.title}`"
      :aria-expanded="open"
      :title="`Help: ${props.title}`"
      :data-testid="props.testid ? `help-${props.testid}` : undefined"
      @click="open = !open"
    >
      <HelpCircle :size="14" />
    </button>
    <span v-if="open" class="popover" role="dialog" :aria-label="props.title" :data-testid="props.testid ? `help-${props.testid}-text` : undefined">
      <strong>{{ props.title }}</strong>
      <slot />
    </span>
  </span>
</template>

<style scoped>
.help-tip {
  position: relative;
  display: inline-flex;
  vertical-align: middle;
}

.help-btn {
  display: inline-flex;
  padding: 0 2px;
  border: 0;
  background: none;
  color: var(--text-muted);
  cursor: pointer;
}

.help-btn:hover,
.help-btn[aria-expanded='true'] {
  color: var(--color-primary);
}

.popover {
  position: absolute;
  z-index: 30;
  top: 20px;
  left: -8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 340px;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--color-surface, #fff);
  box-shadow: 0 8px 24px rgb(0 0 0 / 15%);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.45;
  color: var(--text-primary);
  white-space: normal;
}

.popover :deep(code) {
  font-size: 11px;
}

.popover :deep(ul) {
  margin: 0;
  padding-left: 16px;
}
</style>
